import { CLAUDE_COMPATIBLE_HOST_SURFACES } from './claude.js';
import { registerProviderHostContract } from './registry.js';
import { COPILOT_MODEL_DOMAIN, configuredCopilotApiUrl } from '../providers/copilot-endpoint.js';

registerProviderHostContract('copilot', {
  // This installed payload implements v1; a core upgrade must not opt it into a new seam.
  seamVersion: 1,
  // src/providers/copilot.ts passes the plan's API origin to the runtime.
  legacyHostAdapter: 'required',
  // Every plan's API (api.githubcopilot.com, api.{business,enterprise}.githubcopilot.com)
  // and the runtime's telemetry host. api.github.com is deliberately absent:
  // model domains skip gateway approval host-wide, and a NanoClaw session never
  // needs it (the built-in GitHub MCP server is disabled; setup reads the plan
  // from the host, not the container).
  modelDomains: [COPILOT_MODEL_DOMAIN],
  // Read by gateway credential adapters: the host setup connects the token to.
  modelEndpoints: { api: configuredCopilotApiUrl() },
  // The composed CLAUDE.md and the shared skills backing, as for Claude: the
  // provider hands both to the SDK explicitly (system message, skill directory).
  ...CLAUDE_COMPATIBLE_HOST_SURFACES,
  stateVolumes: [
    ...CLAUDE_COMPATIBLE_HOST_SURFACES.stateVolumes,
    {
      // The runtime's own state: each session's event log, which resume reads.
      id: 'copilot-home',
      directory: '.copilot-shared',
      containerPath: '/home/node/.copilot',
      scope: 'group',
      mode: 'rw',
      mountClass: 'allowlisted-extra',
    },
  ],
  commands: { nativeAdmin: [], nativeFiltered: [] },
});
