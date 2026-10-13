import { describe, expect, it } from 'vitest';

import type { GatewayCredentialConnection, GatewayCredentialTarget } from '../setup/gateways/credential-store.js';
import {
  COPILOT_ENTITLEMENT_URL,
  classifyGitHubToken,
  copilotCredentialTarget,
  githubTokenProblem,
  probeCopilotEntitlement,
  runCopilotAuthStep,
  type CopilotAuthDeps,
  type CopilotEntitlement,
} from './copilot-auth.js';

const reply = (status: number, body?: unknown) =>
  (async () => new Response(body === undefined ? null : JSON.stringify(body), { status })) as unknown as typeof fetch;

describe('GitHub token checks', () => {
  it('accepts the token kinds Copilot accepts and refuses classic PATs', () => {
    expect(classifyGitHubToken('github_pat_abc')).toBe('fine-grained');
    expect(classifyGitHubToken('gho_abc')).toBe('oauth');
    expect(classifyGitHubToken('ghu_abc')).toBe('user-to-server');
    expect(githubTokenProblem('github_pat_abc')).toBeUndefined();
    expect(githubTokenProblem('ghp_abc')).toContain('classic');
    expect(githubTokenProblem('sk-abc')).toContain('GitHub token');
    expect(githubTokenProblem('')).toBe('Required.');
  });
});

describe('Copilot plan probe', () => {
  it('reads the plan and its API host with the token, from the host', async () => {
    let seen: { url: string; auth: string } | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, auth: (init.headers as Record<string, string>).authorization };
      return new Response(
        JSON.stringify({
          chat_enabled: true,
          copilot_plan: 'business',
          endpoints: { api: 'https://api.business.githubcopilot.com' },
        }),
      );
    }) as unknown as typeof fetch;
    expect(await probeCopilotEntitlement('github_pat_x', fetchImpl)).toEqual({
      status: 'ok',
      apiUrl: 'https://api.business.githubcopilot.com',
      plan: 'business',
    });
    expect(seen).toEqual({ url: COPILOT_ENTITLEMENT_URL, auth: 'token github_pat_x' });
  });

  it('defaults the API when none is declared, and refuses a host outside githubcopilot.com', async () => {
    expect(await probeCopilotEntitlement('t', reply(200, { chat_enabled: true }))).toMatchObject({
      status: 'ok',
      apiUrl: 'https://api.githubcopilot.com',
    });
    expect(
      await probeCopilotEntitlement('t', reply(200, { endpoints: { api: 'https://evil.example.com' } })),
    ).toMatchObject({
      status: 'unknown',
    });
    expect(
      await probeCopilotEntitlement('t', reply(200, { endpoints: { api: 'http://api.githubcopilot.com' } })),
    ).toMatchObject({ status: 'unknown' });
  });

  it('tells a bad token, an account without Copilot, and an undecidable answer apart', async () => {
    expect(await probeCopilotEntitlement('t', reply(401))).toEqual({ status: 'unauthorized' });
    expect(await probeCopilotEntitlement('t', reply(404))).toMatchObject({ status: 'not-entitled' });
    expect(await probeCopilotEntitlement('t', reply(200, { chat_enabled: false }))).toMatchObject({
      status: 'not-entitled',
    });
    expect(await probeCopilotEntitlement('t', reply(403))).toMatchObject({ status: 'unknown' });
    const offline = (async () => {
      throw new Error('ENOTFOUND');
    }) as unknown as typeof fetch;
    expect(await probeCopilotEntitlement('t', offline)).toMatchObject({ status: 'unknown' });
  });
});

describe('Copilot credential connection', () => {
  it('targets the plan host with the runtime placeholder and a bearer header', () => {
    expect(copilotCredentialTarget('https://api.enterprise.githubcopilot.com')).toEqual({
      name: 'GitHub Copilot',
      kind: 'api-key',
      host: 'api.enterprise.githubcopilot.com',
      proxyValue: 'nc-copilot-token-v1',
      injection: { headerName: 'Authorization', valueFormat: 'Bearer {value}' },
    });
  });
});

function harness(options: { stored?: boolean; token: string; entitlement?: CopilotEntitlement; confirm?: boolean }) {
  const log: string[] = [];
  const targets: GatewayCredentialTarget[] = [];
  const saved: Array<{ host: string; value: unknown }> = [];
  let apiUrl: string | undefined;
  const deps: CopilotAuthDeps = {
    root: '/tmp/nanoclaw-copilot-test',
    promptToken: async (canKeep) => {
      log.push(`prompt canKeep=${canKeep}`);
      return options.token;
    },
    confirm: async (message) => {
      log.push(`confirm ${message}`);
      return options.confirm ?? false;
    },
    info: () => {},
    probe: async () =>
      options.entitlement ?? { status: 'ok', apiUrl: 'https://api.githubcopilot.com', plan: 'individual' },
    connect: async (target) => {
      targets.push(target);
      const connection: GatewayCredentialConnection = {
        find: async () => (options.stored ? { reusable: true } : null),
        save: async (value) => {
          saved.push({ host: target.host, value });
        },
        keep: async () => {
          log.push(`keep ${target.host}`);
        },
      };
      return connection;
    },
    writeApiUrl: (url) => {
      apiUrl = url;
    },
  };
  return { deps, log, targets, saved, apiUrl: () => apiUrl };
}

describe('Copilot setup step', () => {
  it('stores a new token in the gateway on its plan host and records that API', async () => {
    const h = harness({
      token: 'github_pat_new',
      entitlement: { status: 'ok', apiUrl: 'https://api.business.githubcopilot.com', plan: 'business' },
    });
    await runCopilotAuthStep(h.deps);
    expect(h.saved).toEqual([{ host: 'api.business.githubcopilot.com', value: 'github_pat_new' }]);
    expect(h.apiUrl()).toBe('https://api.business.githubcopilot.com');
    expect(h.targets.every((target) => target.proxyValue === 'nc-copilot-token-v1')).toBe(true);
  });

  it('keeps a stored token when the operator leaves the prompt blank', async () => {
    const h = harness({ stored: true, token: '' });
    await runCopilotAuthStep(h.deps);
    expect(h.log).toContain('prompt canKeep=true');
    expect(h.log).toContain('keep api.githubcopilot.com');
    expect(h.saved).toEqual([]);
  });

  it('stores nothing for a rejected token, an account without Copilot, or a classic PAT', async () => {
    for (const [token, entitlement, message] of [
      ['github_pat_bad', { status: 'unauthorized' }, 'rejected'],
      [
        'github_pat_x',
        { status: 'not-entitled', reason: 'This account has no GitHub Copilot access.' },
        'no GitHub Copilot',
      ],
      ['ghp_classic', undefined, 'classic'],
    ] as const) {
      const h = harness({ token, entitlement: entitlement as CopilotEntitlement | undefined });
      await expect(runCopilotAuthStep(h.deps)).rejects.toThrow(message);
      expect(h.saved).toEqual([]);
    }
  });

  it('asks before storing a token whose plan cannot be read, and uses the default API if confirmed', async () => {
    const declined = harness({
      token: 'github_pat_x',
      entitlement: { status: 'unknown', reason: 'GitHub answered 403' },
    });
    await expect(runCopilotAuthStep(declined.deps)).rejects.toThrow('stopped before storing');
    expect(declined.saved).toEqual([]);

    const accepted = harness({
      token: 'github_pat_x',
      entitlement: { status: 'unknown', reason: 'GitHub answered 403' },
      confirm: true,
    });
    await runCopilotAuthStep(accepted.deps);
    expect(accepted.saved).toEqual([{ host: 'api.githubcopilot.com', value: 'github_pat_x' }]);
    expect(accepted.apiUrl()).toBe('https://api.githubcopilot.com');
  });
});
