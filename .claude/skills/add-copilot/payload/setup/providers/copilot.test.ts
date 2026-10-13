import { describe, expect, it } from 'vitest';

import './index.js';
import { getSetupProvider } from './registry.js';

describe('Copilot setup provider', () => {
  it('offers GitHub Copilot with an auth walk-through and an install check', () => {
    const provider = getSetupProvider('copilot');
    expect(provider).toMatchObject({ value: 'copilot', label: 'GitHub Copilot' });
    expect(provider?.runAuth).toBeTypeOf('function');
    expect(provider?.runInstallCheck).toBeTypeOf('function');
  });
});
