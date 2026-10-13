import { afterAll, beforeAll, it } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CopilotClient } from '@github/copilot-sdk';

import './index.js';
import '../provider-contracts/index.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { closeSessionDb, getInboundDb, initTestSessionDb } from '../mailbox/sqlite/connection.js';
import { runPollLoop } from '../poll-loop.js';
import { registerProviderMemorySessionHook } from '../provider-contracts/realize.js';
import { createProvider } from './factory.js';
import { getProviderRuntimeContract } from './provider-registry.js';
import { defaultCopilotRuntimeDeps } from './copilot.js';

/**
 * Gateway end-to-end check, run by .claude/skills/add-copilot/e2e/gateway-injection.sh
 * (COPILOT_GATEWAY_E2E=1). The runner's real poll loop drives the provider as
 * core builds it (factory, runtime contract, memory hook) and the real
 * Copilot runtime, on GitHub's real Copilot protocol rather than a BYOK model.
 * Its HTTPS goes through the credential gateway named by HTTPS_PROXY, which
 * holds the token; the runtime only has the placeholder. The upstream is the
 * script's fake Copilot API, which the script checks afterwards.
 *
 * MCP is not part of this check. Under Copilot auth the runtime withholds
 * non-default MCP servers until it has GitHub's MCP policy, which the fake
 * does not reproduce; copilot.native.test.ts covers the provider's MCP wiring,
 * and a live run must confirm the policy path (see SKILL.md).
 */
const enabled = Boolean(process.env.COPILOT_GATEWAY_E2E);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-gateway-'));
const deltas: string[] = [];
const saved = { ...defaultCopilotRuntimeDeps };

beforeAll(() => {
  if (!enabled) return;
  const skills = path.join(root, 'skills', 'nanoclaw-test-skill');
  fs.mkdirSync(skills, { recursive: true });
  fs.writeFileSync(
    path.join(skills, 'SKILL.md'),
    '---\nname: nanoclaw-test-skill\ndescription: Answers the skill check. Use when asked to USE_SKILL.\n---\n\nReply with SKILL-BODY-MARKER.\n',
  );
  fs.mkdirSync(path.join(root, 'agent'));
  fs.writeFileSync(path.join(root, 'agent', 'CLAUDE.md'), '# Group\nPROJECT-DOC-MARKER\n');
  // The container paths are not writable here; everything else is production.
  defaultCopilotRuntimeDeps.createClient = (options) => {
    const client = new CopilotClient({ ...options, baseDirectory: path.join(root, 'copilot-home') });
    const watch = <T extends { on: (handler: (event: any) => void) => unknown }>(session: T): T => {
      session.on((event) => {
        if (event.type === 'assistant.message_delta') deltas.push(event.data.deltaContent);
      });
      return session;
    };
    return {
      start: () => client.start(),
      stop: () => client.stop(),
      createSession: async (config) => watch(await client.createSession(config)),
      resumeSession: async (id, config) => watch(await client.resumeSession(id, config)),
    };
  };
  defaultCopilotRuntimeDeps.sessionOverrides = { skillDirectories: [path.join(root, 'skills')] };
  initTestSessionDb();
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('discord-test', 'Discord Test', 'channel', 'discord', 'chan-1', NULL)`,
    )
    .run();
});

afterAll(() => {
  Object.assign(defaultCopilotRuntimeDeps, saved);
  if (enabled) closeSessionDb();
  fs.rmSync(root, { recursive: true, force: true });
});

it.skipIf(!enabled)(
  'answers through the gateway: streaming, a built-in tool, a skill and memory',
  async () => {
    assert.ok(process.env.HTTPS_PROXY, 'HTTPS_PROXY must name the credential gateway');
    for (const name of ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'])
      assert.equal(process.env[name], undefined, `${name} must not be set: the runtime may hold no token`);

    const provider = createProvider('copilot', {
      model: 'gpt-4.1',
      env: { ...process.env },
      mcpServers: {},
    });
    registerProviderMemorySessionHook('copilot', provider, {
      command: `printf 'MEMORY-MARKER-42'`,
      legacyCommands: [],
      sources: ['startup', 'compact'],
    });

    const controller = new AbortController();
    const loop = runPollLoop({
      provider,
      providerContract: getProviderRuntimeContract('copilot'),
      providerName: 'copilot',
      cwd: path.join(root, 'agent'),
      signal: controller.signal,
    }).catch(() => {});

    const replies: string[] = [];
    try {
      for (const [index, prompt] of ['hello', 'USE_SHELL', 'USE_SKILL', 'CHECK_MEMORY'].entries()) {
        getInboundDb()
          .prepare(
            `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
             VALUES (?, 'chat', datetime('now'), 'pending', 'chan-1', 'discord', NULL, ?)`,
          )
          .run(`m${index}`, JSON.stringify({ sender: 'Alice', text: prompt }));
        const deadline = Date.now() + 90_000;
        while (getUndeliveredMessages().length <= index) {
          if (Date.now() > deadline) throw new Error(`no reply to ${prompt}; got ${JSON.stringify(replies)}`);
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        replies.push(JSON.parse(getUndeliveredMessages()[index].content).text);
      }
    } finally {
      controller.abort();
      await loop;
    }

    console.log(`[gateway-e2e] replies: ${JSON.stringify(replies)}; streamed deltas: ${deltas.length}`);
    assert.equal(replies[0], 'hello from fake copilot');
    assert.ok(deltas.length >= 2, 'the reply arrived as a stream of deltas');
    assert.equal(replies[1], 'TOOL RESULT: shell-ok');
    assert.equal(replies[2], 'SKILL-BODY-MARKER');
    assert.equal(replies[3], 'MEMORY: yes; PROJECT DOC: yes');
    for (const reply of getUndeliveredMessages()) assert.equal(reply.platform_id, 'chan-1');
  },
  600_000,
);
