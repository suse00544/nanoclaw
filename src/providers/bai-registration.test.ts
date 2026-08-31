import { describe, expect, it } from 'vitest';

import { getProviderContainerConfig, listProviderContainerConfigNames } from './provider-container-registry.js';
import './index.js';

describe('b.ai provider host registration', () => {
  it('registers b.ai and passes only b.ai configuration', () => {
    expect(listProviderContainerConfigNames()).toContain('b.ai');
    const contribution = getProviderContainerConfig('b.ai')!({
      sessionDir: '/tmp/session',
      agentGroupId: 'ag-test',
      groupDir: '/tmp/group',
      selectedSkills: [],
      hostEnv: {
        BAI_BASE_URL: 'https://api.b.ai/v1',
        BAI_MODEL: 'deepseek-v4-flash-vision-exp',
        ANTHROPIC_BASE_URL: 'https://anthropic.example/v1',
      },
    });

    expect(contribution.env).toEqual({
      BAI_BASE_URL: 'https://api.b.ai/v1',
      BAI_MODEL: 'deepseek-v4-flash-vision-exp',
    });
  });
});
