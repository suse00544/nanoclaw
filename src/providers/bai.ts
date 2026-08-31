import { readEnvFile } from '../env.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

const DEFAULT_BAI_ANTHROPIC_BASE_URL = 'https://api.b.ai';

export function resolveBaiContainerEnv(
  hostEnv: NodeJS.ProcessEnv,
  dotenv: Record<string, string | undefined>,
): Record<string, string> {
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL:
      hostEnv.BAI_ANTHROPIC_BASE_URL?.trim() || dotenv.BAI_ANTHROPIC_BASE_URL || DEFAULT_BAI_ANTHROPIC_BASE_URL,
  };
  const compactWindow = hostEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW?.trim() || dotenv.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
  if (compactWindow) env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = compactWindow;
  return env;
}

registerProviderContainerConfig('b.ai', ({ hostEnv }) => {
  const dotenv = readEnvFile(['BAI_ANTHROPIC_BASE_URL', 'CLAUDE_CODE_AUTO_COMPACT_WINDOW']);
  return { env: resolveBaiContainerEnv(hostEnv, dotenv) };
});
