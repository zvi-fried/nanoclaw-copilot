/**
 * Setup for the GitHub Copilot provider.
 *
 * The operator gives a GitHub token once, on the host. Setup reads the
 * account's Copilot plan with it (which also checks the token), records the
 * plan's API origin in `.env`, and stores the token in the selected credential
 * gateway (Iron Proxy or OneCLI) as one connection: the plan's API host, the
 * Authorization header, and the runtime's placeholder. The token is never
 * written to `.env` and never reaches a container.
 */
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

import * as p from '@clack/prompts';

import { getCredentialStore } from '../setup/gateways/credential-store.js';
import type { GatewayCredentialConnection, GatewayCredentialTarget } from '../setup/gateways/credential-store.js';
import { brandBody } from '../setup/lib/theme.js';
import { upsertEnvVar } from '../setup/set-env.js';
import {
  COPILOT_API_URL_KEY,
  COPILOT_CREDENTIAL_PLACEHOLDER,
  COPILOT_DEFAULT_API_URL,
  configuredCopilotApiUrl,
  normalizeCopilotApiUrl,
} from '../src/providers/copilot-endpoint.js';
import { planSkill } from './skill-apply.js';
import { parseDirectives } from './skill-directives.js';

/** The account's Copilot plan, read with the operator's token. Host-side only. */
export const COPILOT_ENTITLEMENT_URL = 'https://api.github.com/copilot_internal/user';

export type GitHubTokenKind = 'fine-grained' | 'oauth' | 'user-to-server' | 'classic' | 'unknown';

/** Copilot accepts fine-grained, OAuth-app and GitHub-App user tokens, not classic PATs. */
export function classifyGitHubToken(token: string): GitHubTokenKind {
  if (token.startsWith('github_pat_')) return 'fine-grained';
  if (token.startsWith('gho_')) return 'oauth';
  if (token.startsWith('ghu_')) return 'user-to-server';
  if (token.startsWith('ghp_')) return 'classic';
  return 'unknown';
}

/** Why a token cannot be used, or undefined when it can be tried. */
export function githubTokenProblem(token: string): string | undefined {
  if (!token) return 'Required.';
  if (/\s/.test(token)) return 'A token has no spaces or line breaks.';
  const kind = classifyGitHubToken(token);
  if (kind === 'classic')
    return 'GitHub Copilot does not accept classic personal access tokens (ghp_). Create a fine-grained token with the "Copilot Requests" permission.';
  if (kind === 'unknown') return 'Enter a GitHub token (github_pat_, gho_ or ghu_).';
}

export type CopilotEntitlement =
  | { status: 'ok'; apiUrl: string; plan?: string }
  | { status: 'unauthorized' }
  | { status: 'not-entitled'; reason: string }
  | { status: 'unknown'; reason: string };

/**
 * Read the plan. 401 is a bad token; a 200 without chat, or a 404, is an
 * account without Copilot; anything else (a 403 from a token that may only
 * make Copilot requests, a network failure) cannot be decided here.
 */
export async function probeCopilotEntitlement(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CopilotEntitlement> {
  let response: Response;
  try {
    response = await fetchImpl(COPILOT_ENTITLEMENT_URL, {
      headers: { authorization: `token ${token}`, accept: 'application/json', 'user-agent': 'nanoclaw-setup' },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    return { status: 'unknown', reason: `GitHub could not be reached (${(error as Error).message})` };
  }
  if (response.status === 401) return { status: 'unauthorized' };
  if (response.status === 404) return { status: 'not-entitled', reason: 'This account has no GitHub Copilot access.' };
  if (!response.ok)
    return { status: 'unknown', reason: `GitHub answered ${response.status} when reading the Copilot plan` };
  let body: { chat_enabled?: unknown; copilot_plan?: unknown; endpoints?: { api?: unknown } };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    return { status: 'unknown', reason: 'GitHub answered the Copilot plan request with an unreadable body' };
  }
  if (body.chat_enabled === false)
    return { status: 'not-entitled', reason: 'Copilot chat is disabled for this account (or by its organization).' };
  const declared = typeof body.endpoints?.api === 'string' ? body.endpoints.api : undefined;
  const apiUrl = declared === undefined ? COPILOT_DEFAULT_API_URL : normalizeCopilotApiUrl(declared);
  if (!apiUrl) return { status: 'unknown', reason: `GitHub declared an unexpected Copilot API (${declared})` };
  return { status: 'ok', apiUrl, ...(typeof body.copilot_plan === 'string' ? { plan: body.copilot_plan } : {}) };
}

/** The one connection setup stores: the plan's API host, bearer-injected, matched by the placeholder. */
export function copilotCredentialTarget(apiUrl: string): GatewayCredentialTarget {
  return {
    name: 'GitHub Copilot',
    kind: 'api-key',
    host: new URL(apiUrl).hostname,
    proxyValue: COPILOT_CREDENTIAL_PLACEHOLDER,
    injection: { headerName: 'Authorization', valueFormat: 'Bearer {value}' },
  };
}

function answer<T>(value: T | symbol): T {
  if (p.isCancel(value)) {
    p.cancel('Setup cancelled.');
    process.exit(1);
  }
  return value as T;
}

export interface CopilotAuthDeps {
  root?: string;
  promptToken(canKeep: boolean): Promise<string>;
  confirm(message: string): Promise<boolean>;
  info(message: string): void;
  probe(token: string): Promise<CopilotEntitlement>;
  connect(target: GatewayCredentialTarget): Promise<GatewayCredentialConnection>;
  writeApiUrl(apiUrl: string, root: string): void;
}

/** Recorded even when it is the default, so the configured plan is always explicit. */
function writeApiUrl(apiUrl: string, root: string): void {
  upsertEnvVar(COPILOT_API_URL_KEY, apiUrl, root);
}

const defaultDeps = (root: string): CopilotAuthDeps => ({
  root,
  async promptToken(canKeep) {
    const value = answer(
      await p.password({
        message: canKeep
          ? 'GitHub token for Copilot (leave blank to keep the stored one)'
          : 'GitHub token for Copilot (a fine-grained token with the "Copilot Requests" permission)',
        validate: (raw) => {
          const token = String(raw ?? '').trim();
          if (canKeep && !token) return undefined;
          return githubTokenProblem(token);
        },
      }),
    );
    return String(value ?? '').trim();
  },
  async confirm(message) {
    return answer(await p.confirm({ message, initialValue: false }));
  },
  info: (message) => p.log.info(brandBody(message)),
  probe: (token) => probeCopilotEntitlement(token),
  async connect(target) {
    const store = await getCredentialStore(root);
    if (!store.connection) throw new Error('The selected credential gateway does not support provider credentials.');
    return store.connection(target);
  },
  writeApiUrl,
});

/**
 * Store (or keep) the operator's Copilot credential. A stored token is kept
 * when the operator leaves the prompt blank; a new one is checked against
 * GitHub first, and its plan's API decides the connected host.
 */
export async function runCopilotAuthStep(deps: CopilotAuthDeps = defaultDeps(process.cwd())): Promise<void> {
  const root = deps.root ?? process.cwd();
  deps.info(
    'Copilot runs on your GitHub account and its Copilot plan. The token is stored in the credential gateway; agents only ever see a placeholder.',
  );
  // The host currently configured; a new token's plan may move it.
  const current = configuredCopilotApiUrl(root);
  // keep() acts on the entry this connection's find() observed, so a blank
  // answer keeps through the same connection.
  const stored = await deps.connect(copilotCredentialTarget(current));
  const existing = await stored.find({
    confirmHostChange: (previous, next) =>
      deps.confirm(`Move the stored Copilot credential from ${previous} to ${next}?`),
  });
  const token = await deps.promptToken(Boolean(existing?.reusable));
  if (!token) {
    await stored.keep();
    deps.info('Kept the stored Copilot credential.');
    return;
  }
  const problem = githubTokenProblem(token);
  if (problem) throw new Error(problem);

  const entitlement = await deps.probe(token);
  let apiUrl = COPILOT_DEFAULT_API_URL;
  if (entitlement.status === 'unauthorized')
    throw new Error('GitHub rejected this token. Check it and run setup again.');
  if (entitlement.status === 'not-entitled') throw new Error(entitlement.reason);
  if (entitlement.status === 'ok') {
    apiUrl = entitlement.apiUrl;
    deps.info(`Copilot plan: ${entitlement.plan ?? 'confirmed'} (${new URL(apiUrl).hostname}).`);
  } else if (
    !(await deps.confirm(
      `${entitlement.reason}. Continue with the individual plan's API (${new URL(COPILOT_DEFAULT_API_URL).hostname})?`,
    ))
  ) {
    throw new Error('Copilot setup stopped before storing the token.');
  }

  const connection = await deps.connect(copilotCredentialTarget(apiUrl));
  await connection.find({
    confirmHostChange: (previous, next) =>
      deps.confirm(`Move the stored Copilot credential from ${previous} to ${next}?`),
  });
  await connection.save(token);
  deps.writeApiUrl(apiUrl, root);
  deps.info('Stored the Copilot credential in the credential gateway.');
}

/** Setup treats a normal return as success and may select this provider as the default. */
export async function runCopilotSetupAuth(): Promise<void> {
  await runCopilotAuthStep();
}

/** Check declared installation state; install/refresh verifies contracts and builds the image. */
export async function checkCopilotInstall(root = process.cwd()): Promise<void> {
  const skillDir = path.join(root, '.claude/skills/add-copilot');
  const markdown = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
  const { steps } = planSkill(skillDir, root);
  const installation = steps.filter(({ kind }) => ['copy', 'append', 'dep'].includes(kind));
  if (!installation.length) throw new Error('Copilot skill has no installation declarations. Restore SKILL.md.');
  const pending = installation.find(({ status }) => status !== 'skip');
  if (pending) throw new Error(`Copilot installation is incomplete: ${pending.detail}. Refresh the provider skill.`);
  for (const directive of parseDirectives(markdown)) {
    if (directive.kind !== 'dep') continue;
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, String(directive.attrs.cwd ?? ''), 'package.json'), 'utf8'),
    );
    for (const spec of directive.body) {
      const at = spec.lastIndexOf('@');
      const name = spec.slice(0, at);
      const version = spec.slice(at + 1);
      if ((manifest.dependencies?.[name] ?? manifest.devDependencies?.[name]) !== version)
        throw new Error(`Copilot dependency ${name} must match the skill pin ${version}. Refresh the provider skill.`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  checkCopilotInstall()
    .then(() => runCopilotSetupAuth())
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : 'Copilot setup failed');
      process.exitCode = 1;
    });
}
