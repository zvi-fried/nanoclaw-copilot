import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
  mock,
  setDefaultTimeout,
  spyOn,
} from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The runtime half of the customer quickstart for GitHub Copilot (the
 * add-copilot testing guide, §5 and §7): a message turn as a group switched to
 * Copilot runs it, through the runner's real poll loop and the provider as
 * core builds it. Only the edges are fakes:
 *
 * - the Copilot SDK (`@github/copilot-sdk`): a scripted `CopilotClient`
 *   whose sessions emit the SDK's own event shapes. Each turn makes one model
 *   request with the token the client was given, to the API in its environment;
 * - the credential gateway: Iron Proxy's replace rule as setup stores it
 *   (the plan's API host, the Authorization header, the placeholder);
 * - GitHub's Copilot API behind it, which records what reached it.
 *
 * The setup half (install, plan lookup, token storage, `ncl groups config
 * update --provider copilot`) is .claude/skills/add-copilot/scripts/quickstart.test.ts.
 * The real runtime against a scripted model is copilot.native.test.ts, and
 * against a real Iron Proxy e2e/gateway-injection.sh.
 */

// Each test runs the poll loop through one or two messages, a few seconds apiece.
setDefaultTimeout(30_000);

const PLACEHOLDER = 'nc-copilot-token-v1';
const TOKEN = 'github_pat_quickstart_0123456789abcdef';
const API = 'https://api.business.githubcopilot.com';

// ── The edges ───────────────────────────────────────────────────────────────

/** GitHub's Copilot API: what reached it, and the reply it gives. */
const upstream: Array<{ host: string; authorization: string }> = [];
/** The model requests as the runtime made them, before the gateway. */
const outbound: Array<{ host: string; authorization: string }> = [];

/** The connection setup stores (scripts/copilot-auth.ts copilotCredentialTarget), with Iron's replace semantics. */
const gateway = {
  host: new URL(API).hostname,
  header: 'authorization',
  proxyValue: PLACEHOLDER,
  secret: TOKEN,
  forward(url: string, headers: Record<string, string>) {
    const host = new URL(url).hostname;
    outbound.push({ host, authorization: headers.authorization });
    const swapped = { ...headers };
    if (host === this.host && swapped[this.header]?.includes(this.proxyValue))
      swapped[this.header] = swapped[this.header].replace(this.proxyValue, this.secret);
    upstream.push({ host, authorization: swapped.authorization });
    return swapped.authorization === `Bearer ${TOKEN}`;
  },
};

type Emit = (event: object) => void;
/** What the model does with a prompt: emit SDK session events. `authorized` is the upstream's verdict. */
type Script = (prompt: string, emit: Emit, authorized: boolean) => void;

/** An assistant message as the agent writes one to the CLI channel (NanoClaw's composed instructions ask for the block). */
const say = (text: string) => ({ type: 'assistant.message', data: { content: `<message to="cli">${text}</message>` } });

/** The turn every test gets unless it scripts its own: a reply, or the runtime's 401 error when the token was refused. */
const defaultScript: Script = (prompt, emit, authorized) => {
  if (!authorized) {
    emit({
      type: 'session.error',
      data: { message: 'HTTP 401 Unauthorized: Bad credentials', errorType: 'authentication' },
    });
    emit({ type: 'session.idle', data: {} });
    return;
  }
  emit(say(`COPILOT-OK: ${prompt.length}`));
  emit({ type: 'session.idle', data: {} });
};

const sdk = {
  clients: [] as Array<{
    options: any;
    created: any[];
    resumed: Array<{ id: string; config: any }>;
    prompts: string[];
  }>,
  script: defaultScript,
  /** Events the runtime emits as a session opens, before the first prompt. */
  onSessionStart: (_config: unknown): object[] => [],
  resumeError: undefined as Error | undefined,
  stopErrors: [] as Error[],
  sessions: 0,
};

/** The SDK's client, scripted. Its sessions emit the SDK's event shapes. */
class FakeCopilotClient {
  private readonly record;
  constructor(private readonly options: any) {
    this.record = {
      options,
      created: [] as any[],
      resumed: [] as Array<{ id: string; config: any }>,
      prompts: [] as string[],
    };
    sdk.clients.push(this.record);
  }
  async start() {}
  async stop() {
    return sdk.stopErrors;
  }
  async createSession(config: any) {
    this.record.created.push(config);
    return this.session(`copilot-session-${++sdk.sessions}`, config);
  }
  async resumeSession(id: string, config: any) {
    if (sdk.resumeError) throw sdk.resumeError;
    this.record.resumed.push({ id, config });
    return this.session(id, config);
  }
  private session(sessionId: string, config: any) {
    const handlers = new Set<(event: object) => void>();
    const emit: Emit = (event) => queueMicrotask(() => handlers.forEach((handler) => handler(event)));
    const record = this.record;
    const options = this.options;
    // What the runtime announces about MCP before the first prompt (see the policy case below).
    for (const event of sdk.onSessionStart(config)) emit(event);
    return {
      sessionId,
      on(handler: (event: object) => void) {
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
      async send({ prompt }: { prompt: string }) {
        record.prompts.push(prompt);
        emit({ type: 'user.message', data: { content: prompt } });
        // One model request per turn, with what the runtime holds, to the API it was given.
        const authorized = gateway.forward(`${options.env.COPILOT_API_URL}/chat/completions`, {
          authorization: `Bearer ${options.gitHubToken}`,
        });
        sdk.script(prompt, emit, authorized);
        return `message-${record.prompts.length}`;
      },
      async abort() {},
      async disconnect() {},
    };
  }
}
mock.module('@github/copilot-sdk', () => ({ CopilotClient: FakeCopilotClient }));

// Core's runner modules, loaded after the SDK mock as the container loads them.
const { getUndeliveredMessages } = await import('../db/messages-out.js');
const { setContinuation } = await import('../db/session-state.js');
const { closeSessionDb, getInboundDb, initTestSessionDb } = await import('../mailbox/sqlite/connection.js');
const { runPollLoop } = await import('../poll-loop.js');
const { registerProviderMemorySessionHook } = await import('../provider-contracts/realize.js');
await import('./index.js');
await import('../provider-contracts/index.js');
const { createProvider } = await import('./factory.js');
const { getProviderRuntimeContract } = await import('./provider-registry.js');

// ── The container a group switched to Copilot starts ────────────────────────

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-quickstart-'));
const cwd = path.join(root, 'agent');
/** The nanoclaw MCP server exactly as the runner's entry point (src/index.ts) configures it. */
const MCP_SERVER_PATH = path.join(import.meta.dir, '..', 'mcp-tools', 'index.ts');

beforeAll(() => {
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), '# Group\nCOMPOSED-PROJECT-DOC\n');
});
afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  initTestSessionDb();
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('cli', 'CLI', 'channel', 'cli', 'cli-1', NULL)`,
    )
    .run();
  upstream.length = 0;
  outbound.length = 0;
  sdk.clients.length = 0;
  sdk.resumeError = undefined;
  sdk.stopErrors = [];
  sdk.script = defaultScript;
  sdk.onSessionStart = () => [];
  gateway.secret = TOKEN;
});
afterEach(() => {
  closeSessionDb();
});

/** The container's environment: the host's provider config (COPILOT_API_URL), and stray tokens a host might leak. */
const containerEnv = () => ({
  ...process.env,
  COPILOT_API_URL: API,
  GITHUB_TOKEN: 'ghs_ambient_should_not_reach_the_runtime',
  GH_TOKEN: 'gho_ambient_should_not_reach_the_runtime',
});

/** One container run: the poll loop over `prompts`, each sent as a CLI message; returns the replies in order. */
async function containerRun(prompts: string[], options: { mcpServers?: Record<string, unknown> } = {}) {
  const provider = createProvider('copilot', {
    mcpServers: (options.mcpServers ?? {
      nanoclaw: { command: 'bun', args: ['run', MCP_SERVER_PATH], env: {} },
    }) as never,
    env: containerEnv(),
  });
  registerProviderMemorySessionHook('copilot', provider, {
    command: `printf 'MEMORY-MARKER'`,
    legacyCommands: [],
    sources: ['startup', 'compact'],
  });
  const controller = new AbortController();
  const loop = runPollLoop({
    provider,
    providerContract: getProviderRuntimeContract('copilot'),
    providerName: 'copilot',
    cwd,
    systemContext: { instructions: 'SYSTEM-ADDENDUM' },
    signal: controller.signal,
  }).catch(() => {});
  const replies: string[] = [];
  const before = getUndeliveredMessages().length;
  try {
    for (const [index, prompt] of prompts.entries()) {
      getInboundDb()
        .prepare(
          `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
           VALUES (?, 'chat', datetime('now'), 'pending', 'cli-1', 'cli', NULL, ?)`,
        )
        .run(`m-${Date.now()}-${index}`, JSON.stringify({ sender: 'Tester', text: prompt }));
      const deadline = Date.now() + 10_000;
      while (getUndeliveredMessages().length <= before + index) {
        if (Date.now() > deadline) throw new Error(`no reply to ${prompt}; got ${JSON.stringify(replies)}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      replies.push(JSON.parse(getUndeliveredMessages()[before + index].content).text);
    }
  } finally {
    controller.abort();
    await loop;
  }
  return replies;
}

// ── §5a–5c ──────────────────────────────────────────────────────────────────

describe('quickstart §5: a message turn on a Copilot group', () => {
  it('answers through the gateway: the runtime holds only the placeholder, GitHub sees the token', async () => {
    const replies = await containerRun(['Reply with exactly: COPILOT-OK.', 'What word did I ask you to remember?']);
    expect(replies).toHaveLength(2);
    for (const reply of replies) expect(reply).toStartWith('COPILOT-OK');

    // The container side: the placeholder, no logged-in user, no ambient token in the runtime's environment.
    const [client] = sdk.clients;
    expect(client.options).toMatchObject({ gitHubToken: PLACEHOLDER, useLoggedInUser: false, mode: 'empty' });
    for (const name of ['GITHUB_TOKEN', 'GH_TOKEN', 'COPILOT_GITHUB_TOKEN'])
      expect(client.options.env[name]).toBeUndefined();
    expect(client.options.env.COPILOT_API_URL).toBe(API);
    const seenByRuntime = JSON.stringify([sdk.clients.map((c) => c.options), sdk.clients.map((c) => c.created)]);
    expect(seenByRuntime).not.toContain(TOKEN);
    expect(seenByRuntime).not.toContain('should_not_reach_the_runtime');

    // On the wire: the runtime sent the placeholder; the gateway swapped in the token on the plan's host.
    expect(outbound).toEqual(
      replies.map(() => ({ host: 'api.business.githubcopilot.com', authorization: `Bearer ${PLACEHOLDER}` })),
    );
    expect(upstream).toEqual(
      replies.map(() => ({ host: 'api.business.githubcopilot.com', authorization: `Bearer ${TOKEN}` })),
    );

    // §5a session continuity: both messages went to one Copilot session.
    expect(sdk.clients.flatMap((c) => c.created)).toHaveLength(1);
    expect(sdk.clients.flatMap((c) => c.prompts)).toHaveLength(2);
  });

  it("hands the SDK NanoClaw's MCP servers (send_message's nanoclaw server first), never GitHub's own", async () => {
    await containerRun(['Call your send_message tool to send the text MCP-OK.'], {
      mcpServers: {
        nanoclaw: { command: 'bun', args: ['run', MCP_SERVER_PATH], env: {} },
        docs: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { 'x-team': 'qa' } },
      },
    });
    const [config] = sdk.clients[0].created;
    expect(config.mcpServers).toEqual({
      nanoclaw: { type: 'stdio', command: 'bun', args: ['run', MCP_SERVER_PATH], env: {}, tools: ['*'] },
      docs: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { 'x-team': 'qa' }, tools: ['*'] },
    });
    // The nanoclaw server is the runner's MCP tool server, where send_message lives.
    expect(fs.readFileSync(path.join(path.dirname(MCP_SERVER_PATH), 'core.ts'), 'utf8')).toContain("'send_message'");
    expect(config.disabledMcpServers).toEqual(['github-mcp-server']);
    expect(config.availableTools).toEqual(['builtin:*', 'mcp:*']);
    expect(config.excludedTools).toEqual(['builtin:ask_user']);
    // §5b: built-in tools (the shell among them) stay available; tool permissions are approved in the container.
    expect(config.onPermissionRequest({ kind: 'shell' })).toEqual({ kind: 'approve-once' });
    // The composed CLAUDE.md and core's addendum are the system message.
    expect(config.systemMessage).toEqual({
      mode: 'append',
      content: '# Group\nCOMPOSED-PROJECT-DOC\n\nSYSTEM-ADDENDUM',
    });
  });

  /**
   * KNOWN RISK (quickstart §5c): under Copilot auth the runtime withholds MCP
   * servers other than its own until it has fetched GitHub's MCP policy. The
   * withholding happens inside the runtime and cannot be reproduced here; what
   * the SDK exposes of it is simulated: `session.mcp_servers_loaded` reporting
   * the nanoclaw server `stopped` ("quarantined by restrictive managed
   * policy"), and a later `session.mcp_server_status_changed` to `connected`.
   *
   * This pins the provider's current behaviour, which is none of waiting,
   * retrying or warning: the turn runs at once without the tools, the events
   * count only as liveness, nothing is logged, and the next turn (same session)
   * has them if the policy loaded in between. A live run must still confirm
   * what a real plan does (§5c).
   */
  it('KNOWN GAP: does not wait, retry or warn when the runtime withholds the nanoclaw MCP server', async () => {
    let policyLoaded = false;
    sdk.onSessionStart = () => [
      {
        type: 'session.mcp_servers_loaded',
        ephemeral: true,
        data: { servers: [{ name: 'nanoclaw', status: 'stopped' }] },
      },
    ];
    sdk.script = (_prompt, emit) => {
      emit(say(policyLoaded ? 'MCP-OK sent; done' : 'NO-MCP: bash, view, edit'));
      if (!policyLoaded) {
        policyLoaded = true;
        emit({
          type: 'session.mcp_server_status_changed',
          ephemeral: true,
          data: { serverName: 'nanoclaw', status: 'connected' },
        });
      }
      emit({ type: 'session.idle', data: {} });
    };
    const logged = spyOn(console, 'error');
    const warned = spyOn(console, 'warn');
    try {
      const replies = await containerRun(['Call send_message', 'Call send_message again']);
      expect(replies).toEqual(['NO-MCP: bash, view, edit', 'MCP-OK sent; done']);
      // One prompt per message: no retry of the first turn.
      expect(sdk.clients.flatMap((c) => c.prompts)).toHaveLength(2);
      // No warning about the withheld server, from the provider or the runner.
      const lines = [...logged.mock.calls, ...warned.mock.calls].map((call) => call.join(' '));
      expect(
        lines.filter((line) => line.startsWith('[copilot-provider]') || /mcp_server|stopped|withh/i.test(line)),
      ).toEqual([]);
    } finally {
      logged.mockRestore();
      warned.mockRestore();
      sdk.onSessionStart = () => [];
      sdk.script = defaultScript;
    }
  });
});

// ── §7 Troubleshooting, runtime side ────────────────────────────────────────

describe('quickstart §7: each failure reply, as the guide words it', () => {
  afterEach(() => {
    sdk.script = defaultScript;
  });

  it('a token the gateway does not hold (expired or revoked) gets the credentials reply', async () => {
    gateway.secret = 'github_pat_revoked';
    expect(await containerRun(['hi'])).toEqual([
      'GitHub Copilot rejected the credentials. Re-run the Copilot provider setup on the host, then retry.',
    ]);
  });

  it.each([
    [
      'You have exceeded your premium request allowance (HTTP 429)',
      'GitHub Copilot refused the request: the plan’s usage limit was reached.',
    ],
    [
      'prompt token count of 200000 exceeds the context window',
      'The conversation is too long for the selected Copilot model.',
    ],
    ['socket hang up', 'GitHub Copilot could not complete this turn.'],
  ])('a runtime error "%s" gets "%s"', async (error, reply) => {
    sdk.script = (_prompt, emit) => {
      emit({ type: 'session.error', data: { message: error } });
      emit({ type: 'session.idle', data: {} });
    };
    expect(await containerRun(['hi'])).toEqual([reply]);
  });

  it('a turn over 10 minutes (the hard timeout) gets the could-not-complete reply', async () => {
    sdk.script = (_prompt, emit) => emit(say('Still working…')); // never goes idle
    const provider = createProvider('copilot', { mcpServers: {}, env: containerEnv() });
    registerProviderMemorySessionHook('copilot', provider, {
      command: 'true',
      legacyCommands: [],
      sources: ['startup'],
    });
    jest.useFakeTimers();
    try {
      const query = provider.query({ prompt: 'a long job', cwd });
      const events: Array<{ type: string; [key: string]: unknown }> = [];
      const drained = (async () => {
        for await (const event of query.events) {
          events.push(event);
          if (event.type === 'result') query.end();
        }
      })();
      const settle = async () => {
        for (let i = 0; i < 200; i++) await Promise.resolve();
      };
      await settle();
      expect(events.some((event) => event.type === 'text')).toBe(true);
      jest.advanceTimersByTime(10 * 60 * 1000 - 1);
      await settle();
      expect(events.some((event) => event.type === 'result')).toBe(false);
      jest.advanceTimersByTime(1);
      await drained;
      expect(events.at(-1)).toMatchObject({
        type: 'result',
        isError: true,
        error: 'GitHub Copilot could not complete this turn.',
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('a stale session (Session not found) is dropped and the next message starts a fresh one', async () => {
    setContinuation('copilot', 'copilot-session-gone');
    sdk.resumeError = new Error(
      'Request session.resume failed with message: Failed to load session events: Session not found: copilot-session-gone',
    );
    const resumes: string[] = [];
    const resume = FakeCopilotClient.prototype.resumeSession;
    FakeCopilotClient.prototype.resumeSession = function (id: string, config: unknown) {
      resumes.push(id);
      return resume.call(this, id, config);
    };
    try {
      // The message that hits the stale session gets the runner's generic notice; the next one starts fresh.
      expect(await containerRun(['first', 'second'])).toEqual([
        'The agent run failed. Check the logs for details.',
        expect.stringMatching(/^COPILOT-OK/),
      ]);
    } finally {
      FakeCopilotClient.prototype.resumeSession = resume;
    }
    expect(resumes).toEqual(['copilot-session-gone']);
    expect(sdk.clients.map((client) => client.created.length)).toEqual([0, 1]);
  });

  it('writes [copilot-provider] lines when the runtime fails to shut down', async () => {
    sdk.stopErrors = [new Error('runtime exited with code 1')];
    const logged = spyOn(console, 'error');
    try {
      await containerRun(['hi']);
      expect(logged.mock.calls.map((call) => call.join(' '))).toContain(
        '[copilot-provider] runtime shutdown: runtime exited with code 1',
      );
    } finally {
      logged.mockRestore();
    }
  });
});
