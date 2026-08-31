import { readEnvFile } from '../env.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

const KEYS = ['BAI_BASE_URL', 'BAI_MODEL'] as const;

registerProviderContainerConfig('b.ai', (ctx) => {
  const dotenv = readEnvFile([...KEYS]);
  const env: Record<string, string> = {};
  for (const key of KEYS) {
    const value = ctx.hostEnv[key] ?? dotenv[key];
    if (value) env[key] = value;
  }
  return { env };
});
