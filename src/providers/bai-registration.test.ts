import { describe, expect, it } from 'vitest';

import { resolveBaiContainerEnv } from './bai.js';

describe('b.ai Claude SDK configuration', () => {
  it('uses the official Anthropic-compatible endpoint by default', () => {
    expect(resolveBaiContainerEnv({}, {}).ANTHROPIC_BASE_URL).toBe('https://api.b.ai');
  });

  it('supports an explicit Anthropic endpoint override', () => {
    expect(resolveBaiContainerEnv({ BAI_ANTHROPIC_BASE_URL: 'https://bai.example' }, {}).ANTHROPIC_BASE_URL).toBe(
      'https://bai.example',
    );
  });
});
