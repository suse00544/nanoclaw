import { describe, expect, test } from 'bun:test';
import fs from 'fs';

describe('lark-cli-user credential boundary', () => {
  test('does not copy the service app config or shared key store', () => {
    const source = fs.readFileSync(new URL('./lark-cli-user.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('SHARED_CONFIG');
    expect(source).not.toContain('SHARED_STORE');
    expect(source).not.toContain('copySharedStore');
    expect(source).toContain("const USER_HOME = '/home/node'");
    expect(source).toContain('mountedUserId !== userId');
    expect(source).toContain("process.argv[2] === 'setup'");
    expect(source).toContain("['config', 'init', '--new', '--lang', 'zh']");
    expect(source).toContain("fs.openSync(logPath, 'w', 0o600)");
    expect(source).toContain('if (configured)');
    expect(source).toContain('verificationUrl');
    expect(source).toContain('verificationUrls');
    expect(source).toContain('latestFirst');
    expect(source).toContain("process.argv[2] === 'login'");
    expect(source).toContain("['auth', 'login', '--no-wait', '--json', '--recommend']");
    expect(source).toContain("['auth', 'login', '--device-code', state.device_code]");
    expect(source).toContain("startsWith('https://accounts.feishu.cn/oauth/v1/device/verify?')");
  });
});
