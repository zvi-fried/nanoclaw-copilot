/**
 * Host-side container config for the `copilot` provider. Core realizes the
 * declared surfaces (src/provider-contracts/copilot.ts); this adapter only
 * hands the runtime its plan's API origin, which setup recorded. The GitHub
 * token never reaches the container: the runtime presents a placeholder and
 * the credential gateway swaps it.
 */
import { registerProviderContainerConfig } from './provider-container-registry.js';
import { COPILOT_API_URL_KEY, configuredCopilotApiUrl } from './copilot-endpoint.js';

registerProviderContainerConfig('copilot', () => ({
  env: { [COPILOT_API_URL_KEY]: configuredCopilotApiUrl() },
}));
