import {
  CopilotClient,
  type CopilotClientOptions,
  type PermissionHandler,
  type ResumeSessionConfig,
  type SessionConfig,
  type SessionEvent,
} from '@github/copilot-sdk';

// This module never imports the runtime contract (provider-contracts/copilot.ts):
// registration is two-step, and the contract attaches itself.
import { registerProvider } from './provider-registry.js';
import type {
  AgentProvider,
  AgentQuery,
  McpServerConfig,
  ProviderEvent,
  ProviderOptions,
  QueryInput,
} from './types.js';
import {
  copilotClientOptions,
  copilotSessionConfig,
  resolveCopilotInference,
  resolveCopilotMcpServers,
} from './copilot-config.js';
import { copilotMemoryContext, type CopilotMemorySessionHook } from './copilot-memory.js';

/** No turn may hold the poll loop longer than this; a stuck runtime ends the turn with an error. */
const TURN_TIMEOUT_MS = 10 * 60 * 1000;

/** The SDK's answer when a stored session is gone: the continuation must be dropped. */
export const STALE_SESSION_RE = /Session not found|Failed to load session events/i;

/** The slice of the SDK session this provider drives (the native test and fakes implement it). */
export interface CopilotSessionLike {
  readonly sessionId: string;
  on(handler: (event: SessionEvent) => void): () => void;
  send(options: { prompt: string }): Promise<string>;
  abort(): Promise<void>;
  disconnect(): Promise<void>;
}

export interface CopilotClientLike {
  start(): Promise<void>;
  stop(): Promise<Error[]>;
  createSession(config: SessionConfig): Promise<CopilotSessionLike>;
  resumeSession(sessionId: string, config: ResumeSessionConfig): Promise<CopilotSessionLike>;
}

export interface CopilotRuntimeDeps {
  createClient(options: CopilotClientOptions): CopilotClientLike;
  /**
   * Session settings laid over the provider's own. Empty in production. The
   * native test points the session at a local model fixture through it (the
   * SDK's BYOK `provider`), since core constructs the provider itself.
   */
  sessionOverrides: Partial<SessionConfig>;
}

/** The production deps, one mutable object so a test can swap them for a provider core constructs. */
export const defaultCopilotRuntimeDeps: CopilotRuntimeDeps = {
  createClient: (options) => new CopilotClient(options),
  sessionOverrides: {},
};

/** Structural mirror of core's ResolvedRuntimeConfiguration (provider-contracts/registry.ts). */
export interface CopilotResolvedConfiguration {
  executionPolicy?: unknown;
  inference?: unknown;
  mcpServers?: unknown;
}

export function classifyCopilotError(message: string, errorType?: string): string | undefined {
  const text = `${errorType ?? ''} ${message}`;
  // Most specific first: a context-window message mentions tokens without being about credentials.
  if (STALE_SESSION_RE.test(text)) return 'stale-session';
  if (/context.?limit|too long|context window|maximum context/i.test(text)) return 'context';
  if (/quota|rate.?limit|billing|premium request|entitlement|\b402\b|\b429\b/i.test(text)) return 'quota';
  if (
    /authenticat|authoriz|forbidden|bad credentials|credential|(invalid|expired|revoked).{0,12}token|token.{0,12}(invalid|expired|revoked)|\b401\b|\b403\b/i.test(
      text,
    )
  )
    return 'auth';
  return undefined;
}

/** What a person reads when a turn fails: the cause's class, never raw diagnostics. */
function failureNotice(classification: string | undefined): string {
  if (classification === 'auth')
    return 'GitHub Copilot rejected the credentials. Re-run the Copilot provider setup on the host, then retry.';
  if (classification === 'quota') return 'GitHub Copilot refused the request: the plan’s usage limit was reached.';
  if (classification === 'context') return 'The conversation is too long for the selected Copilot model.';
  return 'GitHub Copilot could not complete this turn.';
}

/** Tool permissions: the container is the boundary. A request managed policy reserves for a person is declined. */
export const copilotPermissionHandler: PermissionHandler = (request) =>
  request.managedApprovalRequired ? { kind: 'user-not-available' } : { kind: 'approve-once' };

export class CopilotProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  private readonly options: ProviderOptions;
  private readonly runtime: CopilotRuntimeDeps;
  private readonly inference: ReturnType<typeof resolveCopilotInference>;
  private readonly mcpServers: ReturnType<typeof resolveCopilotMcpServers>;
  private memorySessionHook?: CopilotMemorySessionHook;

  /**
   * `configuration` is present on a contract core: core already ran the
   * contract's inference and MCP resolves, so their results are used as-is.
   */
  constructor(
    options: ProviderOptions = {},
    runtime: CopilotRuntimeDeps = defaultCopilotRuntimeDeps,
    configuration?: CopilotResolvedConfiguration,
  ) {
    this.options = options;
    this.runtime = runtime;
    if (configuration?.inference && configuration.mcpServers) {
      this.inference = configuration.inference as ReturnType<typeof resolveCopilotInference>;
      this.mcpServers = configuration.mcpServers as ReturnType<typeof resolveCopilotMcpServers>;
    } else {
      this.inference = resolveCopilotInference({ model: options.model, effort: options.effort });
      this.mcpServers = resolveCopilotMcpServers(options.mcpServers ?? ({} as Record<string, McpServerConfig>));
    }
  }

  registerMemorySessionHook(hook: CopilotMemorySessionHook): void {
    this.memorySessionHook = hook;
  }

  isSessionInvalid(err: unknown): boolean {
    return STALE_SESSION_RE.test(err instanceof Error ? err.message : String(err));
  }

  query(input: QueryInput): AgentQuery {
    if (!this.memorySessionHook) throw new Error('Copilot memory session hook was not registered');
    const memorySessionHook = this.memorySessionHook;
    const runtime = this.runtime;
    const pending: string[] = [input.prompt];
    let waiting: (() => void) | null = null;
    let ended = false;
    let aborted = false;
    let activeSession: CopilotSessionLike | null = null;

    let wakeTurn: (() => void) | null = null;
    const wake = (): void => {
      waiting?.();
      waiting = null;
    };

    // Set when the runtime compacts the context: the next prompt carries memory again.
    let memoryAfterCompaction = false;
    const config: SessionConfig = {
      ...copilotSessionConfig({
        cwd: input.cwd,
        instructions: input.systemContext?.instructions,
        additionalDirectories: this.options.additionalDirectories,
        inference: this.inference,
        mcpServers: this.mcpServers,
      }),
      onPermissionRequest: copilotPermissionHandler,
      hooks: {
        // Every start loads memory, resume included: the runtime does not
        // persist hook context in the session, so a resumed session (always a
        // fresh runtime here) would otherwise have none.
        onSessionStart: async () => {
          const additionalContext = await copilotMemoryContext(memorySessionHook, 'startup');
          return additionalContext ? { additionalContext } : undefined;
        },
        onUserPromptSubmitted: async () => {
          if (!memoryAfterCompaction) return;
          memoryAfterCompaction = false;
          const additionalContext = await copilotMemoryContext(memorySessionHook, 'compact');
          return additionalContext ? { additionalContext } : undefined;
        },
      },
      ...runtime.sessionOverrides,
    };
    const env = this.options.env ?? process.env;

    async function* gen(): AsyncGenerator<ProviderEvent> {
      const client = runtime.createClient(copilotClientOptions(env));
      let session: CopilotSessionLike | null = null;
      try {
        await client.start();
        if (aborted) return;
        session = input.continuation
          ? await client.resumeSession(input.continuation, config)
          : await client.createSession(config);
        activeSession = session;
        yield { type: 'activity' };
        yield { type: 'init', continuation: session.sessionId };

        while (!aborted) {
          while (pending.length === 0 && !ended && !aborted) {
            await new Promise<void>((resolve) => {
              waiting = resolve;
            });
          }
          if (aborted || (pending.length === 0 && ended)) return;
          // One prompt per turn, in order: the poll loop counts one result per input.
          yield* runOneTurn(
            session,
            pending.shift()!,
            () => aborted,
            (waker) => (wakeTurn = waker),
            () => {
              memoryAfterCompaction = true;
            },
          );
        }
      } finally {
        activeSession = null;
        try {
          await session?.disconnect();
        } catch (err) {
          console.error(`[copilot-provider] disconnect failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        for (const error of await client.stop().catch((err: unknown) => [err as Error])) {
          console.error(
            `[copilot-provider] runtime shutdown: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }

    return {
      push: (message: string) => {
        pending.push(message);
        wake();
      },
      end: () => {
        ended = true;
        wake();
      },
      abort: () => {
        aborted = true;
        void activeSession?.abort().catch(() => {});
        wakeTurn?.();
        wake();
      },
      events: gen(),
    };
  }
}

/**
 * One prompt, start to finish. Every runtime event is liveness. Each completed
 * top-level assistant message is a `text` segment (the contract's mid-turn
 * delivery); the turn ends when the session goes idle (`result`, the last
 * message's text) or fails (`error`, then a failed `result` with a notice).
 */
async function* runOneTurn(
  session: CopilotSessionLike,
  prompt: string,
  isAborted: () => boolean,
  setWaker: (waker: (() => void) | null) => void,
  onCompaction: () => void,
): AsyncGenerator<ProviderEvent> {
  const buffer: ProviderEvent[] = [];
  let lastText = '';
  let done = false;
  // The runtime echoes the prompt as a user message first. Until it does, an
  // idle belongs to the previous turn (one that ended on an error) and is ignored.
  let started = false;
  let waker: (() => void) | null = null;
  const kick = (): void => {
    waker?.();
    waker = null;
  };
  setWaker(kick);
  const finish = (events: ProviderEvent[]): void => {
    if (done) return;
    buffer.push(...events);
    done = true;
  };

  const unsubscribe = session.on((event) => {
    if (done) return;
    buffer.push({ type: 'activity' });
    // Sub-agent events are the sub-agent's own work; only the root agent speaks for the turn.
    const root = !('agentId' in event) || !event.agentId;
    switch (event.type) {
      case 'user.message':
        started = true;
        break;
      case 'assistant.message':
        if (root && event.data.content) {
          lastText = event.data.content;
          buffer.push({ type: 'text', text: event.data.content });
        }
        break;
      case 'session.compaction_complete':
        onCompaction();
        buffer.push({ type: 'progress', message: 'context compacted' });
        break;
      case 'session.error': {
        const classification = classifyCopilotError(event.data.message, event.data.errorType);
        finish([
          { type: 'error', message: event.data.message, retryable: false, classification },
          { type: 'result', text: lastText || null, isError: true, error: failureNotice(classification) },
        ]);
        break;
      }
      case 'session.idle':
        if (root && started) finish([{ type: 'result', text: lastText || null }]);
        break;
      default:
        break;
    }
    kick();
  });

  const timer = setTimeout(() => {
    finish([
      { type: 'error', message: `Turn timed out after ${TURN_TIMEOUT_MS}ms`, retryable: false },
      { type: 'result', text: lastText || null, isError: true, error: failureNotice(undefined) },
    ]);
    void session.abort().catch(() => {});
    kick();
  }, TURN_TIMEOUT_MS);

  try {
    await session.send({ prompt });
    while (true) {
      while (buffer.length > 0) yield buffer.shift()!;
      if (done || isAborted()) break;
      await new Promise<void>((resolve) => {
        waker = resolve;
      });
      waker = null;
    }
    while (buffer.length > 0) yield buffer.shift()!;
  } finally {
    clearTimeout(timer);
    setWaker(null);
    unsubscribe();
  }
}

// Function-form registration: a contract core passes the resolved configuration as the second argument.
registerProvider(
  'copilot',
  (opts, configuration?: CopilotResolvedConfiguration) =>
    new CopilotProvider(opts, defaultCopilotRuntimeDeps, configuration),
);
