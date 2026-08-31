import { afterEach, describe, expect, it } from 'vitest';

import './index.js';
import { getProviderContainerConfig } from './provider-container-registry.js';

const originalBaseUrl = process.env.BAI_ANTHROPIC_BASE_URL;

afterEach(() => {
  if (originalBaseUrl === undefined) delete process.env.BAI_ANTHROPIC_BASE_URL;
  else process.env.BAI_ANTHROPIC_BASE_URL = originalBaseUrl;
});

describe('b.ai Claude SDK configuration', () => {
  it('uses the official Anthropic-compatible endpoint by default', () => {
    delete process.env.BAI_ANTHROPIC_BASE_URL;
    const contribution = getProviderContainerConfig('b.ai')?.({
      sessionDir: '/tmp/session',
      agentGroupId: 'ag-test',
      groupDir: '/tmp/group',
      selectedSkills: [],
      hostEnv: process.env,
    });
    expect(contribution?.env?.ANTHROPIC_BASE_URL).toBe('https://api.b.ai');
  });

  it('supports an explicit Anthropic endpoint override', () => {
    process.env.BAI_ANTHROPIC_BASE_URL = 'https://bai.example';
    const contribution = getProviderContainerConfig('b.ai')?.({
      sessionDir: '/tmp/session',
      agentGroupId: 'ag-test',
      groupDir: '/tmp/group',
      selectedSkills: [],
      hostEnv: process.env,
    });
    expect(contribution?.env?.ANTHROPIC_BASE_URL).toBe('https://bai.example');
  });
});
