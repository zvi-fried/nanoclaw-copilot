import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../env.js', () => ({ readEnvFile: () => ({}) }));
import './index.js';
import '../provider-contracts/index.js';
import { getProviderContainerConfig } from './provider-container-registry.js';
import { getProviderHostContract } from '../provider-contracts/registry.js';
import { configuredCopilotApiUrl, normalizeCopilotApiUrl } from './copilot-endpoint.js';

const context = (hostEnv: NodeJS.ProcessEnv = {}) => ({
  sessionDir: '/tmp/session',
  groupDir: '/tmp/group',
  agentGroupId: 'test',
  selectedSkills: [],
  hostEnv,
  coreOwnsProviderSurfaces: true as const,
});

afterEach(() => {
  delete process.env.COPILOT_API_URL;
});

describe('Copilot host payload', () => {
  it('registers a version 1 host contract with Copilot model domains and its own state volume', () => {
    const contract = getProviderHostContract('copilot');
    expect(contract).toMatchObject({
      seamVersion: 1,
      legacyHostAdapter: 'required',
      modelDomains: ['githubcopilot.com'],
      modelEndpoints: { api: 'https://api.githubcopilot.com' },
      projectDocument: { fileName: 'CLAUDE.md' },
    });
    expect(contract?.modelDomains).not.toContain('github.com');
    expect(contract?.stateVolumes.map((volume) => volume.containerPath)).toContain('/home/node/.copilot');
  });

  it('passes only the plan API origin to the container, never a token', async () => {
    process.env.COPILOT_API_URL = 'https://api.business.githubcopilot.com';
    const contribution = await getProviderContainerConfig('copilot')!(
      context({ GH_TOKEN: 'secret', GITHUB_TOKEN: 'secret', COPILOT_GITHUB_TOKEN: 'secret' }),
    );
    expect(contribution).toEqual({ env: { COPILOT_API_URL: 'https://api.business.githubcopilot.com' } });
  });

  it('accepts only https origins under githubcopilot.com as the plan API', () => {
    expect(normalizeCopilotApiUrl('https://api.enterprise.githubcopilot.com/')).toBe(
      'https://api.enterprise.githubcopilot.com',
    );
    for (const bad of [
      'http://api.githubcopilot.com',
      'https://api.githubcopilot.com:8443',
      'https://githubcopilot.com.evil.example',
      'https://api.githubcopilot.com/v1',
      'https://user:pw@api.githubcopilot.com',
      'not a url',
    ])
      expect(normalizeCopilotApiUrl(bad)).toBeUndefined();
    process.env.COPILOT_API_URL = 'https://evil.example.com';
    expect(configuredCopilotApiUrl()).toBe('https://api.githubcopilot.com');
  });
});
