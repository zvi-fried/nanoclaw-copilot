#!/usr/bin/env bash
# End-to-end check of the Copilot provider's credential path through Iron Proxy.
#
# Run from the root of a checkout with /add-copilot applied (runner deps installed):
#   .claude/skills/add-copilot/e2e/gateway-injection.sh
#
# 1. The provider's setup step stores a (test) GitHub token: it reads the plan
#    from the fake Copilot API and hands the credential target to an Iron Proxy
#    connection, which writes Iron's native secret config.
# 2. A pinned Iron Proxy (built from the add-iron-proxy skill's pinned source,
#    or IRON_PROXY_BIN) starts with that config. Its upstream is a local fake of
#    GitHub's Copilot API, reached through a router that refuses other hosts.
# 3. The runner's poll loop drives the real Copilot runtime with only the
#    placeholder, through Iron: a streamed reply, a built-in tool, a skill and
#    memory. (MCP under Copilot auth needs GitHub's MCP policy, which the fake
#    does not reproduce; copilot.native.test.ts covers the MCP wiring.)
# 4. The fake API's log must show the injected token on every API request and
#    the placeholder nowhere upstream on the connected host.
#
# Needs: node, bun, pnpm, openssl, and go when IRON_PROXY_BIN is unset.
set -euo pipefail

ROOT=$(pwd)
HERE=$(cd "$(dirname "$0")" && pwd)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/copilot-gateway-e2e.XXXXXX")
export E2E_DIR=$WORK E2E_PORT=${E2E_PORT:-18443} E2E_ROUTER_PORT=${E2E_ROUTER_PORT:-18444} E2E_IRON_PORT=${E2E_IRON_PORT:-18447}
export E2E_LOG=$WORK/upstream.jsonl E2E_DESTINATION=discord-test
# A fake fine-grained token: the fake API accepts exactly this value.
export E2E_REAL_TOKEN="github_pat_E2E$(openssl rand -hex 16)"
PIDS=()
cleanup() {
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
  if [ -z "${KEEP_E2E_DIR:-}" ]; then rm -rf "$WORK"; else echo "kept $WORK"; fi
}
trap cleanup EXIT
step() { printf '\n==> %s\n' "$*"; }

step "certificates"
cd "$WORK"
openssl req -x509 -newkey rsa:2048 -nodes -keyout iron-ca.key -out iron-ca.crt -days 1 -subj "/CN=e2e Iron CA" \
  -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
openssl req -x509 -newkey rsa:2048 -nodes -keyout upstream-ca.key -out upstream-ca.crt -days 1 -subj "/CN=e2e upstream CA" \
  -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
openssl req -newkey rsa:2048 -nodes -keyout upstream.key -out upstream.csr -subj "/CN=api.github.com" 2>/dev/null
printf 'subjectAltName=DNS:api.github.com,DNS:githubcopilot.com,DNS:*.githubcopilot.com\nextendedKeyUsage=serverAuth\n' > upstream.ext
openssl x509 -req -in upstream.csr -CA upstream-ca.crt -CAkey upstream-ca.key -CAcreateserial -out upstream.crt -days 1 \
  -extfile upstream.ext 2>/dev/null
export E2E_CA=$WORK/upstream-ca.crt E2E_CERT=$WORK/upstream.crt E2E_KEY=$WORK/upstream.key

step "iron proxy"
IRON=${IRON_PROXY_BIN:-}
if [ -z "$IRON" ]; then
  VERSIONS=$ROOT/.claude/skills/add-iron-proxy/versions.json
  SOURCE=$(node -e "console.log(require('$VERSIONS')['iron-proxy-source'])")
  COMMIT=$(node -e "console.log(require('$VERSIONS')['iron-proxy-commit'])")
  git clone --quiet "$SOURCE" "$WORK/iron-proxy-src"
  git -C "$WORK/iron-proxy-src" checkout --quiet "$COMMIT"
  (cd "$WORK/iron-proxy-src" && GOTOOLCHAIN=auto go build -o "$WORK/iron-proxy" ./cmd/iron-proxy)
  IRON=$WORK/iron-proxy
fi
echo "using $IRON"

step "fake Copilot API and upstream router"
node "$HERE/fake-copilot-api.mjs" > "$WORK/fake.log" 2>&1 & PIDS+=($!)
node "$HERE/upstream-router.mjs" > "$WORK/router.log" 2>&1 & PIDS+=($!)
sleep 1

step "provider setup: store the token in the gateway"
(cd "$ROOT" && pnpm exec tsx "$HERE/setup-step.ts")
grep -q '^COPILOT_API_URL=https://api.githubcopilot.com$' "$WORK/.env" || { echo "FAIL: setup did not record the plan API"; exit 1; }
if grep -q "$E2E_REAL_TOKEN" "$WORK/.env" "$WORK/iron.yaml"; then echo "FAIL: the token leaked into .env or the proxy config"; exit 1; fi
echo "recorded $(cat "$WORK/.env"); token only in the proxy's secret environment"

step "start Iron Proxy with the stored secret"
# Only the secret and the upstream CA; no ambient proxy settings.
env -i PATH="$PATH" HOME="$WORK" SSL_CERT_FILE="$E2E_CA" $(cat "$WORK/iron.env") \
  "$IRON" -config "$WORK/iron.yaml" > "$WORK/iron.log" 2>&1 & PIDS+=($!)
for _ in $(seq 1 50); do (exec 3<>"/dev/tcp/127.0.0.1/$E2E_IRON_PORT") 2>/dev/null && break; sleep 0.2; done

step "runner: real Copilot runtime through the gateway"
PROXY=http://127.0.0.1:$E2E_IRON_PORT
(
  cd "$ROOT/container/agent-runner"
  env -u GH_TOKEN -u GITHUB_TOKEN -u COPILOT_GITHUB_TOKEN -u NO_PROXY -u no_proxy \
    HTTPS_PROXY="$PROXY" https_proxy="$PROXY" HTTP_PROXY="$PROXY" http_proxy="$PROXY" \
    NODE_EXTRA_CA_CERTS="$WORK/iron-ca.crt" SSL_CERT_FILE="$WORK/iron-ca.crt" \
    COPILOT_API_URL=$(sed -n 's/^COPILOT_API_URL=//p' "$WORK/.env") COPILOT_GATEWAY_E2E=1 \
    bun test src/providers/copilot.gateway.test.ts
)

step "upstream: what reached GitHub's side"
node -e "
const rows = require('fs').readFileSync('$E2E_LOG', 'utf8').trim().split('\n').map(JSON.parse);
const counts = {};
for (const r of rows) { const k = r.host + ' ' + r.credential; counts[k] = (counts[k] || 0) + 1; }
console.log(counts);
const api = rows.filter((r) => r.host === 'api.githubcopilot.com');
const fail = (m) => { console.error('FAIL: ' + m); process.exit(1); };
if (!api.some((r) => r.path === '/chat/completions')) fail('no model call reached the Copilot API');
if (api.some((r) => r.credential !== 'real')) fail('a Copilot API request reached upstream without the injected token');
if (rows.some((r) => r.credential === 'real' && r.host !== 'api.githubcopilot.com' && r.host !== 'api.github.com')) fail('the token reached a host setup did not connect');
console.log('PASS: every Copilot API request carried the injected token; the runtime held only the placeholder');
"
