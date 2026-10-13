/**
 * Runs the provider's real setup step (scripts/copilot-auth.ts) for the e2e,
 * from an applied checkout: `pnpm exec tsx <this file>`.
 *
 * Only the edges are local: the "pasted" token is E2E_REAL_TOKEN, the plan
 * probe reaches the fake Copilot API, and the gateway connection is a
 * stand-alone Iron Proxy configured from its native config file instead of
 * through Iron Control. The connection maps the setup's credential target to
 * the same Iron secret Iron Control creates for it (replace mode on the
 * placeholder, Authorization header, require false, one host rule) and adds
 * the host to Iron's allowlist, as the add-iron-proxy adapter does.
 *
 * Env: E2E_DIR (work directory), E2E_REAL_TOKEN, E2E_CA, E2E_PORT,
 * E2E_IRON_PORT, E2E_ROUTER_PORT.
 */
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';

import { probeCopilotEntitlement, runCopilotAuthStep } from '../../../../scripts/copilot-auth.js';
import type {
  GatewayCredentialConnection,
  GatewayCredentialTarget,
} from '../../../../setup/gateways/credential-store.js';
import { upsertEnvVar } from '../../../../setup/set-env.js';

const dir = process.env.E2E_DIR!;
const token = process.env.E2E_REAL_TOKEN!;

/** fetch for the probe: TLS to the fake API, verified against the e2e CA under the real hostname. */
const fetchViaFake = ((input: string, init: RequestInit = {}) =>
  new Promise<Response>((resolve, reject) => {
    const url = new URL(input);
    const req = https.request(
      {
        host: '127.0.0.1',
        port: Number(process.env.E2E_PORT ?? 18443),
        servername: url.hostname,
        path: url.pathname,
        method: 'GET',
        headers: { ...(init.headers as Record<string, string>), host: url.hostname },
        ca: fs.readFileSync(process.env.E2E_CA!),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode })));
      },
    );
    req.on('error', reject);
    req.end();
  })) as unknown as typeof fetch;

function ironConnection(target: GatewayCredentialTarget): GatewayCredentialConnection {
  if (target.kind !== 'api-key') throw new Error('the e2e stores only api-key credentials');
  const env = path.join(dir, 'iron.env');
  return {
    find: async () => (fs.existsSync(env) ? { reusable: true } : null),
    keep: async () => {},
    async save(value) {
      if (typeof value !== 'string') throw new Error('expected a token');
      // The secret's value goes only to the proxy's own environment file.
      fs.writeFileSync(env, `COPILOT_E2E_SECRET=${value}\n`, { mode: 0o600 });
      fs.writeFileSync(
        path.join(dir, 'iron.yaml'),
        `dns:
  enabled: false
proxy:
  http_listen: "127.0.0.1:0"
  https_listen: "127.0.0.1:0"
  tunnel_listen: "127.0.0.1:${process.env.E2E_IRON_PORT ?? 18447}"
  upstream_deny_cidrs: []
  upstream_proxy:
    http_proxy: "http://127.0.0.1:${process.env.E2E_ROUTER_PORT ?? 18444}"
    https_proxy: "http://127.0.0.1:${process.env.E2E_ROUTER_PORT ?? 18444}"
tls:
  mode: mitm
  ca_cert: "${path.join(dir, 'iron-ca.crt')}"
  ca_key: "${path.join(dir, 'iron-ca.key')}"
transforms:
  - name: allowlist
    config:
      domains: [${JSON.stringify(target.host)}]
  - name: secrets
    config:
      secrets:
        - source: { type: env, var: COPILOT_E2E_SECRET }
          replace:
            proxy_value: ${JSON.stringify(target.proxyValue)}
            match_headers: [${JSON.stringify(target.injection.headerName)}]
            require: false
          rules: [{ host: ${JSON.stringify(target.host)}, methods: ["*"] }]
metrics:
  listen: "127.0.0.1:0"
log:
  level: warn
`,
      );
    },
  };
}

await runCopilotAuthStep({
  root: dir,
  promptToken: async () => token,
  confirm: async () => false,
  info: (message) => console.log(`[setup] ${message}`),
  probe: (value) => probeCopilotEntitlement(value, fetchViaFake),
  connect: async (target) => ironConnection(target),
  writeApiUrl: (apiUrl, root) => upsertEnvVar('COPILOT_API_URL', apiUrl, root),
});
console.log('[setup] done');
