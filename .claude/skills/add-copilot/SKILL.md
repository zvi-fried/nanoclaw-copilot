---
name: add-copilot
description: Use GitHub Copilot as an agent provider. Runs the GitHub Copilot SDK runtime in the agent container on the operator's Copilot plan; the GitHub token stays in the credential gateway (Iron Proxy or OneCLI). Per group via `ncl groups config update --provider copilot`.
metadata:
  nanoclaw-provider: copilot
  nanoclaw-provider-label: GitHub Copilot
  nanoclaw-provider-hint: Your Copilot plan, through the credential gateway
  nanoclaw-provider-offered: 'true'
  nanoclaw-provider-image: local-required
---

# GitHub Copilot agent provider

Install GitHub Copilot as an optional NanoClaw runtime. The payload is included in
this skill. It implements the runtime, host and setup provider contracts at
version 1, and passes the provider conformance suite.

The container runs the GitHub Copilot SDK (`@github/copilot-sdk`), whose
platform package bundles the Copilot runtime; no separate CLI is installed. Each
NanoClaw session is one Copilot session, created in the SDK's `empty` mode so
nothing ambient leaks in:

- **Instructions:** core's composed `CLAUDE.md` and per-query system context
  are appended to Copilot's system message. Copilot's own instruction files are
  not read.
- **Skills:** the shared skill backing (`/home/node/.claude/skills`) is the
  session's skill directory.
- **MCP:** NanoClaw's MCP servers, stdio and HTTP. Copilot's built-in GitHub MCP
  server is disabled.
- **Tools:** Copilot's built-in tools except `ask_user`. The container is the
  boundary, so tool permissions are approved unless managed policy reserves one
  for a person.
- **Memory:** core's memory session hook runs on a new session and after
  compaction, through the SDK's session hooks; a resumed session gets none again.
- **Sessions:** the runtime keeps each session on the group's `copilot-home`
  volume; the continuation is Copilot's session id.

## Credentials

The runtime presents the fixed placeholder `nc-copilot-token-v1` as its GitHub
token. Setup stores the operator's token in the selected credential gateway as
one connection: the plan's API host (`api.githubcopilot.com`, or the business
or enterprise host), the `Authorization` header, and that placeholder. The
gateway swaps the placeholder on the wire. The token is never written to
`.env`, passed in the container environment, or mounted.

Use a **fine-grained personal access token** with only the account permission
**Copilot Requests**, from an account with a Copilot plan. GitHub-App and
OAuth-app user tokens (`ghu_`, `gho_`) work too; classic tokens (`ghp_`) do not.
Usage counts against that account's Copilot plan and premium requests.

Setup reads the plan from `https://api.github.com/copilot_internal/user` on the
host (which also checks the token) and records its API origin in `.env` as
`COPILOT_API_URL`. Agents never call `api.github.com` for Copilot. Copilot's
hosts (`*.githubcopilot.com`) are this provider's model domains, so model
traffic needs no approval card. Its telemetry host receives the placeholder,
never the token.

Install and refresh require host contract version 1 and credential-connection
seam version 1. The compatibility predicate below guards every subsequent step.

```nc:run effect:refresh capture:copilot_core_ready validate:^yes$
node -e "const fs=require('fs'); const p='src/provider-contracts/registry.ts', g='setup/gateways/credential-store.ts'; if(fs.existsSync(p) && /PROVIDER_HOST_CONTRACT_SEAM_VERSION = 1/.test(fs.readFileSync(p,'utf8')) && fs.existsSync(g) && /PROVIDER_CREDENTIAL_CONNECTION_SEAM_VERSION = 1/.test(fs.readFileSync(g,'utf8'))) console.log('yes'); else console.log('no')"
```

Copy only the files listed below from this skill's `payload/` to the matching
paths at the project root. They are skill-owned; overwrite them together when
refreshing the skill.

```nc:copy when:copilot_core_ready=yes
payload/container/agent-runner/src/provider-contracts/copilot.ts -> container/agent-runner/src/provider-contracts/copilot.ts
payload/container/agent-runner/src/providers/copilot-config.ts -> container/agent-runner/src/providers/copilot-config.ts
payload/container/agent-runner/src/providers/copilot-memory.ts -> container/agent-runner/src/providers/copilot-memory.ts
payload/container/agent-runner/src/providers/copilot-registration.test.ts -> container/agent-runner/src/providers/copilot-registration.test.ts
payload/container/agent-runner/src/providers/copilot.config.test.ts -> container/agent-runner/src/providers/copilot.config.test.ts
payload/container/agent-runner/src/providers/copilot.conformance.test.ts -> container/agent-runner/src/providers/copilot.conformance.test.ts
payload/container/agent-runner/src/providers/copilot.gateway.test.ts -> container/agent-runner/src/providers/copilot.gateway.test.ts
payload/container/agent-runner/src/providers/copilot.memory.test.ts -> container/agent-runner/src/providers/copilot.memory.test.ts
payload/container/agent-runner/src/providers/copilot.native.test.ts -> container/agent-runner/src/providers/copilot.native.test.ts
payload/container/agent-runner/src/providers/copilot.quickstart.test.ts -> container/agent-runner/src/providers/copilot.quickstart.test.ts
payload/container/agent-runner/src/providers/copilot.ts -> container/agent-runner/src/providers/copilot.ts
payload/container/agent-runner/src/providers/copilot.turns.test.ts -> container/agent-runner/src/providers/copilot.turns.test.ts
payload/scripts/copilot-auth.test.ts -> scripts/copilot-auth.test.ts
payload/scripts/copilot-auth.ts -> scripts/copilot-auth.ts
payload/scripts/tsconfig.copilot-auth.json -> scripts/tsconfig.copilot-auth.json
payload/setup/providers/copilot.test.ts -> setup/providers/copilot.test.ts
payload/setup/providers/copilot.ts -> setup/providers/copilot.ts
payload/src/provider-contracts/copilot.ts -> src/provider-contracts/copilot.ts
payload/src/providers/copilot-endpoint.ts -> src/providers/copilot-endpoint.ts
payload/src/providers/copilot-registration.test.ts -> src/providers/copilot-registration.test.ts
payload/src/providers/copilot.ts -> src/providers/copilot.ts
```

Append `import './copilot.js';` once to each of the five setup, provider and
contract barrels below. Keep all existing imports.

```nc:append to:src/providers/index.ts when:copilot_core_ready=yes
import './copilot.js';
```

```nc:append to:src/provider-contracts/index.ts when:copilot_core_ready=yes
import './copilot.js';
```

```nc:append to:container/agent-runner/src/providers/index.ts when:copilot_core_ready=yes
import './copilot.js';
```

```nc:append to:container/agent-runner/src/provider-contracts/index.ts when:copilot_core_ready=yes
import './copilot.js';
```

```nc:append to:setup/providers/index.ts when:copilot_core_ready=yes
import './copilot.js';
```

Install the SDK in the runner's Bun package. The pin must stay exact; its
platform package carries the runtime the provider was tested against.

```nc:dep manager:bun cwd:container/agent-runner when:copilot_core_ready=yes
@github/copilot-sdk@1.0.19
```

Run the host build, runner typecheck, host and setup tests, and all provider
tests. They exercise real barrel registration and the provider conformance
suite. All checks must pass before rebuilding the agent image.

```nc:run effect:build when:copilot_core_ready=yes
pnpm run build
```

```nc:run effect:build when:copilot_core_ready=yes
pnpm exec tsc -p scripts/tsconfig.copilot-auth.json
```

```nc:run effect:build when:copilot_core_ready=yes
cd container/agent-runner && bun run typecheck
```

```nc:run effect:test when:copilot_core_ready=yes
pnpm exec vitest run src/providers/copilot-registration.test.ts scripts/copilot-auth.test.ts setup/providers
```

```nc:run effect:test when:copilot_core_ready=yes
cd container/agent-runner && bun test --isolate src/providers/copilot*.test.ts
```

Build the local image with `./container/build.sh build`. The new SDK dependency
requires a full local build.

```nc:run effect:build when:copilot_core_ready=yes
./container/build.sh build
```

## Authenticate and select a group

Select a credential gateway first (`/add-iron-proxy` or OneCLI). Then run:

```bash
pnpm exec tsx setup/index.ts --step provider-auth copilot
```

Paste the token when asked. Setup reads the plan, stores the token in the
gateway, and records `COPILOT_API_URL`. Leave the prompt blank on a later run to
keep the stored token; paste a new one to rotate it (the gateway keeps the
connection's identity and grants).

With **Iron Proxy**, the token becomes an Iron Control static secret in replace
mode (`proxy_value: nc-copilot-token-v1`, `match_headers: [Authorization]`,
`require: false`) with one rule for the plan's API host, granted to this
install's principal; the host is added to Iron's allowlist. With **OneCLI** it is
an equivalent host-scoped secret.

Restart the host service, then select and restart a test group:

```bash
ncl groups config update --id <group-id> --provider copilot
ncl groups restart --id <group-id>
```

Send a message and check the reply, then a second one to check the session
continues. Use `/migrate-memory` first if memory needs to move from another
provider.

## Test

- `bun test --isolate src/providers/copilot*.test.ts` in `container/agent-runner`
  runs the unit, registration and conformance tests, and the runtime half of
  the quickstart walk-through (`copilot.quickstart.test.ts`).
- `pnpm exec vitest run .claude/skills/add-copilot/scripts/quickstart.test.ts`
  walks the testing guide's setup steps through the real setup code on a copy
  of the checkout, with GitHub, the gateways, the image build and the package
  manager faked: install, plan lookup, token storage,
  `ncl groups config update --provider copilot`, and each setup-side
  troubleshooting message.
- `COPILOT_NATIVE_TEST=1 bun test src/providers/copilot.native.test.ts` drives
  the real pinned runtime through the provider against a local scripted model:
  streaming, an MCP tool, a built-in tool, a skill, memory, and resume.
- `e2e/gateway-injection.sh` runs the provider's setup step into a pinned Iron
  Proxy, then the runner's poll loop with the real runtime on GitHub's own
  Copilot protocol (not BYOK) through that proxy, against a local fake of
  GitHub's Copilot API: a streamed reply, a built-in tool, a skill and memory.
  It checks that every Copilot API request carried the injected token while
  the runtime held only the placeholder.

Under Copilot auth the runtime withholds MCP servers other than its own until it
has fetched GitHub's MCP policy, which the fake API does not reproduce, so the
gateway run does not cover MCP. The native test covers the provider's MCP
wiring; a live run must confirm that NanoClaw's MCP servers load on a real plan.

A live check needs an account with a Copilot plan, a token as above, and a
gateway that holds it.

## Remove

Follow [REMOVE.md](REMOVE.md).
