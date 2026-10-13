import { it } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { CopilotClient } from '@github/copilot-sdk';

import { CopilotProvider, type CopilotRuntimeDeps } from './copilot.js';
import type { ProviderEvent } from './types.js';

/**
 * Explicit integration check: COPILOT_NATIVE_TEST=1 bun test src/providers/copilot.native.test.ts
 *
 * Drives the real, skill-pinned Copilot runtime through CopilotProvider. The
 * model is a local scripted OpenAI-compatible fixture attached through the
 * SDK's BYOK provider setting, so no GitHub account is needed; everything
 * else (the runtime, its tool loop, MCP, skills, hooks, streaming and session
 * storage) is the production code path.
 */
it.skipIf(!process.env.COPILOT_NATIVE_TEST)(
  'streams replies, calls an MCP tool and a built-in tool, loads a skill, injects memory and resumes',
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-native-'));
    const cwd = path.join(root, 'agent');
    const skills = path.join(root, 'skills');
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(path.join(skills, 'nanoclaw-test-skill'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), '# Group\nPROJECT-DOC-MARKER\n');
    fs.writeFileSync(
      path.join(skills, 'nanoclaw-test-skill', 'SKILL.md'),
      '---\nname: nanoclaw-test-skill\ndescription: Answers the skill check. Use when asked to USE_SKILL.\n---\n\nReply with SKILL-BODY-MARKER.\n',
    );
    const mcpServer = path.join(root, 'echo-mcp.mjs');
    fs.writeFileSync(mcpServer, ECHO_MCP_SERVER);

    // The scripted model. Each decision reads only the request it gets.
    const requests: any[] = [];
    const model = http.createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      if (req.url?.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'fixture', object: 'model' }] }));
        return;
      }
      const request = JSON.parse(body || '{}');
      requests.push(request);
      const reply = decide(request);
      const chunk = (delta: object, finish: string | null = null) =>
        `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if ('tool' in reply) {
        res.write(
          chunk({
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                index: 0,
                id: `call_${requests.length}`,
                type: 'function',
                function: { name: reply.tool, arguments: JSON.stringify(reply.args) },
              },
            ],
          }),
        );
        res.write(chunk({}, 'tool_calls'));
      } else {
        // Several deltas, so streaming is exercised.
        for (const part of reply.text.match(/.{1,8}/gs) ?? ['']) res.write(chunk({ role: 'assistant', content: part }));
        res.write(chunk({}, 'stop'));
      }
      res.end('data: [DONE]\n\n');
    });
    await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));
    const port = (model.address() as { port: number }).port;

    const deltas: string[] = [];
    const runtime: CopilotRuntimeDeps = {
      createClient: (options) => {
        const client = new CopilotClient({ ...options, baseDirectory: path.join(root, 'copilot-home') });
        return {
          start: () => client.start(),
          stop: () => client.stop(),
          createSession: async (config) => watch(await client.createSession(config)),
          resumeSession: async (id, config) => watch(await client.resumeSession(id, config)),
        };
      },
      sessionOverrides: {
        model: 'fixture',
        provider: { type: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'fixture-key' },
        skillDirectories: [skills],
      },
    };
    function watch<T extends { on: (handler: (event: any) => void) => unknown }>(session: T): T {
      session.on((event) => {
        if (event.type === 'assistant.message_delta') deltas.push(event.data.deltaContent);
      });
      return session;
    }

    const memoryHook = {
      command: `printf 'MEMORY-MARKER-42'`,
      legacyCommands: [],
      sources: ['startup', 'compact'],
    };
    const savedNoProxy = process.env.NO_PROXY;
    process.env.NO_PROXY = process.env.no_proxy = '127.0.0.1,localhost';
    try {
      const first = new CopilotProvider(
        {
          env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' },
          mcpServers: { nanoclaw: { command: process.execPath, args: [mcpServer] } },
        },
        runtime,
      );
      first.registerMemorySessionHook(memoryHook);
      const query = first.query({
        prompt: 'FIRST-TURN-MARKER hello',
        cwd,
        systemContext: { instructions: 'SYSCTX-MARKER-7' },
      });
      for (const prompt of ['USE_MCP', 'USE_SHELL', 'USE_SKILL', 'CHECK_MEMORY']) query.push(prompt);
      const events = await drain(query, 5);
      const results = events.filter((e) => e.type === 'result').map((e) => (e as { text: string | null }).text);
      const continuation = (events.find((e) => e.type === 'init') as { continuation: string }).continuation;

      assert.equal(results[0], 'Reply to: FIRST-TURN-MARKER hello');
      assert.ok(deltas.length >= 3, `expected streamed deltas, got ${deltas.length}`);
      assert.equal(results[1], 'TOOL RESULT: echoed:ping-from-model');
      assert.match(results[2] ?? '', /^TOOL RESULT: .*shell-ok/s);
      assert.match(results[3] ?? '', /SKILL-BODY-MARKER/);
      assert.equal(results[4], 'MEMORY: yes; PROJECT DOC: yes; SYSTEM CONTEXT: yes');
      assert.ok(fs.existsSync(path.join(root, 'copilot-home', 'session-state', continuation, 'events.jsonl')));

      // A fresh provider (a new container) resumes the stored session.
      const second = new CopilotProvider({ env: { ...process.env } }, runtime);
      second.registerMemorySessionHook(memoryHook);
      const resumed = await drain(second.query({ prompt: 'RECALL', cwd, continuation }), 1);
      assert.equal((resumed.find((e) => e.type === 'init') as { continuation: string }).continuation, continuation);
      assert.equal((resumed.find((e) => e.type === 'result') as { text: string }).text, 'HISTORY HAS FIRST: yes');
      // The resumed session has the memory exactly once.
      const recall = JSON.stringify(requests.at(-1));
      assert.equal(recall.split('MEMORY-MARKER-42').length - 1, 1);
    } finally {
      if (savedNoProxy === undefined) delete process.env.NO_PROXY;
      else process.env.NO_PROXY = savedNoProxy;
      model.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
  180_000,
);

async function drain(query: ReturnType<CopilotProvider['query']>, results: number): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  let seen = 0;
  for await (const event of query.events) {
    events.push(event);
    if (event.type === 'result' && ++seen === results) query.end();
  }
  return events;
}

const text = (message: any): string =>
  typeof message?.content === 'string'
    ? message.content
    : Array.isArray(message?.content)
      ? message.content.map((part: any) => part.text ?? '').join('')
      : '';

function decide(request: any): { text: string } | { tool: string; args: object } {
  const messages: any[] = request.messages ?? [];
  const last = messages.at(-1);
  const prompt = text([...messages].reverse().find((m) => m.role === 'user'));
  const all = JSON.stringify(request);
  const tools: string[] = (request.tools ?? []).map((t: any) => t.function?.name).filter(Boolean);
  if (last?.role === 'tool') return { text: `TOOL RESULT: ${text(last)}` };
  // The skill tool loads the skill's body as a <skill-context> message; the model then follows it.
  if (/<skill-context name="nanoclaw-test-skill">[\s\S]*SKILL-BODY-MARKER/.test(prompt))
    return { text: 'SKILL-BODY-MARKER' };
  if (/USE_MCP/.test(prompt)) {
    const tool = tools.find((name) => /echo/.test(name));
    return tool ? { tool, args: { text: 'ping-from-model' } } : { text: `no MCP tool among ${tools.join(',')}` };
  }
  if (/USE_SHELL/.test(prompt)) {
    const tool = tools.find((name) => name === 'bash');
    return tool
      ? { tool, args: { command: 'echo shell-ok', description: 'echo' } }
      : { text: `no shell among ${tools.join(',')}` };
  }
  if (/USE_SKILL/.test(prompt)) {
    const tool = tools.find((name) => name === 'skill');
    if (!tool) return { text: `no skill tool among ${tools.join(',')}` };
    return /nanoclaw-test-skill/.test(all)
      ? { tool, args: { skill: 'nanoclaw-test-skill' } }
      : { text: 'skill not listed' };
  }
  if (/CHECK_MEMORY/.test(prompt))
    return {
      text: `MEMORY: ${/MEMORY-MARKER-42/.test(all) ? 'yes' : 'no'}; PROJECT DOC: ${/PROJECT-DOC-MARKER/.test(all) ? 'yes' : 'no'}; SYSTEM CONTEXT: ${/SYSCTX-MARKER-7/.test(all) ? 'yes' : 'no'}`,
    };
  if (/RECALL/.test(prompt)) return { text: `HISTORY HAS FIRST: ${/FIRST-TURN-MARKER/.test(all) ? 'yes' : 'no'}` };
  return { text: `Reply to: ${prompt.replace(/<[^>]+>[^<]*<\/[^>]+>/g, '').trim()}` };
}

/** A dependency-free stdio MCP server with one `echo` tool. */
const ECHO_MCP_SERVER = `
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  if (msg.method === 'initialize')
    return send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'echo', version: '1.0.0' } } });
  if (msg.method === 'tools/list')
    return send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'echo', description: 'Echo text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] } });
  if (msg.method === 'tools/call')
    return send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'echoed:' + msg.params.arguments.text }] } });
  send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'unknown method' } });
});
`;
