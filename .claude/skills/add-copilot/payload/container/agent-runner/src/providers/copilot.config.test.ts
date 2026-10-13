import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  COPILOT_CREDENTIAL_PLACEHOLDER,
  COPILOT_HOME,
  COPILOT_SKILLS_DIR,
  copilotClientOptions,
  copilotRuntimeEnvironment,
  copilotSessionConfig,
  copilotSystemMessage,
  resolveCopilotExecutionPolicy,
  resolveCopilotInference,
  resolveCopilotMcpServers,
} from './copilot-config.js';
import { copilotPermissionHandler } from './copilot.js';

describe('copilot configuration', () => {
  it('keeps the runtime placeholder equal to the one the host connects', () => {
    const host = fs.readFileSync(new URL('../../../../src/providers/copilot-endpoint.ts', import.meta.url), 'utf8');
    expect(host).toContain(`COPILOT_CREDENTIAL_PLACEHOLDER = '${COPILOT_CREDENTIAL_PLACEHOLDER}'`);
  });

  it('hands the SDK only the placeholder, never an ambient GitHub token', () => {
    const options = copilotClientOptions({
      PATH: '/usr/bin',
      COPILOT_GITHUB_TOKEN: 'secret-a',
      GH_TOKEN: 'secret-b',
      GITHUB_TOKEN: 'secret-c',
      COPILOT_API_URL: 'https://api.business.githubcopilot.com',
    });
    expect(options).toMatchObject({
      mode: 'empty',
      baseDirectory: COPILOT_HOME,
      gitHubToken: COPILOT_CREDENTIAL_PLACEHOLDER,
      useLoggedInUser: false,
    });
    expect(JSON.stringify(options)).not.toContain('secret-');
    expect(options.env).toMatchObject({ PATH: '/usr/bin', COPILOT_API_URL: 'https://api.business.githubcopilot.com' });
    expect(copilotRuntimeEnvironment({ GH_TOKEN: 'x', HOME: '/home/node' })).toEqual({ HOME: '/home/node' });
  });

  it('passes model and effort through and drops an effort outside the SDK vocabulary', () => {
    expect(resolveCopilotInference({ model: 'gpt-5', effort: 'high' })).toEqual({
      model: 'gpt-5',
      reasoningEffort: 'high',
    });
    expect(resolveCopilotInference({ model: 'gpt-5', effort: 'ludicrous' as never })).toEqual({ model: 'gpt-5' });
    expect(resolveCopilotInference({})).toEqual({});
  });

  it('maps stdio and http MCP servers, keeping a stdio cwd', () => {
    expect(
      resolveCopilotMcpServers({
        nanoclaw: { command: 'bun', args: ['run', 'mcp.ts'], env: { A: '1' }, cwd: '/app' },
        remote: { type: 'http', url: 'https://mcp.example.com', headers: { 'x-a': 'b' } },
      }),
    ).toEqual({
      nanoclaw: {
        type: 'stdio',
        command: 'bun',
        args: ['run', 'mcp.ts'],
        env: { A: '1' },
        workingDirectory: '/app',
        tools: ['*'],
      },
      remote: { type: 'http', url: 'https://mcp.example.com', headers: { 'x-a': 'b' }, tools: ['*'] },
    });
  });

  it('declares a fixed container-boundary execution policy', () => {
    expect(resolveCopilotExecutionPolicy()).toEqual({ boundary: 'container', permissions: 'approve-unless-managed' });
  });

  it('approves tool permissions unless managed policy reserves them for a person', () => {
    expect(copilotPermissionHandler({ kind: 'shell' } as never, { sessionId: 's' })).toEqual({ kind: 'approve-once' });
    expect(
      copilotPermissionHandler({ kind: 'shell', managedApprovalRequired: true } as never, { sessionId: 's' }),
    ).toEqual({
      kind: 'user-not-available',
    });
  });

  it('builds the session from the composed project document, core context, skills and NanoClaw MCP only', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-config-'));
    fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), '# Project\nPROJECT-DOC\n');
    const config = copilotSessionConfig({
      cwd,
      instructions: 'CORE-CONTEXT',
      additionalDirectories: ['/workspace/extra'],
      inference: { model: 'gpt-5' },
      mcpServers: { nanoclaw: { type: 'stdio', command: 'bun', tools: ['*'] } },
    });
    expect(config).toMatchObject({
      model: 'gpt-5',
      workingDirectory: cwd,
      additionalDirectories: ['/workspace/extra'],
      streaming: true,
      systemMessage: { mode: 'append', content: '# Project\nPROJECT-DOC\n\nCORE-CONTEXT' },
      enableSkills: true,
      skillDirectories: [COPILOT_SKILLS_DIR],
      disabledMcpServers: ['github-mcp-server'],
      availableTools: ['builtin:*', 'mcp:*'],
      excludedTools: ['builtin:ask_user'],
    });
    expect(Object.keys(config.mcpServers ?? {})).toEqual(['nanoclaw']);
    expect(copilotSystemMessage(path.join(cwd, 'missing'), undefined)).toBe('');
  });
});
