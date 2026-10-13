/**
 * The Copilot provider's non-secret host settings, shared by its host
 * contract, its container config and its setup script. Importing this module
 * registers nothing.
 */
import { readEnvFile } from '../env.js';

/**
 * The value the runtime presents where a GitHub token belongs. It is not a
 * secret: the credential gateway matches it in the Authorization header and
 * swaps in the stored token. container/agent-runner/src/providers/copilot-config.ts
 * declares the same literal; a payload test keeps the two equal.
 */
export const COPILOT_CREDENTIAL_PLACEHOLDER = 'nc-copilot-token-v1';

/** Copilot's model domain: every plan's API host is a subdomain of it. */
export const COPILOT_MODEL_DOMAIN = 'githubcopilot.com';

/** The individual plan's API, and the runtime's own default. */
export const COPILOT_DEFAULT_API_URL = 'https://api.githubcopilot.com';

/** Where setup records the plan's API (business and enterprise plans have their own host). */
export const COPILOT_API_URL_KEY = 'COPILOT_API_URL';

/** An https origin on a githubcopilot.com host, or undefined. Nothing else may carry the credential. */
export function normalizeCopilotApiUrl(raw: string | undefined): string | undefined {
  if (!raw?.trim()) return undefined;
  try {
    const url = new URL(raw.trim());
    if (
      url.protocol !== 'https:' ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== '/' && url.pathname !== '') ||
      !url.hostname.endsWith(`.${COPILOT_MODEL_DOMAIN}`)
    )
      return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

/** The configured plan API: an exported variable wins over `.env`; an invalid value falls back to the default. */
export function configuredCopilotApiUrl(projectRoot?: string): string {
  const raw = process.env[COPILOT_API_URL_KEY] ?? readEnvFile([COPILOT_API_URL_KEY], projectRoot)[COPILOT_API_URL_KEY];
  return normalizeCopilotApiUrl(raw) ?? COPILOT_DEFAULT_API_URL;
}
