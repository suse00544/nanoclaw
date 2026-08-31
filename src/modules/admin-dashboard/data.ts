import fs from 'fs';
import path from 'path';

import type Database from 'better-sqlite3';
import Sqlite from 'better-sqlite3';
import YAML from 'yaml';

import { TIMEZONE } from '../../config.js';

/* eslint-disable no-catch-all/no-catch-all -- dashboard readers degrade per optional or damaged data source */

export type DashboardWindow = '24h' | '7d' | '30d';

interface SessionRow {
  id: string;
  agent_group_id: string;
}

interface GroupConfigRow {
  id: string;
  name: string;
  skills: string | null;
}

export interface DashboardSnapshot {
  generatedAt: string;
  window: DashboardWindow;
  runtime: {
    agentGroups: number;
    messagingGroups: number;
    users: number;
    sessions: number;
    activeSessions: number;
    runningContainers: number;
    wirings: number;
  };
  outcomes: {
    completed: number;
    failed: number;
    pending: number;
    delivered: number;
    processing: number;
    successRate: number | null;
    unreadableSessionDbs: number;
    daily: Array<{ date: string; completed: number; failed: number }>;
    recentFailures: Array<{
      sessionId: string;
      agentGroupId: string;
      agentGroupName: string;
      timestamp: string;
      tries: number;
    }>;
  };
  skills: {
    total: number;
    groupCount: number;
    items: Array<{
      name: string;
      description: string;
      version: string | null;
      source: '飞书官方' | 'NanoClaw';
      enabledGroupCount: number;
    }>;
  };
}

const WINDOW_MS: Record<DashboardWindow, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

function count(db: Database.Database, table: string, where = ''): number {
  return (db.prepare(`SELECT COUNT(*) AS count FROM ${table} ${where}`).get() as { count: number }).count;
}

function localDate(iso: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(iso));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function tableExists(db: Database.Database, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function parseSkillSelection(raw: string | null): 'all' | Set<string> {
  if (!raw) return 'all';
  try {
    const value: unknown = JSON.parse(raw);
    if (value === 'all') return 'all';
    if (Array.isArray(value)) return new Set(value.filter((item): item is string => typeof item === 'string'));
  } catch {
    // Invalid legacy values should not hide the shared baseline.
  }
  return 'all';
}

function loadOfficialSkillNames(manifestPath: string): Set<string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { skills?: unknown };
    return new Set(Array.isArray(parsed.skills) ? parsed.skills.filter((item): item is string => typeof item === 'string') : []);
  } catch {
    return new Set();
  }
}

function readSkills(skillsDir: string, officialManifestPath: string, groups: GroupConfigRow[]): DashboardSnapshot['skills'] {
  const official = loadOfficialSkillNames(officialManifestPath);
  const selections = groups.map((group) => parseSkillSelection(group.skills));
  const directories = fs.existsSync(skillsDir)
    ? fs.readdirSync(skillsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    : [];

  const items = directories.flatMap((entry) => {
    const skillPath = path.join(skillsDir, entry.name, 'SKILL.md');
    if (!fs.existsSync(skillPath)) return [];
    const body = fs.readFileSync(skillPath, 'utf8');
    const match = body.match(/^---\s*\n([\s\S]*?)\n---/);
    let metadata: Record<string, unknown> = {};
    if (match) {
      try {
        metadata = (YAML.parse(match[1]) as Record<string, unknown>) ?? {};
      } catch {
        metadata = {};
      }
    }
    const name = typeof metadata.name === 'string' ? metadata.name : entry.name;
    return [{
      name,
      description: typeof metadata.description === 'string' ? metadata.description : '',
      version: typeof metadata.version === 'string' || typeof metadata.version === 'number'
        ? String(metadata.version)
        : null,
      source: official.has(name) ? '飞书官方' as const : 'NanoClaw' as const,
      enabledGroupCount: selections.filter((selection) => selection === 'all' || selection.has(name)).length,
    }];
  }).sort((a, b) => a.name.localeCompare(b.name));

  return { total: items.length, groupCount: groups.length, items };
}

export function collectDashboardSnapshot(options: {
  db: Database.Database;
  sessionsDir: string;
  skillsDir: string;
  officialSkillsManifest: string;
  window: DashboardWindow;
  now?: Date;
}): DashboardSnapshot {
  const { db, sessionsDir, skillsDir, officialSkillsManifest, window } = options;
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - WINDOW_MS[window]).toISOString();
  const sessions = db.prepare('SELECT id, agent_group_id FROM sessions').all() as SessionRow[];
  const groupNames = new Map(
    (db.prepare('SELECT id, name FROM agent_groups').all() as Array<{ id: string; name: string }>).map((row) => [row.id, row.name]),
  );
  const groupConfigs = db.prepare(
    `SELECT ag.id, ag.name, cc.skills
       FROM agent_groups ag
       LEFT JOIN container_configs cc ON cc.agent_group_id = ag.id`,
  ).all() as GroupConfigRow[];

  let completed = 0;
  let failed = 0;
  let pending = 0;
  let delivered = 0;
  let processing = 0;
  let unreadableSessionDbs = 0;
  const daily = new Map<string, { completed: number; failed: number }>();
  const recentFailures: DashboardSnapshot['outcomes']['recentFailures'] = [];

  for (const session of sessions) {
    const sessionDir = path.join(sessionsDir, session.agent_group_id, session.id);
    const inboundPath = path.join(sessionDir, 'inbound.db');
    const outboundPath = path.join(sessionDir, 'outbound.db');

    try {
      const inbound = new Sqlite(inboundPath, { readonly: true, fileMustExist: true });
      try {
        if (!tableExists(inbound, 'messages_in')) throw new Error('messages_in missing');
        const rows = inbound.prepare(
          `SELECT status, timestamp, tries
             FROM messages_in
            WHERE datetime(timestamp) >= datetime(?)`,
        ).all(cutoff) as Array<{ status: string; timestamp: string; tries: number }>;
        for (const row of rows) {
          if (row.status === 'completed') completed += 1;
          else if (row.status === 'failed') failed += 1;
          else if (row.status === 'pending') pending += 1;

          if (row.status === 'completed' || row.status === 'failed') {
            const key = localDate(row.timestamp);
            const bucket = daily.get(key) ?? { completed: 0, failed: 0 };
            bucket[row.status] += 1;
            daily.set(key, bucket);
          }
          if (row.status === 'failed') {
            recentFailures.push({
              sessionId: session.id,
              agentGroupId: session.agent_group_id,
              agentGroupName: groupNames.get(session.agent_group_id) ?? session.agent_group_id,
              timestamp: row.timestamp,
              tries: row.tries,
            });
          }
        }
        if (tableExists(inbound, 'delivered')) {
          delivered += (inbound.prepare(
            "SELECT COUNT(*) AS count FROM delivered WHERE status = 'delivered' AND datetime(delivered_at) >= datetime(?)",
          ).get(cutoff) as { count: number }).count;
        }
      } finally {
        inbound.close();
      }
    } catch {
      unreadableSessionDbs += 1;
    }

    if (fs.existsSync(outboundPath)) {
      try {
        const outbound = new Sqlite(outboundPath, { readonly: true, fileMustExist: true });
        try {
          if (tableExists(outbound, 'processing_ack')) {
            processing += (outbound.prepare("SELECT COUNT(*) AS count FROM processing_ack WHERE status = 'processing'").get() as { count: number }).count;
          }
        } finally {
          outbound.close();
        }
      } catch {
        unreadableSessionDbs += 1;
      }
    }
  }

  const settled = completed + failed;
  recentFailures.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  return {
    generatedAt: now.toISOString(),
    window,
    runtime: {
      agentGroups: count(db, 'agent_groups'),
      messagingGroups: count(db, 'messaging_groups', 'WHERE denied_at IS NULL'),
      users: count(db, 'users'),
      sessions: sessions.length,
      activeSessions: count(db, 'sessions', "WHERE status = 'active'"),
      runningContainers: count(db, 'sessions', "WHERE container_status = 'running'"),
      wirings: count(db, 'messaging_group_agents'),
    },
    outcomes: {
      completed,
      failed,
      pending,
      delivered,
      processing,
      successRate: settled > 0 ? Math.round((completed / settled) * 1000) / 10 : null,
      unreadableSessionDbs,
      daily: [...daily.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, value]) => ({ date, ...value })),
      recentFailures: recentFailures.slice(0, 8),
    },
    skills: readSkills(skillsDir, officialSkillsManifest, groupConfigs),
  };
}
