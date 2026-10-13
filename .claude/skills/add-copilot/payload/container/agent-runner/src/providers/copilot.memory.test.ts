import { describe, expect, it } from 'bun:test';

import { copilotMemoryContext, runHookCommand } from './copilot-memory.js';

const hook = { command: 'render-memory', legacyCommands: [], sources: ['startup', 'compact'] };

describe('copilot memory', () => {
  it('returns the hook output for a declared source, with the SessionStart payload', async () => {
    let seen = '';
    const context = await copilotMemoryContext(hook, 'startup', async (_command, input) => {
      seen = input;
      return { status: 0, stdout: '  MEMORY-INDEX\n' };
    });
    expect(context).toBe('MEMORY-INDEX');
    expect(JSON.parse(seen)).toEqual({ hook_event_name: 'SessionStart', source: 'startup' });
  });

  it('gives nothing for an undeclared source, an empty render, or a failing hook', async () => {
    const run = async () => ({ status: 0, stdout: 'X' });
    expect(await copilotMemoryContext({ ...hook, sources: ['startup'] }, 'compact', run)).toBeUndefined();
    expect(await copilotMemoryContext(hook, 'startup', async () => ({ status: 0, stdout: '  ' }))).toBeUndefined();
    expect(await copilotMemoryContext(hook, 'startup', async () => ({ status: 1, stdout: 'X' }))).toBeUndefined();
    expect(await copilotMemoryContext(undefined, 'startup', run)).toBeUndefined();
  });

  it('runs the real command with its payload on stdin, and abandons one past its deadline', async () => {
    expect(await runHookCommand('cat', 'hello')).toMatchObject({ status: 0, stdout: 'hello' });
    const slow = await runHookCommand('sleep 5', '', 100);
    expect(slow.error?.message).toContain('timed out');
  });
});
