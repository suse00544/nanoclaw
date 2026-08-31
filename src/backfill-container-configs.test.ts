import fs from 'fs';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-test-legacy-task-backfill';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-legacy-task-backfill/data',
    GROUPS_DIR: '/tmp/nanoclaw-test-legacy-task-backfill/groups',
  };
});

import { backfillContainerConfigs } from './backfill-container-configs.js';
import { closeDb, createAgentGroup, createMessagingGroup, initTestDb, runMigrations } from './db/index.js';
import { createSession, getSessionsByAgentGroup } from './db/sessions.js';
import { insertTaskRow } from './modules/scheduling/db.js';
import { inboundDbPath, initSessionFolder, outboundDbPath } from './session-manager.js';
import type { Session } from './types.js';

const AGENT_GROUP_ID = 'ag-legacy';
const CHAT_SESSION_ID = 'sess-chat';
const SERIES_ID = 'legacy-monitor';

beforeEach(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });

  const db = initTestDb();
  runMigrations(db);
  createAgentGroup({
    id: AGENT_GROUP_ID,
    name: 'Legacy monitor',
    folder: 'legacy-monitor',
    agent_provider: null,
    created_at: '2026-08-24T00:00:00.000Z',
  });
  createMessagingGroup({
    id: 'mg-legacy',
    channel_type: 'fs',
    platform_id: 'fs:oc_legacy',
    name: 'Legacy chat',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: '2026-08-24T00:00:00.000Z',
  });
  const chatSession: Session = {
    id: CHAT_SESSION_ID,
    agent_group_id: AGENT_GROUP_ID,
    messaging_group_id: 'mg-legacy',
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: '2026-08-24T00:00:00.000Z',
  };
  createSession(chatSession);
  initSessionFolder(AGENT_GROUP_ID, CHAT_SESSION_ID);

  const inbound = new Database(inboundDbPath(AGENT_GROUP_ID, CHAT_SESSION_ID));
  insertTaskRow(inbound, {
    id: SERIES_ID,
    seriesId: SERIES_ID,
    processAfter: '2026-08-24T09:50:00.000Z',
    recurrence: null,
    content: JSON.stringify({ prompt: 'monitor bugs', script: null, originSessionId: null }),
  });
  inbound.prepare("UPDATE messages_in SET status = 'completed' WHERE id = ?").run(SERIES_ID);
  insertTaskRow(inbound, {
    id: 'legacy-monitor-next',
    seriesId: SERIES_ID,
    processAfter: '2026-08-24T10:00:00.000Z',
    recurrence: '*/10 * * * *',
    content: JSON.stringify({ prompt: 'monitor bugs', script: null, originSessionId: null }),
  });
  inbound.close();

  const outbound = new Database(outboundDbPath(AGENT_GROUP_ID, CHAT_SESSION_ID));
  outbound
    .prepare('INSERT INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
    .run('continuation:claude', 'polluted-continuation', '2026-08-24T09:49:00.000Z');
  outbound
    .prepare('INSERT INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
    .run('unrelated', 'keep-me', '2026-08-24T09:49:00.000Z');
  outbound.close();
});

afterEach(() => {
  closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('startup legacy backfills', () => {
  it('moves task history out of a chat session and resets only its provider continuation', () => {
    backfillContainerConfigs();
    backfillContainerConfigs(); // restart-safe and idempotent

    const taskSession = getSessionsByAgentGroup(AGENT_GROUP_ID).find(
      (session) => session.thread_id === `system:tasks:${SERIES_ID}`,
    );
    expect(taskSession).toBeDefined();

    const sourceInbound = new Database(inboundDbPath(AGENT_GROUP_ID, CHAT_SESSION_ID), { readonly: true });
    expect(
      (sourceInbound.prepare("SELECT COUNT(*) AS n FROM messages_in WHERE kind = 'task'").get() as { n: number }).n,
    ).toBe(0);
    sourceInbound.close();

    const targetInbound = new Database(inboundDbPath(AGENT_GROUP_ID, taskSession!.id), { readonly: true });
    const moved = targetInbound
      .prepare('SELECT id, series_id, status, process_after, recurrence FROM messages_in ORDER BY process_after')
      .all() as Array<Record<string, unknown>>;
    targetInbound.close();
    expect(moved).toEqual([
      {
        id: SERIES_ID,
        series_id: SERIES_ID,
        status: 'completed',
        process_after: '2026-08-24T09:50:00.000Z',
        recurrence: null,
      },
      {
        id: 'legacy-monitor-next',
        series_id: SERIES_ID,
        status: 'pending',
        process_after: '2026-08-24T10:00:00.000Z',
        recurrence: '*/10 * * * *',
      },
    ]);

    const sourceOutbound = new Database(outboundDbPath(AGENT_GROUP_ID, CHAT_SESSION_ID), { readonly: true });
    const state = sourceOutbound.prepare('SELECT key, value FROM session_state ORDER BY key').all();
    sourceOutbound.close();
    expect(state).toEqual([{ key: 'unrelated', value: 'keep-me' }]);
  });
});
