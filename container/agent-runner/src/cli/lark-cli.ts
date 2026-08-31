#!/usr/bin/env bun
/**
 * Guarded lark-cli entrypoint for NanoClaw containers.
 *
 * The real CLI is installed at /pnpm/lark-cli. This wrapper keeps legacy v1
 * credential workarounds from being revived by old transcripts or stale skills.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const REAL_LARK_CLI = process.env.NANOCLAW_REAL_LARK_CLI || '/pnpm/lark-cli';
const USER_MARKER = '/home/node/.lark-cli/.nanoclaw-user-id';

const LEGACY_HOME_PATTERNS = [
  '/workspace/group/.lark-home',
  '/workspace/group/.lark-home-full',
  '/tmp/lark-home',
];

function main(): never {
  rejectLegacyHome(process.env.HOME || '');
  rejectLegacyHome(process.env.XDG_DATA_HOME || '');
  rejectLegacyHome(process.env.XDG_CONFIG_HOME || '');

  const args = process.argv.slice(2);
  if (isConfigInit(args)) {
    fail('direct `lark-cli config init` is disabled in NanoClaw containers; use `lark-cli-user setup start|status` in a Feishu DM, or configure the service bot on the host');
  }
  if (requestsUserIdentity(args) && !fs.existsSync(USER_MARKER)) {
    fail('`--as user` is disabled outside a private Feishu DM; continue in the bot DM with `lark-cli-user`, or use `--as bot` for app-authorized shared resources');
  }

  const child = spawnSync(REAL_LARK_CLI, args, {
    stdio: 'inherit',
    env: process.env,
  });
  if (child.error) {
    fail(`failed to run ${REAL_LARK_CLI}: ${child.error.message}`, 127);
  }
  process.exit(child.status ?? 1);
}

function rejectLegacyHome(value: string): void {
  if (!value) return;
  if (LEGACY_HOME_PATTERNS.some((pattern) => value === pattern || value.startsWith(`${pattern}/`))) {
    fail('legacy v1 lark-cli HOME paths are disabled; use the mounted v2 profile: DM user operations via `lark-cli-user`, group operations via `lark-cli --as bot`');
  }
}

function isConfigInit(args: string[]): boolean {
  return args[0] === 'config' && args[1] === 'init';
}

function requestsUserIdentity(args: string[]): boolean {
  return args.some((arg, index) => arg === '--as=user' || (arg === '--as' && args[index + 1] === 'user'));
}

function fail(message: string, code = 2): never {
  console.error(`lark-cli: ${message}`);
  process.exit(code);
}

main();
