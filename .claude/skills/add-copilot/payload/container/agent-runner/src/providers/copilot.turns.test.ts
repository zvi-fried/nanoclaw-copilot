import { describe, expect, it } from 'bun:test';

import type { ProviderEvent } from './types.js';
import {
  CopilotProvider,
  classifyCopilotError,
  type CopilotClientLike,
  type CopilotRuntimeDeps,
  type CopilotSessionLike,
} from './copilot.js';

type Script = (prompt: string, emit: (event: object) => void) => void;

/** A fake runtime: each prompt runs a script that emits SDK-shaped session events. */
function fakeRuntime(script: Script, opts: { resumeError?: Error } = {}) {
  const calls: {
    created: object[];
    resumed: Array<{ id: string; config: object }>;
    prompts: string[];
    clientOptions: object[];
  } = {
    created: [],
    resumed: [],
    prompts: [],
    clientOptions: [],
  };
  const lifecycle = { started: 0, stopped: 0, disconnected: 0, aborted: 0 };
  const session = (id: string): CopilotSessionLike => {
    const handlers = new Set<(event: never) => void>();
    const emit = (event: object) => queueMicrotask(() => handlers.forEach((handler) => handler(event as never)));
    return {
      sessionId: id,
      on(handler) {
        handlers.add(handler as never);
        return () => handlers.delete(handler as never);
      },
      async send({ prompt }) {
        calls.prompts.push(prompt);
        emit({ type: 'user.message', data: { content: prompt } });
        script(prompt, emit);
        return 'message-id';
      },
      async abort() {
        lifecycle.aborted++;
      },
      async disconnect() {
        lifecycle.disconnected++;
      },
    };
  };
  const client: CopilotClientLike = {
    async start() {
      lifecycle.started++;
    },
    async stop() {
      lifecycle.stopped++;
      return [];
    },
    async createSession(config) {
      calls.created.push(config);
      return session('session-new');
    },
    async resumeSession(id, config) {
      if (opts.resumeError) throw opts.resumeError;
      calls.resumed.push({ id, config });
      return session(id);
    },
  };
  const runtime: CopilotRuntimeDeps = {
    createClient: (options) => {
      calls.clientOptions.push(options);
      return client;
    },
    sessionOverrides: {},
  };
  return { runtime, calls, lifecycle };
}

const say = (content: string, extra: object = {}) => ({ type: 'assistant.message', data: { content }, ...extra });
const idle = (extra: object = {}) => ({ type: 'session.idle', data: {}, ...extra });
const hook = { command: 'true', legacyCommands: [], sources: ['startup', 'compact'] };

function provider(runtime: CopilotRuntimeDeps) {
  const p = new CopilotProvider({ model: 'gpt-5', effort: 'high' }, runtime);
  p.registerMemorySessionHook(hook);
  return p;
}

/** Drain events until `results` results have arrived, then end the query. */
async function collect(
  query: ReturnType<CopilotProvider['query']>,
  results: number,
  onResult?: (n: number) => void,
): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  let seen = 0;
  for await (const event of query.events) {
    events.push(event);
    if (event.type === 'result') {
      seen++;
      onResult?.(seen);
      if (seen === results) query.end();
    }
  }
  return events;
}

const meaningful = (events: ProviderEvent[]) => events.filter((event) => event.type !== 'activity');

describe('copilot turns', () => {
  it('starts a session, streams each assistant message as text and ends the turn on idle', async () => {
    const { runtime, calls, lifecycle } = fakeRuntime((_prompt, emit) => {
      emit(say('Working on it.'));
      emit({ type: 'tool.execution_start', data: { toolName: 'bash' } });
      emit(say('Done: 42.'));
      emit(idle());
    });
    const events = await collect(provider(runtime).query({ prompt: 'hi', cwd: '/tmp' }), 1);
    expect(meaningful(events)).toEqual([
      { type: 'init', continuation: 'session-new' },
      { type: 'text', text: 'Working on it.' },
      { type: 'text', text: 'Done: 42.' },
      { type: 'result', text: 'Done: 42.' },
    ]);
    // Every runtime event is liveness.
    expect(events.filter((event) => event.type === 'activity').length).toBeGreaterThanOrEqual(5);
    expect(calls.created[0]).toMatchObject({
      model: 'gpt-5',
      reasoningEffort: 'high',
      workingDirectory: '/tmp',
      streaming: true,
    });
    expect(lifecycle).toMatchObject({ started: 1, stopped: 1, disconnected: 1 });
  });

  it('ignores sub-agent messages and sub-agent idles', async () => {
    const { runtime } = fakeRuntime((_prompt, emit) => {
      emit(say('sub-agent chatter', { agentId: 'task-1' }));
      emit(idle({ agentId: 'task-1' }));
      emit(say('Final.'));
      emit(idle());
    });
    const events = await collect(provider(runtime).query({ prompt: 'hi', cwd: '/tmp' }), 1);
    expect(meaningful(events).slice(1)).toEqual([
      { type: 'text', text: 'Final.' },
      { type: 'result', text: 'Final.' },
    ]);
  });

  it('runs pushed prompts one turn at a time, one result each, in order', async () => {
    const { runtime, calls } = fakeRuntime((prompt, emit) => {
      emit(say(`echo ${prompt}`));
      emit(idle());
    });
    const query = provider(runtime).query({ prompt: 'one', cwd: '/tmp' });
    query.push('two');
    query.push('three');
    const events = await collect(query, 3);
    expect(calls.prompts).toEqual(['one', 'two', 'three']);
    expect(events.filter((event) => event.type === 'result').map((event) => (event as { text: string }).text)).toEqual([
      'echo one',
      'echo two',
      'echo three',
    ]);
  });

  it('turns a session error into a classified error and a failed result, then keeps serving', async () => {
    let turn = 0;
    const { runtime } = fakeRuntime((_prompt, emit) => {
      turn++;
      if (turn === 1) {
        emit({ type: 'session.error', data: { message: 'HTTP 401 Unauthorized', errorType: 'authentication' } });
        // The runtime still goes idle after an error; that idle belongs to turn one.
        emit(idle());
        return;
      }
      emit(say('recovered'));
      emit(idle());
    });
    const query = provider(runtime).query({ prompt: 'one', cwd: '/tmp' });
    query.push('two');
    const events = meaningful(await collect(query, 2));
    expect(events[1]).toMatchObject({ type: 'error', classification: 'auth', retryable: false });
    expect(events[2]).toMatchObject({ type: 'result', isError: true, text: null });
    expect((events[2] as { error: string }).error).toContain('Re-run the Copilot provider setup');
    expect(events.slice(3)).toEqual([
      { type: 'text', text: 'recovered' },
      { type: 'result', text: 'recovered' },
    ]);
  });

  it('resumes a stored continuation and gives it memory again, which the runtime does not store', async () => {
    const { runtime, calls } = fakeRuntime((_prompt, emit) => emit(idle()));
    const p = new CopilotProvider({}, runtime);
    p.registerMemorySessionHook({ command: 'printf MEMORY-42', legacyCommands: [], sources: ['startup', 'compact'] });
    const events = await collect(p.query({ prompt: 'hi', cwd: '/tmp', continuation: 'session-old' }), 1);
    expect(events.find((event) => event.type === 'init')).toEqual({ type: 'init', continuation: 'session-old' });
    expect(calls.resumed.map((call) => call.id)).toEqual(['session-old']);
    const hooks = (calls.resumed[0].config as { hooks: { onSessionStart: (input: object) => Promise<unknown> } }).hooks;
    expect(await hooks.onSessionStart({ source: 'resume' })).toEqual({ additionalContext: 'MEMORY-42' });
  });

  it('feeds memory to a new session and again after compaction', async () => {
    const { runtime, calls } = fakeRuntime((_prompt, emit) => {
      emit({ type: 'session.compaction_complete', data: {} });
      emit(idle());
    });
    const p = new CopilotProvider({}, runtime);
    p.registerMemorySessionHook({ command: 'printf MEMORY-42', legacyCommands: [], sources: ['startup', 'compact'] });
    const events = await collect(p.query({ prompt: 'hi', cwd: '/tmp' }), 1);
    expect(events).toContainEqual({ type: 'progress', message: 'context compacted' });
    const hooks = (
      calls.created[0] as {
        hooks: { onSessionStart: (input: object) => Promise<unknown>; onUserPromptSubmitted: () => Promise<unknown> };
      }
    ).hooks;
    expect(await hooks.onSessionStart({ source: 'new' })).toEqual({ additionalContext: 'MEMORY-42' });
    expect(await hooks.onUserPromptSubmitted()).toEqual({ additionalContext: 'MEMORY-42' });
    // Only the first prompt after a compaction carries it.
    expect(await hooks.onUserPromptSubmitted()).toBeUndefined();
  });

  it('reports a vanished stored session as invalid so core drops the continuation', async () => {
    const error = new Error(
      'Request session.resume failed with message: Failed to load session events: Session not found: x',
    );
    const { runtime } = fakeRuntime(() => {}, { resumeError: error });
    const p = provider(runtime);
    let caught: unknown;
    try {
      await collect(p.query({ prompt: 'hi', cwd: '/tmp', continuation: 'x' }), 1);
    } catch (err) {
      caught = err;
    }
    expect(p.isSessionInvalid(caught)).toBe(true);
    expect(p.isSessionInvalid(new Error('HTTP 500'))).toBe(false);
  });

  it('aborts the running turn and stops the runtime', async () => {
    const { runtime, lifecycle } = fakeRuntime(() => {
      /* never goes idle */
    });
    const query = provider(runtime).query({ prompt: 'hi', cwd: '/tmp' });
    const events: ProviderEvent[] = [];
    setTimeout(() => query.abort(), 20);
    for await (const event of query.events) events.push(event);
    expect(events.some((event) => event.type === 'result')).toBe(false);
    expect(lifecycle).toMatchObject({ aborted: 1, disconnected: 1, stopped: 1 });
  });

  it('refuses to query before core registered the memory hook', () => {
    const { runtime } = fakeRuntime(() => {});
    expect(() => new CopilotProvider({}, runtime).query({ prompt: 'hi', cwd: '/tmp' })).toThrow('memory session hook');
  });

  it('classifies the failures a person can act on', () => {
    expect(classifyCopilotError('Bad credentials', 'authentication')).toBe('auth');
    expect(classifyCopilotError('You have exceeded your premium request allowance', undefined)).toBe('quota');
    expect(classifyCopilotError('prompt token count exceeds the context window', undefined)).toBe('context');
    expect(classifyCopilotError('Session not found: abc', undefined)).toBe('stale-session');
    expect(classifyCopilotError('HTTP 401: token expired', undefined)).toBe('auth');
    expect(classifyCopilotError('socket hang up', undefined)).toBeUndefined();
  });
});
