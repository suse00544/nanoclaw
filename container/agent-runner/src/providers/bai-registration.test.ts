import { describe, expect, it } from 'bun:test';

import { listProviderNames } from './provider-registry.js';
import './index.js';

describe('b.ai provider registration', () => {
  it('registers b.ai via the provider barrel', () => {
    expect(listProviderNames()).toContain('b.ai');
  });
});
