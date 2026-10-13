import { describe, it, expect } from 'bun:test';
import './index.js';
import '../provider-contracts/index.js';
import { getProviderRuntimeContract, listProviderNames } from './provider-registry.js';

// `bun test --isolate` keeps sibling tests' direct provider imports out of this registry.
describe('copilot provider registration', () => {
  it('declares the runtime seam implemented by this installed payload', () => {
    expect(getProviderRuntimeContract('copilot')?.seamVersion).toBe(1);
  });
  it('registers copilot via the provider barrel', () => {
    expect(listProviderNames()).toContain('copilot');
  });
});
