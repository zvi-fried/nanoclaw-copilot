/**
 * Pure configuration derivations for the Copilot provider. These are the
 * implementations the runtime contract declares for the executionPolicy /
 * inference / mcpServers capabilities, and the exact functions the live query
 * path consumes, so the contract's probes exercise the real wiring.
 *
 * Credentials: the runtime never holds one. The SDK is handed a fixed,
 * non-secret placeholder token; the selected credential gateway replaces it on
 * the wire for the plan's API host, which setup connected (scripts/copilot-auth.ts).
 * Ambient GitHub tokens are stripped from the runtime's environment so the SDK
 * cannot fall back to one.
 */
import fs from 'fs';
import path from 'path';

import type { CopilotClientOptions, MCPServerConfig, SessionConfig } from '@github/copilot-sdk';

import type { RuntimeInferenceInput } from '../provider-contracts/registry.js';
import type { McpServerConfig } from './types.js';

/**
 * The value the runtime presents where a GitHub token belongs. It is not a
 * secret: the gateway matches it and swaps in the stored credential. The host
 * declares the same literal (src/provider-contracts/copilot.ts); a payload test
 * keeps the two equal.
 */
export const COPILOT_CREDENTIAL_PLACEHOLDER = 'nc-copilot-token-v1';

/** Copilot's state (sessions for resume, config) lives on the group's copilot-home volume. */
export const COPILOT_HOME = '/home/node/.copilot';

/** NanoClaw's shared skills, realized by core into the Claude-compatible skill backing. */
export const COPILOT_SKILLS_DIR = '/home/node/.claude/skills';

/** The project document core composes for this provider (the host contract's projectDocument). */
export const COPILOT_PROJECT_DOC = 'CLAUDE.md';

/** Environment variables the SDK reads as a GitHub token. None may reach the runtime. */
export const AMBIENT_TOKEN_VARIABLES = ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'] as const;

/**
 * Built-in tools left out of a NanoClaw session. `ask_user` would block on an
 * interactive answer the container cannot give (NanoClaw's own
 * ask_user_question MCP tool persists the question instead).
 */
export const COPILOT_EXCLUDED_TOOLS = ['builtin:ask_user'];

/**
 * MCP servers the runtime would start on its own. The built-in GitHub server
 * would act on GitHub with the person's Copilot token; NanoClaw sessions get
 * only the MCP servers NanoClaw configures.
 */
export const COPILOT_DISABLED_MCP_SERVERS = ['github-mcp-server'];

/** The SDK's effort vocabulary (its type is not exported by name). */
type ReasoningEffort = NonNullable<SessionConfig['reasoningEffort']>;

const EFFORTS: readonly ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * The provider's sandbox stance. The container and the gateway are the
 * boundary, so the runtime approves its own tool permissions; a request that
 * managed policy marks as needing a person is declined, never auto-approved.
 */
export function resolveCopilotExecutionPolicy(): { boundary: 'container'; permissions: 'approve-unless-managed' } {
  return { boundary: 'container', permissions: 'approve-unless-managed' };
}

/** Model and effort pass to the SDK as given; an effort outside its vocabulary is dropped, never guessed. */
export function resolveCopilotInference(input: RuntimeInferenceInput): {
  model?: string;
  reasoningEffort?: ReasoningEffort;
} {
  const effort = EFFORTS.find((candidate) => candidate === input.effort);
  return {
    ...(input.model ? { model: input.model } : {}),
    ...(effort ? { reasoningEffort: effort } : {}),
  };
}

/** NanoClaw's MCP servers in the SDK's shape. A stdio server's cwd is native here (`workingDirectory`). */
export function resolveCopilotMcpServers(servers: Record<string, McpServerConfig>): Record<string, MCPServerConfig> {
  const out: Record<string, MCPServerConfig> = {};
  for (const [name, server] of Object.entries(servers)) {
    if (server.type === 'http') {
      out[name] = {
        type: 'http',
        url: server.url,
        ...(server.headers ? { headers: server.headers } : {}),
        tools: ['*'],
      };
      continue;
    }
    out[name] = {
      type: 'stdio',
      command: server.command,
      ...(server.args ? { args: server.args } : {}),
      ...(server.env ? { env: server.env } : {}),
      ...(server.cwd ? { workingDirectory: server.cwd } : {}),
      tools: ['*'],
    };
  }
  return out;
}

/** The runtime's environment: the container's, without any token the SDK could pick up. */
export function copilotRuntimeEnvironment(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env };
  for (const name of AMBIENT_TOKEN_VARIABLES) delete out[name];
  return out;
}

/** Client options: "empty" mode (no ambient CLI behaviour), state on the volume, the placeholder token only. */
export function copilotClientOptions(env: Record<string, string | undefined> = process.env): CopilotClientOptions {
  return {
    mode: 'empty',
    baseDirectory: COPILOT_HOME,
    gitHubToken: COPILOT_CREDENTIAL_PLACEHOLDER,
    useLoggedInUser: false,
    env: copilotRuntimeEnvironment(env),
    logLevel: 'error',
  };
}

/** The composed project document plus core's per-query system context, as appended instructions. */
export function copilotSystemMessage(cwd: string, instructions: string | undefined): string {
  let projectDoc = '';
  try {
    projectDoc = fs.readFileSync(path.join(cwd, COPILOT_PROJECT_DOC), 'utf-8').trim();
  } catch {
    /* A group without a composed document still runs; core's context follows. */
  }
  return [projectDoc, instructions?.trim()].filter(Boolean).join('\n\n');
}

export interface CopilotSessionPlan {
  cwd: string;
  instructions?: string;
  additionalDirectories?: string[];
  inference: ReturnType<typeof resolveCopilotInference>;
  mcpServers: Record<string, MCPServerConfig>;
}

/**
 * Everything a session is created or resumed with, except the hooks and the
 * permission handler, which the provider adds because they close over its state.
 */
export function copilotSessionConfig(plan: CopilotSessionPlan): Omit<SessionConfig, 'hooks' | 'onPermissionRequest'> {
  const content = copilotSystemMessage(plan.cwd, plan.instructions);
  return {
    ...plan.inference,
    clientName: 'nanoclaw',
    workingDirectory: plan.cwd,
    ...(plan.additionalDirectories?.length ? { additionalDirectories: plan.additionalDirectories } : {}),
    streaming: true,
    ...(content ? { systemMessage: { mode: 'append', content } } : {}),
    mcpServers: plan.mcpServers,
    disabledMcpServers: COPILOT_DISABLED_MCP_SERVERS,
    enableSkills: true,
    skillDirectories: [COPILOT_SKILLS_DIR],
    availableTools: ['builtin:*', 'mcp:*'],
    excludedTools: COPILOT_EXCLUDED_TOOLS,
  };
}
