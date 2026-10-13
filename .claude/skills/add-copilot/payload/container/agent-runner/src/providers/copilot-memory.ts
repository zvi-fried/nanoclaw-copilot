/**
 * Shared memory for Copilot sessions. Core registers one memory session hook
 * (a command that renders the memory index and definition); this module runs
 * it when Copilot establishes a new context window and hands the output to
 * the session as additional context:
 *
 * - `startup`: the SDK's sessionStart hook, on a new or a resumed session;
 * - `compact`: the first prompt after the runtime compacted the context.
 *
 * Unlike other providers, a resumed session gets memory again: the Copilot
 * runtime does not persist hook context in the session it stores.
 */
import { spawn } from 'child_process';

export interface CopilotMemorySessionHook {
  readonly command: string;
  readonly legacyCommands: readonly string[];
  readonly sources: readonly string[];
}

export type CopilotMemorySource = 'startup' | 'compact';

/** Matches the 10-second timeout the Claude provider registers for the same command. */
const MEMORY_HOOK_TIMEOUT_MS = 10_000;

function log(message: string): void {
  console.error(`[copilot-memory] ${message}`);
}

/**
 * Run one hook command with its payload on stdin and resolve with its exit
 * status and stdout. Asynchronous on purpose: under Bun, spawnSync can miss a
 * child's exit (oven-sh/bun#34069). A hook past its deadline is abandoned so it
 * can never hold a turn.
 */
export function runHookCommand(
  command: string,
  input: string,
  timeoutMs = MEMORY_HOOK_TIMEOUT_MS,
): Promise<{ status: number | null; stdout: string; error?: Error }> {
  return new Promise((resolve) => {
    const stdout: Buffer[] = [];
    let settled = false;
    const settle = (result: { status: number | null; error?: Error }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve({ ...result, stdout: Buffer.concat(stdout).toString('utf-8') });
    };
    const child = spawn(command, { shell: true, stdio: ['pipe', 'pipe', 'ignore'] });
    const deadline = setTimeout(() => {
      child.kill('SIGTERM');
      child.stdin.destroy();
      child.stdout.destroy();
      child.unref();
      settle({ status: null, error: new Error(`timed out after ${timeoutMs}ms`) });
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.on('error', (error) => settle({ status: null, error }));
    child.on('close', (status, signal) =>
      settle(signal ? { status, error: new Error(`killed by ${signal}`) } : { status }),
    );
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

/** The rendered memory for `source`, or undefined when there is none to give. Failures never fail a turn. */
export async function copilotMemoryContext(
  hook: CopilotMemorySessionHook | undefined,
  source: CopilotMemorySource,
  run: typeof runHookCommand = runHookCommand,
): Promise<string | undefined> {
  if (!hook) {
    log(`No memory session hook registered; skipping ${source} memory`);
    return undefined;
  }
  if (!hook.sources.includes(source)) return undefined;
  const result = await run(hook.command, JSON.stringify({ hook_event_name: 'SessionStart', source }));
  if (result.error || result.status !== 0) {
    log(`Memory session hook (${source}) failed (${result.error?.message ?? `exit ${String(result.status)}`})`);
    return undefined;
  }
  return result.stdout.trim() || undefined;
}
