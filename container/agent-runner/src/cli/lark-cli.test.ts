import { describe, expect, test } from 'bun:test';
import fs from 'fs';

describe('guarded lark-cli wrapper', () => {
  const source = fs.readFileSync(new URL('./lark-cli.ts', import.meta.url), 'utf8');

  test('blocks legacy v1 credential homes', () => {
    expect(source).toContain('/workspace/group/.lark-home');
    expect(source).toContain('/workspace/group/.lark-home-full');
    expect(source).toContain('/tmp/lark-home');
    expect(source).toContain('legacy v1 lark-cli HOME paths are disabled');
  });

  test('blocks direct config init and group user identity', () => {
    expect(source).toContain('isConfigInit(args)');
    expect(source).toContain('requestsUserIdentity(args)');
    expect(source).toContain('/home/node/.lark-cli/.nanoclaw-user-id');
  });
});
