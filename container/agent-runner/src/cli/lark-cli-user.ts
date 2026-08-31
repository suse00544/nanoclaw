#!/usr/bin/env bun
/**
 * Run lark-cli with a per-Feishu-user HOME.
 *
 * The host mounts exactly one Feishu user's persistent lark-cli profile into
 * private-message containers. This wrapper derives the current sender from the
 * session DB and verifies it against that mounted profile. Both this wrapper
 * and plain `lark-cli` therefore use the user's own app and OAuth token.
 */
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { Database } from 'bun:sqlite';

const INBOUND_DB = '/workspace/inbound.db';
const OUTBOUND_DB = '/workspace/outbound.db';
const USER_HOME = '/home/node';
const USER_MARKER = path.join(USER_HOME, '.lark-cli', '.nanoclaw-user-id');
const REAL_LARK_CLI = process.env.LARK_CLI_BIN || '/pnpm/lark-cli';

interface MessageRow {
  id: string;
  seq: number | null;
  channel_type: string | null;
  content: string;
}

export function main(): never {
  const userId = resolveCurrentFeishuUser();
  const home = ensureUserHome(userId);
  const env = {
    ...process.env,
    HOME: home,
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
  };

  if (process.argv[2] === 'setup') {
    runSetupCommand(process.argv[3], home, env);
  }
  if (process.argv[2] === 'login') {
    runLoginCommand(process.argv[3], home, env);
  }

  const child = spawnSync(REAL_LARK_CLI, process.argv.slice(2), {
    stdio: 'inherit',
    env,
  });
  if (child.error) {
    console.error(`lark-cli-user: failed to run ${REAL_LARK_CLI}: ${child.error.message}`);
    process.exit(127);
  }
  process.exit(child.status ?? 1);
}

function runSetupCommand(command: string | undefined, home: string, env: NodeJS.ProcessEnv): never {
  const logPath = path.join(home, '.lark-cli', 'config-init.log');
  const pidPath = path.join(home, '.lark-cli', 'config-init.pid');
  const configPath = path.join(home, '.lark-cli', 'config.json');

  if (command === 'start') {
    if (hasConfiguredApp(configPath)) {
      printJson({ ok: true, configured: true, running: false, message: 'this user already has a Lark app' });
    }
    if (isSetupRunning(pidPath)) {
      printJson({ ok: true, configured: false, running: true, message: 'app setup is already running' });
    }

    // User codes expire and Feishu returns a generic 20001 page for stale
    // links. Keep only the current setup run in the log so agents never offer
    // an old verification URL from a previous container/session.
    const logFd = fs.openSync(logPath, 'w', 0o600);
    const child = spawn(REAL_LARK_CLI, ['config', 'init', '--new', '--lang', 'zh'], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env,
    });
    child.unref();
    fs.closeSync(logFd);
    fs.writeFileSync(pidPath, `${child.pid}\n`, { mode: 0o600 });
    printJson({
      ok: true,
      configured: false,
      running: true,
      message: 'app setup started; run `lark-cli-user setup status` to get the verification URL',
    });
  }

  if (command === 'status') {
    const configured = hasConfiguredApp(configPath);
    const running = isSetupRunning(pidPath);
    if (configured) {
      printJson({ ok: true, configured, running, verificationUrl: null, verificationUrls: [] });
    }
    const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
    const verificationUrls = latestFirst(Array.from(log.matchAll(/https?:\/\/[^\s"']+/g), (match) => match[0]));
    printJson({ ok: true, configured, running, verificationUrl: verificationUrls[0] ?? null, verificationUrls });
  }

  fail('usage: lark-cli-user setup start|status');
}

function runLoginCommand(command: string | undefined, home: string, env: NodeJS.ProcessEnv): never {
  const statePath = path.join(home, '.lark-cli', 'user-login.json');

  if (command === 'start') {
    const child = spawnSync(REAL_LARK_CLI, ['auth', 'login', '--no-wait', '--json', '--recommend'], {
      encoding: 'utf8',
      env,
    });
    if (child.error) {
      fail(`failed to start user authorization: ${child.error.message}`);
    }
    if (child.status !== 0) {
      const detail = [child.stdout, child.stderr].filter(Boolean).join('\n').trim();
      fail(`failed to start user authorization${detail ? `: ${detail}` : ''}`);
    }

    const payload = parseLoginStart(child.stdout);
    const saved = {
      device_code: payload.device_code,
      verification_url: payload.verification_url,
      expires_in: payload.expires_in ?? null,
      created_at: new Date().toISOString(),
      expires_at: payload.expires_in ? new Date(Date.now() + payload.expires_in * 1000).toISOString() : null,
    };
    fs.writeFileSync(statePath, JSON.stringify(saved, null, 2), { mode: 0o600 });
    printJson({
      ok: true,
      running: true,
      verificationUrl: payload.verification_url,
      expiresIn: payload.expires_in ?? null,
      message: 'send verificationUrl to the user; after they finish authorization, run `lark-cli-user login finish`',
    });
  }

  if (command === 'status') {
    const state = readLoginState(statePath);
    printJson({
      ok: true,
      running: !!state,
      verificationUrl: state?.verification_url ?? null,
      expiresAt: state?.expires_at ?? null,
    });
  }

  if (command === 'finish') {
    const state = readLoginState(statePath);
    if (!state) {
      fail('no pending user authorization; run `lark-cli-user login start` first');
    }
    const child = spawnSync(REAL_LARK_CLI, ['auth', 'login', '--device-code', state.device_code], {
      stdio: 'inherit',
      env,
    });
    if (child.error) {
      fail(`failed to finish user authorization: ${child.error.message}`);
    }
    if ((child.status ?? 1) === 0) {
      try {
        fs.unlinkSync(statePath);
      } catch {
        /* ignore */
      }
    }
    process.exit(child.status ?? 1);
  }

  fail('usage: lark-cli-user login start|status|finish');
}

function hasConfiguredApp(configPath: string): boolean {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { apps?: unknown[] };
    return Array.isArray(config.apps) && config.apps.length > 0;
  } catch {
    return false;
  }
}

function isSetupRunning(pidPath: string): boolean {
  try {
    const pid = Number(fs.readFileSync(pidPath, 'utf8').trim());
    if (!Number.isInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function printJson(value: unknown): never {
  console.log(JSON.stringify(value, null, 2));
  process.exit(0);
}

function latestFirst(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (let i = values.length - 1; i >= 0; i--) {
    const value = values[i];
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

interface LoginStartPayload {
  device_code: string;
  verification_url: string;
  expires_in?: number;
}

interface LoginState {
  device_code: string;
  verification_url: string;
  expires_at: string | null;
}

function parseLoginStart(stdout: string): LoginStartPayload {
  const jsonStart = stdout.indexOf('{');
  const jsonEnd = stdout.lastIndexOf('}');
  if (jsonStart === -1 || jsonEnd === -1 || jsonEnd < jsonStart) {
    fail('lark-cli did not return JSON for user authorization');
  }
  let payload: LoginStartPayload;
  try {
    payload = JSON.parse(stdout.slice(jsonStart, jsonEnd + 1)) as LoginStartPayload;
  } catch {
    fail('lark-cli returned invalid JSON for user authorization');
  }
  if (!payload.device_code || !payload.verification_url) {
    fail('lark-cli authorization response did not include device_code and verification_url');
  }
  if (!payload.verification_url.startsWith('https://accounts.feishu.cn/oauth/v1/device/verify?')) {
    fail(`unexpected user authorization URL: ${payload.verification_url}`);
  }
  return payload;
}

function readLoginState(statePath: string): LoginState | null {
  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as LoginState;
    if (!state.device_code || !state.verification_url) return null;
    return state;
  } catch {
    return null;
  }
}

function resolveCurrentFeishuUser(): string {
  if (!fs.existsSync(INBOUND_DB)) {
    fail('inbound.db is not mounted; lark-cli-user only works inside a NanoClaw session container');
  }

  const db = new Database(INBOUND_DB, { readonly: true });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA mmap_size = 0');

    const processing = findProcessingFeishuMessage(db);
    const fallback = processing ?? findLatestFeishuTrigger(db);
    if (!fallback) {
      fail('no current Feishu trigger message found; user OAuth commands must be initiated by a Feishu user message');
    }

    const senderId = extractSenderId(fallback);
    if (!senderId || !senderId.startsWith('fs:')) {
      fail('current message has no Feishu senderId; cannot select a user credential profile');
    }
    return senderId;
  } finally {
    db.close();
  }
}

function findProcessingFeishuMessage(db: Database): MessageRow | null {
  if (!fs.existsSync(OUTBOUND_DB)) return null;
  try {
    db.exec(`ATTACH DATABASE '${OUTBOUND_DB.replace(/'/g, "''")}' AS out`);
    return (
      db
        .prepare(
          `SELECT m.id, m.seq, m.channel_type, m.content
             FROM messages_in m
             JOIN out.processing_ack a ON a.message_id = m.id
            WHERE a.status = 'processing'
              AND m.channel_type = 'fs'
              AND m.trigger = 1
              AND m.kind IN ('chat', 'chat-sdk')
            ORDER BY m.seq DESC
            LIMIT 1`,
        )
        .get() as MessageRow | null
    );
  } catch {
    return null;
  } finally {
    try {
      db.exec('DETACH DATABASE out');
    } catch {
      /* ignore */
    }
  }
}

function findLatestFeishuTrigger(db: Database): MessageRow | null {
  return (
    db
      .prepare(
        `SELECT id, seq, channel_type, content
           FROM messages_in
          WHERE channel_type = 'fs'
            AND trigger = 1
            AND kind IN ('chat', 'chat-sdk')
          ORDER BY seq DESC
          LIMIT 1`,
      )
      .get() as MessageRow | null
  );
}

function extractSenderId(row: MessageRow): string | null {
  let content: any;
  try {
    content = JSON.parse(row.content);
  } catch {
    return null;
  }
  const raw = content?.senderId || content?.author?.userId || null;
  if (!raw || typeof raw !== 'string') return null;
  if (raw.includes(':')) return raw;
  return row.channel_type ? `${row.channel_type}:${raw}` : raw;
}

export function ensureUserHome(userId: string): string {
  if (!fs.existsSync(USER_MARKER)) {
    fail('user credentials are available only in a private Feishu conversation; open the bot DM and retry');
  }
  const mountedUserId = fs.readFileSync(USER_MARKER, 'utf8').trim();
  if (mountedUserId !== userId) {
    fail('the mounted Feishu credential profile does not match the current sender');
  }

  const home = USER_HOME;
  const configDir = path.join(home, '.lark-cli');
  const storeDir = path.join(home, '.local', 'share', 'lark-cli');
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(storeDir, { recursive: true, mode: 0o700 });
  return home;
}

function fail(message: string): never {
  console.error(`lark-cli-user: ${message}`);
  process.exit(2);
}

if (import.meta.main) main();
