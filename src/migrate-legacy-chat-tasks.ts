/**
 * Move pre-isolation scheduled tasks out of ordinary chat sessions.
 *
 * Older installs stored task occurrences beside user chat messages. Besides
 * mixing delivery semantics, resuming that provider continuation repeatedly
 * injected the monitor prompt into normal @mention turns. New tasks already
 * use one `system:tasks:<series>` session per series; this startup backfill
 * brings legacy rows onto that representation.
 *
 * The operation is restart-safe: rows are inserted with OR IGNORE, verified
 * in the destination, and only then removed from the source. Startup runs
 * before containers and channel adapters, so the host is the only writer.
 */
import fs from 'fs';

import Database from 'better-sqlite3';

import { getActiveSessions, isTaskThread } from './db/sessions.js';
import { nextEvenSeq } from './db/session-db.js';
import { log } from './log.js';
import { inboundDbPath, initSessionFolder, outboundDbPath, resolveTaskSession } from './session-manager.js';

interface LegacyTaskRow {
  id: string;
  kind: string;
  timestamp: string;
  status: string;
  process_after: string | null;
  recurrence: string | null;
  series_id: string | null;
  tries: number;
  trigger: number;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string;
  source_session_id: string | null;
  on_wake: number;
}

function taskRows(db: Database.Database): LegacyTaskRow[] {
  return db
    .prepare(
      `SELECT id, kind, timestamp, status, process_after, recurrence, series_id,
              tries, trigger, platform_id, channel_type, thread_id, content,
              source_session_id, on_wake
         FROM messages_in
        WHERE kind = 'task'
        ORDER BY seq`,
    )
    .all() as LegacyTaskRow[];
}

function copySeries(target: Database.Database, rows: LegacyTaskRow[]): void {
  const insert = target.prepare(
    `INSERT OR IGNORE INTO messages_in (
       id, seq, kind, timestamp, status, process_after, recurrence, series_id,
       tries, trigger, platform_id, channel_type, thread_id, content,
       source_session_id, on_wake
     ) VALUES (
       @id, @seq, @kind, @timestamp, @status, @process_after, @recurrence, @series_id,
       @tries, @trigger, @platform_id, @channel_type, @thread_id, @content,
       @source_session_id, @on_wake
     )`,
  );
  target.transaction(() => {
    for (const row of rows) insert.run({ ...row, seq: nextEvenSeq(target) });
  })();
}

function destinationHasEveryRow(target: Database.Database, rows: LegacyTaskRow[]): boolean {
  const find = target.prepare("SELECT series_id FROM messages_in WHERE id = ? AND kind = 'task'");
  return rows.every((row) => {
    const found = find.get(row.id) as { series_id: string | null } | undefined;
    return found !== undefined && found.series_id === (row.series_id ?? row.id);
  });
}

function clearPollutedChatState(agentGroupId: string, sessionId: string, movedIds: string[]): void {
  const path = outboundDbPath(agentGroupId, sessionId);
  if (!fs.existsSync(path)) return;
  const db = new Database(path);
  try {
    db.transaction(() => {
      db.prepare("DELETE FROM session_state WHERE key LIKE 'continuation:%' OR key = 'current_in_reply_to'").run();
      const removeAck = db.prepare('DELETE FROM processing_ack WHERE message_id = ?');
      for (const id of movedIds) removeAck.run(id);
    })();
  } finally {
    db.close();
  }
}

export function migrateLegacyChatTasks(): number {
  let movedSeries = 0;

  for (const session of getActiveSessions()) {
    if (isTaskThread(session.thread_id)) continue;
    const sourcePath = inboundDbPath(session.agent_group_id, session.id);
    if (!fs.existsSync(sourcePath)) continue;

    const source = new Database(sourcePath);
    try {
      const rows = taskRows(source);
      if (rows.length === 0) continue;

      const bySeries = new Map<string, LegacyTaskRow[]>();
      for (const row of rows) {
        const seriesId = row.series_id ?? row.id;
        row.series_id = seriesId;
        const seriesRows = bySeries.get(seriesId) ?? [];
        seriesRows.push(row);
        bySeries.set(seriesId, seriesRows);
      }

      const movedIds: string[] = [];
      for (const [seriesId, seriesRows] of bySeries) {
        const { session: targetSession } = resolveTaskSession(session.agent_group_id, seriesId);
        initSessionFolder(session.agent_group_id, targetSession.id);
        const target = new Database(inboundDbPath(session.agent_group_id, targetSession.id));
        try {
          copySeries(target, seriesRows);
          if (!destinationHasEveryRow(target, seriesRows)) {
            throw new Error(`destination verification failed for task series ${seriesId}`);
          }
        } finally {
          target.close();
        }

        const remove = source.prepare("DELETE FROM messages_in WHERE id = ? AND kind = 'task'");
        source.transaction(() => {
          for (const row of seriesRows) remove.run(row.id);
        })();
        movedIds.push(...seriesRows.map((row) => row.id));
        movedSeries++;
      }

      clearPollutedChatState(session.agent_group_id, session.id, movedIds);
      log.info('Migrated legacy tasks out of chat session', {
        sessionId: session.id,
        agentGroupId: session.agent_group_id,
        series: bySeries.size,
        rows: movedIds.length,
      });
    } finally {
      source.close();
    }
  }

  return movedSeries;
}
