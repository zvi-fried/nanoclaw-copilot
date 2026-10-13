# Remove GitHub Copilot

Before removing code, switch each Copilot group to an installed provider using
`ncl groups config update --id <group-id> --provider claude`, then restart that
group. Use `/migrate-memory` first if needed. Do not edit materialized
`container.json` files or clear database rows directly.

Delete `import './copilot.js';` from these five barrels, leaving other imports:

- `setup/providers/index.ts`
- `src/providers/index.ts`
- `src/provider-contracts/index.ts`
- `container/agent-runner/src/providers/index.ts`
- `container/agent-runner/src/provider-contracts/index.ts`

Delete each skill-owned destination in the `nc:copy` block of [SKILL.md](SKILL.md).
Use the destination at the project root, not the source under `payload/`.

Remove the SDK from the runner (`cd container/agent-runner && bun remove @github/copilot-sdk`)
and rebuild the image. Remove `COPILOT_API_URL` from `.env`.

The token stays in the credential gateway until you delete it there: the
"GitHub Copilot" secret in Iron Control or OneCLI. Revoke the token on GitHub
too if nothing else uses it.
