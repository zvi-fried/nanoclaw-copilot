/**
 * The customer quickstart for GitHub Copilot (the add-copilot testing guide),
 * walked in its own order through the real setup and host code, with only the
 * edges mocked. Nothing here needs Docker, a Copilot plan or the network.
 *
 * Each scenario copies this checkout to a scratch directory, as an operator's
 * clone, and runs `setup/index.ts --step provider-auth copilot` there: the
 * real skill engine copies the payload and appends the barrels, the real
 * image-source switch and install check run, and the real Iron Proxy and
 * OneCLI adapters store the token. Mocked are only:
 *
 * - the prompts (`@clack/prompts`): scripted answers, the token validated by
 *   the real masked prompt's validator;
 * - the network (`fetch`): GitHub's plan endpoint, Iron Control's API and
 *   OneCLI's API are in-memory fakes, and any other request fails the test;
 * - the image build: the checkout's `container/build.sh` is a stub;
 * - the package manager: a `bun` stub that records the pin `bun add` writes;
 * - Iron Proxy's restart (`run --allow-host`, which drives Docker): recorded;
 * - the install-time contract verifier, which runs the whole build and test
 *   suite in the checkout (the skill's own checks run those separately).
 *
 * The runtime half of the quickstart (a message turn, the MCP servers, the
 * failure replies) runs under Bun in the agent runner:
 * payload/container/agent-runner/src/providers/copilot.quickstart.test.ts.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Each scenario copies a checkout and runs setup in it, a few seconds apiece.
vi.setConfig({ testTimeout: 30_000 });

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const SKILL = path.join(REPO, '.claude/skills/add-copilot');
const PLACEHOLDER = 'nc-copilot-token-v1';
const IRON_PORT = 10257;
const ONECLI_URL = 'http://127.0.0.1:10254';
const PRINCIPAL = 'prn_quickstart';
const INDIVIDUAL = 'api.githubcopilot.com';
const BUSINESS = 'api.business.githubcopilot.com';

// The quickstart's own words, quoted where it quotes the program.
const GUIDE = {
  imageQuestion: 'copilot needs a sandbox image built on this machine. Stop using the pre-built one?',
  successLine: 'Stored the Copilot credential in the credential gateway.',
  classic: 'GitHub Copilot does not accept classic personal access tokens (ghp_)',
  prefix: 'Enter a GitHub token (github_pat_, gho_ or ghu_).',
  spaces: 'A token has no spaces or line breaks.',
  rejected: 'GitHub rejected this token.',
  noCopilot: 'This account has no GitHub Copilot access.',
  chatDisabled: 'Copilot chat is disabled for this account (or by its organization).',
  plan403: "GitHub answered 403 when reading the Copilot plan. Continue with the individual plan's API",
  noGatewaySupport: 'The selected credential gateway does not support provider credentials.',
  noGateway: 'No installed gateway could be detected',
  incomplete: /^Copilot installation is incomplete: .+\. Refresh the provider skill\.$/,
  pin: 'Copilot dependency @github/copilot-sdk must match the skill pin 1.0.19',
  cannotInstall: "Couldn't install copilot: ",
  cannotBuild: "Couldn't rebuild the container image for copilot",
  unsetHardened: 'Unset exported NANOCLAW_HARDENED_IMAGE',
  kept: 'Kept the stored Copilot credential.',
};

const h = vi.hoisted(() => ({
  /** What the operator pastes at each masked prompt, in order. */
  tokens: [] as string[],
  /** Scripted answers to yes/no questions, matched by message. */
  confirms: [] as Array<{ match: string; answer: boolean }>,
  prompts: [] as Array<{ kind: 'password' | 'confirm'; message: string }>,
  /** Messages the masked prompt showed under a rejected paste before asking again. */
  rejected: [] as string[],
  output: [] as string[],
}));

const plain = (value: unknown) => String(value).replace(/\x1b\[[0-9;]*m/g, '');

vi.mock('@clack/prompts', async (original) => {
  const actual = await original<typeof import('@clack/prompts')>();
  const say = (message: unknown) => {
    h.output.push(plain(message));
  };
  return {
    ...actual,
    async password(options: { message: string; validate?: (value: string | undefined) => unknown }) {
      h.prompts.push({ kind: 'password', message: options.message });
      for (;;) {
        const value = h.tokens.shift();
        if (value === undefined) throw new Error(`unscripted token prompt: ${options.message}`);
        const problem = options.validate?.(value);
        if (!problem) return value;
        h.rejected.push(plain(problem instanceof Error ? problem.message : problem));
      }
    },
    async confirm(options: { message: string }) {
      h.prompts.push({ kind: 'confirm', message: options.message });
      const index = h.confirms.findIndex((entry) => options.message.includes(entry.match));
      if (index < 0) throw new Error(`unscripted question: ${options.message}`);
      return h.confirms.splice(index, 1)[0].answer;
    },
    log: { ...actual.log, info: say, message: say, success: say, step: say, warn: say, error: say },
    note: say,
    cancel: say,
  };
});

// ── The edges: GitHub, Iron Control, OneCLI ─────────────────────────────────

type Plan = { status: number; body?: unknown };

/** GitHub's plan endpoint, by token. */
const GITHUB: Record<string, Plan> = {
  individual: {
    status: 200,
    body: { chat_enabled: true, copilot_plan: 'individual', endpoints: { api: `https://${INDIVIDUAL}` } },
  },
  business: {
    status: 200,
    body: { chat_enabled: true, copilot_plan: 'business', endpoints: { api: `https://${BUSINESS}` } },
  },
  // A Copilot-Requests-only token on a business plan may not read the plan at all.
  forbidden: { status: 403, body: { message: 'Resource not accessible by personal access token' } },
  revoked: { status: 401, body: { message: 'Bad credentials' } },
  noplan: { status: 404, body: { message: 'Not Found' } },
  chatoff: { status: 200, body: { chat_enabled: false, copilot_plan: 'business' } },
};

/** A fine-grained token whose plan answer is `kind`. Random, so a leak is unambiguous. */
const token = (kind: keyof typeof GITHUB) => `github_pat_${kind}_${randomBytes(12).toString('hex')}`;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

/** Iron Control's REST API, in memory: static secrets, grants, the install's principal. */
class FakeIronControl {
  records = new Map<string, any>();
  values = new Map<string, string>();
  grants: any[] = [];

  handle(url: URL, method: string, body: any): Response {
    const resource = url.pathname.replace(/^\/api\/v1\//, '');
    const parts = resource.split('/');
    if (resource === `principals/${PRINCIPAL}/roles`) return json({ data: [] });
    if (resource === `principals/${PRINCIPAL}/grants`)
      return json({ data: url.searchParams.get('page') === '1' ? this.grants : [] });
    if (resource === 'grants' && method === 'POST') {
      this.grants.push(body.data);
      return json({ data: body.data });
    }
    if (parts[0] !== 'static_secrets') return new Response('', { status: 404 });
    if (method === 'GET') {
      const record =
        parts[1] === 'lookup'
          ? [...this.records.values()].find((r) => r.namespace === parts[2] && r.foreign_id === parts[3])
          : [...this.records.values()].find((r) => r.id === decodeURIComponent(parts[1]));
      return record ? json({ data: structuredClone(record) }) : new Response('', { status: 404 });
    }
    if (method === 'PUT') {
      // An opaque id updates (404 once gone); a foreign id upserts.
      const byId = [...this.records.values()].find((r) => r.id === parts[1]);
      if (parts[1].startsWith('ssr_') && !byId) return new Response('', { status: 404 });
      const foreignId = byId?.foreign_id ?? parts[1];
      const id = byId?.id ?? this.records.get(foreignId)?.id ?? `ssr_${this.records.size + 1}`;
      const { source, ...rest } = body.data;
      if (source.secret !== undefined) this.values.set(id, source.secret);
      const record = {
        ...rest,
        id,
        foreign_id: foreignId,
        source: { source_type: source.source_type, config: source.config },
      };
      this.records.set(foreignId, record);
      return json({ data: structuredClone(record) });
    }
    return new Response('', { status: 405 });
  }
}

/** OneCLI's secrets API, in memory. */
class FakeOneCli {
  rows: any[] = [];
  values = new Map<string, string>();
  writes: any[] = [];

  handle(url: URL, method: string, body: any): Response {
    const id = url.pathname.match(/^\/v1\/secrets\/(.+)$/)?.[1];
    if (method === 'GET' && url.pathname === '/v1/secrets') return json(this.rows);
    if (method === 'POST' && url.pathname === '/v1/secrets') {
      this.writes.push({ method, body });
      const { value, ...metadata } = body;
      const row = { ...metadata, id: `sec_${this.rows.length + 1}`, scope: 'project' };
      this.values.set(row.id, value);
      this.rows.push(row);
      return json({ id: row.id, preview: `${String(value).slice(0, 4)}…` });
    }
    if (method === 'PATCH' && id) {
      this.writes.push({ method, id, body });
      const row = this.rows.find((r) => r.id === id);
      if (!row) return new Response('', { status: 404 });
      const { value, ...metadata } = body;
      Object.assign(row, metadata);
      if (value !== undefined) this.values.set(id, value);
      return json({ id });
    }
    return new Response('', { status: 404 });
  }
}

let iron: FakeIronControl;
let onecli: FakeOneCli;
let githubCalls: Array<{ url: string; authorization: string | null }>;
let fenced: string[];

async function fakeFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = (init.method ?? 'GET').toUpperCase();
  const headers = new Headers(init.headers);
  const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
  if (url.href === 'https://api.github.com/copilot_internal/user') {
    const authorization = headers.get('authorization');
    githubCalls.push({ url: url.href, authorization });
    const kind = authorization?.match(/^token github_pat_([a-z]+)_/)?.[1] ?? '';
    const plan = GITHUB[kind] ?? GITHUB.revoked;
    return json(plan.body ?? {}, plan.status);
  }
  if (url.origin === `http://127.0.0.1:${IRON_PORT}` && url.pathname.startsWith('/api/v1/')) {
    expect(headers.get('authorization')).toBe('Bearer fixture-iron-admin');
    return iron.handle(url, method, body);
  }
  if (url.origin === ONECLI_URL) return onecli.handle(url, method, body);
  fenced.push(url.href);
  throw new Error(`The quickstart test has no network: ${method} ${url.href}`);
}

// ── An operator's checkout ──────────────────────────────────────────────────

const checkouts: string[] = [];

/**
 * A copy of this checkout (tracked and new files), as an operator's clone
 * before /add-copilot. It sits in a git-ignored `.tmp-*` directory inside this
 * one: Vitest resolves the setup step's runtime `import()` of the installed
 * module only under its own root.
 */
function checkout(env: Record<string, string>): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(REPO, '.tmp-copilot-quickstart-')));
  checkouts.push(root);
  const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: REPO, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
  for (const file of files) {
    const from = path.join(REPO, file);
    const to = path.join(root, file);
    if (!fs.existsSync(from)) continue;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (fs.lstatSync(from).isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(from), to);
    else fs.copyFileSync(from, to);
  }
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(root, 'node_modules'));
  // The image build and the package manager are the only processes setup starts here.
  fs.writeFileSync(
    path.join(root, 'container/build.sh'),
    '#!/bin/sh\necho build "$@" >> "$(dirname "$0")/../.edge-calls"\nexit "${QUICKSTART_BUILD_EXIT:-0}"\n',
    { mode: 0o755 },
  );
  const bin = path.join(root, '.edge-bin');
  fs.mkdirSync(bin);
  const pinnedBun = fs
    .readFileSync(path.join(root, 'container/Dockerfile'), 'utf8')
    .match(/^ARG BUN_VERSION=(\S+)$/m)![1];
  fs.writeFileSync(
    path.join(bin, 'bun'),
    `#!/bin/sh
case "$1" in
  --version) echo ${pinnedBun} ;;
  add) shift; echo "bun add $* (in $(basename "$PWD"))" >> "$(dirname "$0")/../.edge-calls"
    node -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync("package.json","utf8"));for(const s of process.argv.slice(1)){const at=s.lastIndexOf("@");(p.dependencies??={})[s.slice(0,at)]=s.slice(at+1)}fs.writeFileSync("package.json",JSON.stringify(p,null,2)+"\\n")' "$@" ;;
  *) echo "unexpected: bun $*" >&2; exit 1 ;;
esac
`,
    { mode: 0o755 },
  );
  // Iron Control as its installer leaves it: this install's principal and the admin key.
  const control = path.join(root, 'data/session-materials/iron-control');
  fs.mkdirSync(control, { recursive: true });
  fs.writeFileSync(path.join(control, 'registration.json'), JSON.stringify({ principalId: PRINCIPAL }));
  fs.writeFileSync(path.join(control, 'control.env'), 'IRON_CONTROL_INITIAL_API_KEY=fixture-iron-admin\n');
  fs.writeFileSync(
    path.join(root, '.env'),
    Object.entries(env)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(''),
  );
  return root;
}

/**
 * The same checkout in a new process, as the operator's next command runs.
 * Vitest keeps each file's first transform for the whole run, so a module a
 * setup step appended to (a barrel) is read fresh only under a new path.
 */
function reopen(root: string): string {
  const next = fs.realpathSync(fs.mkdtempSync(path.join(REPO, '.tmp-copilot-quickstart-')));
  checkouts.push(next);
  fs.cpSync(root, next, { recursive: true, verbatimSymlinks: true });
  vi.stubEnv('PATH', `${path.join(next, '.edge-bin')}${path.delimiter}${process.env.PATH}`);
  return next;
}

const edgeCalls = (root: string) =>
  fs.existsSync(path.join(root, '.edge-calls'))
    ? fs.readFileSync(path.join(root, '.edge-calls'), 'utf8').trim().split('\n')
    : [];
const envFile = (root: string) => fs.readFileSync(path.join(root, '.env'), 'utf8');

/** Every file under the checkout that contains `needle` (the shared node_modules aside). */
function filesContaining(root: string, needle: string): string[] {
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink() || entry.name === '.git') continue;
      if (entry.isDirectory()) walk(file);
      else if (fs.readFileSync(file).includes(needle)) hits.push(path.relative(root, file));
    }
  };
  walk(root);
  return hits;
}

const ironAllowedHosts: string[] = [];

/**
 * Load the checkout's own setup, as `pnpm exec tsx setup/index.ts` would from
 * its root, with the two in-process edges replaced.
 */
async function loadSetup(root: string) {
  vi.resetModules();
  vi.doMock(path.join(root, 'scripts/provider-contract-verifier.ts'), async (original) => ({
    ...(await original<object>()),
    verifyProviderContracts: async () => ({ status: 'passed', checks: ['stubbed in the quickstart test'] }),
  }));
  vi.doMock(path.join(root, '.claude/skills/add-iron-proxy/scripts/setup.ts'), async (original) => ({
    ...(await original<object>()),
    run: async (args: string[]) => {
      expect(args[0]).toBe('--allow-host');
      ironAllowedHosts.push(args[1]);
    },
  }));
  process.chdir(root);
  const { run } = (await import(path.join(root, 'setup/provider-auth.ts'))) as {
    run: (args: string[]) => Promise<void>;
  };
  return run;
}

/** `pnpm exec tsx setup/index.ts --step provider-auth copilot [...flags]`, as setup/index.ts dispatches it. */
async function providerAuth(root: string, ...flags: string[]): Promise<void> {
  const run = await loadSetup(root);
  await run(['copilot', ...flags]);
}

/** The message the step fails with, as setup/index.ts reports it (or the process.exit line). */
async function providerAuthFails(root: string, ...flags: string[]): Promise<string> {
  try {
    await providerAuth(root, ...flags);
  } catch (error) {
    const message = (error as Error).message;
    return message === 'process.exit' ? h.output.filter(Boolean).at(-1)! : message;
  }
  throw new Error('provider-auth succeeded');
}

const realCwd = process.cwd();
beforeEach(() => {
  Object.assign(h, { tokens: [], confirms: [], prompts: [], rejected: [], output: [] });
  iron = new FakeIronControl();
  onecli = new FakeOneCli();
  githubCalls = [];
  fenced = [];
  ironAllowedHosts.length = 0;
  vi.stubGlobal('fetch', fakeFetch);
  for (const key of ['COPILOT_API_URL', 'NANOCLAW_HARDENED_IMAGE', 'NANOCLAW_GATEWAY_PROVIDER', 'ONECLI_URL'])
    vi.stubEnv(key, undefined as unknown as string);
  vi.stubEnv('NANOCLAW_INSTALL_ID', 'quickstart');
  vi.spyOn(console, 'log').mockImplementation((...args) => void h.output.push(plain(args.join(' '))));
  vi.spyOn(console, 'error').mockImplementation((...args) => void h.output.push(plain(args.join(' '))));
  vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('process.exit');
  });
});
afterEach(() => {
  process.chdir(realCwd);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  expect(fenced).toEqual([]);
  for (const root of checkouts.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** A checkout set up for the test (quickstart §3): the local CLI channel, Claude, a gateway. */
function installWith(gateway: string, extra: Record<string, string> = {}): string {
  const root = checkout({
    NANOCLAW_GATEWAY_PROVIDER: gateway,
    ...(gateway === 'onecli' ? { ONECLI_URL } : {}),
    ...extra,
  });
  vi.stubEnv('PATH', `${path.join(root, '.edge-bin')}${path.delimiter}${process.env.PATH}`);
  return root;
}

/** The payload copies SKILL.md declares, as [source, destination]. */
function declaredCopies(): Array<[string, string]> {
  const markdown = fs.readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8');
  const block = markdown.match(/```nc:copy[^\n]*\n([\s\S]*?)```/)![1];
  return block
    .trim()
    .split('\n')
    .map((line) => line.split('->').map((part) => part.trim()) as [string, string]);
}

const BARRELS = [
  'src/providers/index.ts',
  'src/provider-contracts/index.ts',
  'container/agent-runner/src/providers/index.ts',
  'container/agent-runner/src/provider-contracts/index.ts',
  'setup/providers/index.ts',
];

// ── §4 Install Copilot and authenticate ─────────────────────────────────────

describe('quickstart §4: pnpm exec tsx setup/index.ts --step provider-auth copilot', () => {
  it('installs the skill from the pre-built image, rebuilds, reads the plan and stores the token only in Iron', async () => {
    const root = installWith('iron-proxy', { NANOCLAW_HARDENED_IMAGE: 'true' });
    const secret = token('individual');
    h.confirms.push({ match: 'needs a sandbox image', answer: true });
    // A classic token first: the masked prompt refuses it and asks again.
    h.tokens.push(`ghp_${randomBytes(18).toString('hex')}`, secret);

    await providerAuth(root);

    // 1. The payload: every declared file, the five barrels, the exact SDK pin.
    for (const [from, to] of declaredCopies())
      expect(fs.readFileSync(path.join(root, to), 'utf8')).toBe(fs.readFileSync(path.join(SKILL, from), 'utf8'));
    for (const barrel of BARRELS)
      expect(fs.readFileSync(path.join(root, barrel), 'utf8').split('\n')).toContain("import './copilot.js';");
    const runner = JSON.parse(fs.readFileSync(path.join(root, 'container/agent-runner/package.json'), 'utf8'));
    expect(runner.dependencies['@github/copilot-sdk']).toBe('1.0.19');
    // The pre-built image question, worded as the quickstart quotes it, answered yes.
    expect(h.prompts[0]).toEqual({ kind: 'confirm', message: GUIDE.imageQuestion });
    expect(envFile(root)).toMatch(/^NANOCLAW_HARDENED_IMAGE=false$/m);
    // 2. One image rebuild, after the dependency was added.
    expect(edgeCalls(root)).toEqual(['bun add @github/copilot-sdk@1.0.19 (in agent-runner)', 'build']);

    // 3. A masked prompt; the classic token refused with the quoted message.
    expect(h.prompts[1].kind).toBe('password');
    expect(h.rejected).toHaveLength(1);
    expect(h.rejected[0]).toContain(GUIDE.classic);
    expect(h.rejected[0]).toBe(
      'GitHub Copilot does not accept classic personal access tokens (ghp_). Create a fine-grained token with the "Copilot Requests" permission.',
    );
    // The plan is read on the host, from api.github.com, with the pasted token.
    expect(githubCalls).toEqual([
      { url: 'https://api.github.com/copilot_internal/user', authorization: `token ${secret}` },
    ]);
    expect(h.output).toContain(`Copilot plan: individual (${INDIVIDUAL}).`);

    // 4. One Iron connection "GitHub Copilot": the plan's host, Authorization, the placeholder.
    const records = [...iron.records.values()];
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      namespace: 'quickstart',
      name: 'GitHub Copilot',
      inject_config: {},
      replace_config: { proxy_value: PLACEHOLDER, match_headers: ['Authorization'], require: false },
      rules: [{ host: INDIVIDUAL, http_methods: ['*'] }],
      source: { source_type: 'control_plane', config: {} },
    });
    expect(iron.values.get(records[0].id)).toBe(secret);
    expect(iron.grants).toEqual([{ principal_id: PRINCIPAL, static_secret_id: records[0].id }]);
    expect(ironAllowedHosts).toEqual([INDIVIDUAL]);
    // COPILOT_API_URL in .env, and the token nowhere on disk, in the environment or in the output.
    expect(envFile(root)).toMatch(new RegExp(`^COPILOT_API_URL=https://${INDIVIDUAL}$`, 'm'));
    expect(filesContaining(root, secret)).toEqual([]);
    expect(Object.values(process.env).filter((value) => value?.includes(secret))).toEqual([]);
    expect(h.output.join('\n')).not.toContain(secret);

    // 5. The install check passed, and the last line is the one the quickstart expects.
    expect(h.output.filter(Boolean).at(-1)).toBe(GUIDE.successLine);
  });

  it('keeps the stored token on a blank re-run, and rotates it in place when a new one is pasted', async () => {
    const installed = installWith('iron-proxy');
    const first = token('individual');
    h.tokens.push(first);
    await providerAuth(installed);
    const [record] = iron.records.values();

    // Re-runs authenticate the installed payload: no second install or build.
    const rerun = reopen(installed);
    h.tokens.push('');
    h.output.length = 0;
    await providerAuth(rerun);
    expect(h.prompts.at(-1)?.message).toContain('leave blank to keep the stored one');
    expect(h.output).not.toContain('Installing copilot…');
    expect(h.output.filter(Boolean).at(-1)).toBe(GUIDE.kept);
    expect(iron.values.get(record.id)).toBe(first);
    expect(githubCalls).toHaveLength(1);

    const rotate = reopen(rerun);
    const second = token('individual');
    h.tokens.push(second);
    await providerAuth(rotate);
    expect([...iron.records.values()].map((r) => r.id)).toEqual([record.id]);
    expect(iron.values.get(record.id)).toBe(second);
    expect(edgeCalls(rotate).filter((call) => call.startsWith('build'))).toHaveLength(1);
    expect(filesContaining(rotate, first)).toEqual([]);
    expect(filesContaining(rotate, second)).toEqual([]);
  });

  it('keeps the stored token on a blank re-run with OneCLI too', async () => {
    const installed = installWith('onecli');
    h.tokens.push(token('individual'));
    await providerAuth(installed);
    h.tokens.push('');
    await providerAuth(reopen(installed));
    expect(h.output.filter(Boolean).at(-1)).toBe(GUIDE.kept);
    expect(onecli.writes.map((write) => write.method)).toEqual(['POST']);
  });

  it('connects a business plan on its own host, the one GitHub declares', async () => {
    const root = installWith('iron-proxy');
    h.tokens.push(token('business'));
    await providerAuth(root);
    expect(h.output).toContain(`Copilot plan: business (${BUSINESS}).`);
    expect([...iron.records.values()][0].rules).toEqual([{ host: BUSINESS, http_methods: ['*'] }]);
    expect(envFile(root)).toMatch(new RegExp(`^COPILOT_API_URL=https://${BUSINESS}$`, 'm'));
  });

  it('on a 403 from the plan lookup, asks, then falls back to the individual host (wrong for business plans)', async () => {
    const root = installWith('iron-proxy');
    // The account is on a business plan, but this token cannot read the plan.
    h.tokens.push(token('forbidden'));
    h.confirms.push({ match: 'answered 403', answer: true });
    await providerAuth(root);
    expect(h.prompts.at(-1)).toEqual({
      kind: 'confirm',
      message: `${GUIDE.plan403} (${INDIVIDUAL})?`,
    });
    // The individual host is connected even though the plan is business: the
    // quickstart asks business testers to report this.
    expect([...iron.records.values()][0].rules).toEqual([{ host: INDIVIDUAL, http_methods: ['*'] }]);
    expect(envFile(root)).toMatch(new RegExp(`^COPILOT_API_URL=https://${INDIVIDUAL}$`, 'm'));
    expect(h.output.filter(Boolean).at(-1)).toBe(GUIDE.successLine);

    // Answering no stores nothing.
    const declined = installWith('iron-proxy');
    iron = new FakeIronControl();
    h.tokens.push(token('forbidden'));
    h.confirms.push({ match: 'answered 403', answer: false });
    expect(await providerAuthFails(declined)).toBe('Copilot setup stopped before storing the token.');
    expect(iron.records.size).toBe(0);
    expect(envFile(declined)).not.toContain('COPILOT_API_URL');
  });

  it('stores the token in OneCLI as one host-scoped secret, never on disk', async () => {
    const root = installWith('onecli');
    const secret = token('individual');
    h.tokens.push(secret);
    await providerAuth(root);
    expect(onecli.writes).toEqual([
      {
        method: 'POST',
        body: {
          name: 'GitHub Copilot',
          type: 'generic',
          valueSource: 'inline',
          hostPattern: INDIVIDUAL,
          value: secret,
          injectionConfig: { headerName: 'Authorization', valueFormat: 'Bearer {value}' },
        },
      },
    ]);
    expect(filesContaining(root, secret)).toEqual([]);
    expect(envFile(root)).toMatch(new RegExp(`^COPILOT_API_URL=https://${INDIVIDUAL}$`, 'm'));
    expect(h.output.filter(Boolean).at(-1)).toBe(GUIDE.successLine);
  });
});

// ── §5 Switch a group to Copilot ────────────────────────────────────────────

describe('quickstart §5: ncl groups config update --id <group-id> --provider copilot', () => {
  it('switches the group to copilot; its container gets the plan host and no token; state lands in .copilot-shared', async () => {
    const installed = installWith('iron-proxy');
    const secret = token('business');
    h.tokens.push(secret);
    await providerAuth(installed);

    // The host restarts after setup: a fresh process loads the installed barrels.
    const root = reopen(installed);
    process.chdir(root);
    vi.resetModules();
    vi.doMock(path.join(root, 'src/container-runner.ts'), () => ({
      wakeContainer: vi.fn(),
      isContainerRunning: vi.fn(() => false),
      getActiveContainerCount: vi.fn(() => 0),
      killContainer: vi.fn(),
      buildAgentGroupImage: vi.fn(),
    }));
    vi.doMock(path.join(root, 'src/container-restart.ts'), () => ({
      restartAgentGroupContainers: vi.fn(async () => 1),
    }));
    // By path, not file URL: Vitest resolves a module's relative imports from the id it was loaded by.
    const load = (file: string) => import(path.join(root, file));
    const db = await load('src/db/index.ts');
    await db.runMigrations(await db.initTestDb());
    await load('src/providers/index.ts');
    await load('src/provider-contracts/index.ts');
    await load('src/cli/resources/index.ts');
    const { parseArgv } = await load('src/cli/parse-argv.ts');
    const { dispatch } = await load('src/cli/dispatch.ts');
    const { ensureContainerConfig } = await load('src/db/container-configs.ts');
    const ncl = async (...argv: string[]) => {
      const { command, args } = parseArgv(argv);
      const response = await dispatch({ id: argv.join(' '), command, args }, { caller: 'host' });
      if (!response.ok) throw new Error(response.error.message);
      return response.data;
    };
    try {
      const gid = 'ag-cli';
      await db.createAgentGroup({ id: gid, name: 'cli', folder: 'cli', agent_provider: null, created_at: '' });
      await ensureContainerConfig(gid);

      expect((await ncl('groups', 'config', 'update', '--id', gid, '--provider', 'copilot')).provider).toBe('copilot');
      expect(await ncl('groups', 'restart', '--id', gid)).toMatchObject({ restarted: 1 });
      expect((await ncl('groups', 'config', 'get', '--id', gid)).provider).toBe('copilot');

      // What the host hands a copilot container: the plan's API, never the token.
      const { getProviderContainerConfig } = await load('src/providers/provider-container-registry.ts');
      const contribution = getProviderContainerConfig('copilot')({
        sessionDir: path.join(root, 'data/v2-sessions', gid, 'sess'),
        agentGroupId: gid,
        groupDir: path.join(root, 'groups/cli'),
        selectedSkills: [],
        hostEnv: process.env,
        coreOwnsProviderSurfaces: true,
      });
      expect(contribution.env).toEqual({ COPILOT_API_URL: `https://${BUSINESS}` });
      expect(JSON.stringify(contribution)).not.toContain(secret);

      // The host contract: Copilot's model domain, and its session state under data/v2-sessions/<group-id>/.
      const { getProviderHostContract } = await load('src/provider-contracts/registry.ts');
      const { providerStateVolumePath } = await load('src/provider-contracts/realize.ts');
      const contract = getProviderHostContract('copilot');
      expect(contract.modelDomains).toEqual(['githubcopilot.com']);
      expect(contract.modelEndpoints).toEqual({ api: `https://${BUSINESS}` });
      const home = contract.stateVolumes.find((volume: { id: string }) => volume.id === 'copilot-home');
      expect(home.containerPath).toBe('/home/node/.copilot');
      expect(providerStateVolumePath(home, gid)).toBe(path.join(root, 'data/v2-sessions', gid, '.copilot-shared'));

      // Rolling back is the same command with claude.
      expect((await ncl('groups', 'config', 'update', '--id', gid, '--provider', 'claude')).provider).toBe('claude');
    } finally {
      await db.closeDb();
    }
  });
});

// ── §7 Troubleshooting, setup side ──────────────────────────────────────────

describe('quickstart §7: each setup-side symptom, as the guide words it', () => {
  it('refuses a classic token, a wrong prefix and a paste with a space at the masked prompt', async () => {
    const root = installWith('iron-proxy');
    h.tokens.push('ghp_abc123', 'xoxb-not-github', '"github_pat_quoted', 'github_pat_a b', token('individual'));
    await providerAuth(root);
    expect(h.rejected[0]).toContain(GUIDE.classic);
    expect(h.rejected[1]).toBe(GUIDE.prefix);
    expect(h.rejected[2]).toBe(GUIDE.prefix);
    expect(h.rejected[3]).toBe(GUIDE.spaces);
  });

  it.each([
    ['revoked', 'a 401', GUIDE.rejected],
    ['noplan', 'a 404', GUIDE.noCopilot],
    ['chatoff', 'chat turned off', GUIDE.chatDisabled],
  ] as const)('a %s token (%s) stops setup with the quoted message and stores nothing', async (kind, _why, quoted) => {
    const root = installWith('iron-proxy');
    h.tokens.push(token(kind));
    const message = await providerAuthFails(root);
    expect(message.startsWith(quoted)).toBe(true);
    expect(iron.records.size).toBe(0);
    expect(envFile(root)).not.toContain('COPILOT_API_URL');
  });

  it('names the gateway problem: none installed, or one without provider credentials', async () => {
    // No gateway selected and none detected (the detectors find nothing in this checkout).
    const none = checkout({});
    vi.stubEnv('PATH', `${path.join(none, '.edge-bin')}${path.delimiter}${process.env.PATH}`);
    h.tokens.push(token('individual'));
    expect(await providerAuthFails(none)).toContain(GUIDE.noGateway);

    // A gateway whose credential store has no provider connections.
    const legacy = installWith('legacy-vault');
    const skill = path.join(legacy, '.claude/skills/add-legacy-vault');
    fs.mkdirSync(path.join(skill, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: add-legacy-vault\ndescription: fixture\n---\n');
    fs.writeFileSync(
      path.join(skill, 'gateway.json'),
      JSON.stringify({ kind: 'legacy-vault', label: 'Legacy', description: 'A gateway without connections.' }),
    );
    fs.writeFileSync(
      path.join(skill, 'scripts/credential-store.ts'),
      'export const createCredentialStore = () => ({ has: async () => false, save: async () => {} });\n',
    );
    h.tokens.push(token('individual'));
    expect(await providerAuthFails(legacy)).toBe(GUIDE.noGatewaySupport);
  }, 60_000); // Gateway detection starts each gateway skill's detector as a process.

  it('reports an incomplete install or a moved pin after auth, and --refresh repairs both', async () => {
    const installed = installWith('iron-proxy');
    h.tokens.push(token('individual'));
    await providerAuth(installed);

    const missing = reopen(installed);
    fs.rmSync(path.join(missing, 'container/agent-runner/src/providers/copilot-memory.ts'));
    h.tokens.push('');
    expect(await providerAuthFails(missing)).toMatch(GUIDE.incomplete);

    const moved = reopen(installed);
    const manifest = path.join(moved, 'container/agent-runner/package.json');
    const runner = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    runner.dependencies['@github/copilot-sdk'] = '^1.0.19';
    fs.writeFileSync(manifest, JSON.stringify(runner, null, 2));
    h.tokens.push('');
    expect(await providerAuthFails(moved)).toBe(`${GUIDE.pin}. Refresh the provider skill.`);

    // The guide's fix: provider-auth copilot --refresh, here with both problems at once.
    const both = reopen(moved);
    fs.rmSync(path.join(both, 'container/agent-runner/src/providers/copilot-memory.ts'));
    h.tokens.push('');
    h.output.length = 0;
    await providerAuth(both, '--refresh');
    expect(h.output).toContain('Refreshing copilot…');
    expect(
      JSON.parse(fs.readFileSync(path.join(both, 'container/agent-runner/package.json'), 'utf8')).dependencies[
        '@github/copilot-sdk'
      ],
    ).toBe('1.0.19');
    expect(fs.existsSync(path.join(both, 'container/agent-runner/src/providers/copilot-memory.ts'))).toBe(true);
    expect(h.output.filter(Boolean).at(-1)).toBe(GUIDE.kept);
  });

  it("refuses to install on a core without the provider seams (Couldn't install copilot)", async () => {
    const root = installWith('iron-proxy');
    const registry = path.join(root, 'src/provider-contracts/registry.ts');
    fs.writeFileSync(
      registry,
      fs
        .readFileSync(registry, 'utf8')
        .replace('PROVIDER_HOST_CONTRACT_SEAM_VERSION = 1', 'PROVIDER_HOST_CONTRACT_SEAM_VERSION = 0'),
    );
    h.tokens.push(token('individual'));
    const message = await providerAuthFails(root);
    expect(message).toContain(GUIDE.cannotInstall);
    expect(message).toContain('copilot_core_ready');
    expect(fs.existsSync(path.join(root, 'scripts/copilot-auth.ts'))).toBe(false);
    expect(edgeCalls(root)).toEqual([]);
    expect(iron.records.size).toBe(0);
  });

  it("stops before auth when the image build fails (Couldn't rebuild the container image)", async () => {
    const root = installWith('iron-proxy');
    vi.stubEnv('QUICKSTART_BUILD_EXIT', '1');
    h.tokens.push(token('individual'));
    expect(await providerAuthFails(root)).toBe(
      'The build output above has the reason. Docker must be running, and the build needs network access to fetch base layers.',
    );
    expect(h.output).toContain(`${GUIDE.cannotBuild}: The container image build failed (exit 1).`);
    expect(h.prompts.filter((prompt) => prompt.kind === 'password')).toEqual([]);
    expect(iron.records.size).toBe(0);
  });

  it('asks to unset an exported NANOCLAW_HARDENED_IMAGE=true before changing anything', async () => {
    const root = installWith('iron-proxy', { NANOCLAW_HARDENED_IMAGE: 'true' });
    vi.stubEnv('NANOCLAW_HARDENED_IMAGE', 'true');
    expect(await providerAuthFails(root)).toContain(GUIDE.unsetHardened);
    expect(fs.existsSync(path.join(root, 'scripts/copilot-auth.ts'))).toBe(false);
  });
});
