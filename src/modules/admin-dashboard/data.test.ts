import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { collectDashboardSnapshot } from './data.js';

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-dashboard-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('collectDashboardSnapshot', () => {
  it('uses existing central/session data and reports baseline skill coverage', () => {
    const root = temporaryDirectory();
    const sessionsDir = path.join(root, 'sessions');
    const skillsDir = path.join(root, 'skills');
    const officialManifest = path.join(root, 'official.json');
    fs.mkdirSync(path.join(skillsDir, 'lark-doc'), { recursive: true });
    fs.mkdirSync(path.join(skillsDir, 'welcome'), { recursive: true });
    fs.writeFileSync(path.join(skillsDir, 'lark-doc', 'SKILL.md'), '---\nname: lark-doc\nversion: 1.0.0\ndescription: 文档操作\n---\n');
    fs.writeFileSync(path.join(skillsDir, 'welcome', 'SKILL.md'), '---\nname: welcome\ndescription: 用户引导\n---\n');
    fs.writeFileSync(officialManifest, JSON.stringify({ skills: ['lark-doc'] }));

    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE agent_groups (id TEXT PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE messaging_groups (id TEXT PRIMARY KEY, denied_at TEXT);
      CREATE TABLE messaging_group_agents (id TEXT PRIMARY KEY);
      CREATE TABLE users (id TEXT PRIMARY KEY);
      CREATE TABLE sessions (id TEXT PRIMARY KEY, agent_group_id TEXT, status TEXT, container_status TEXT);
      CREATE TABLE container_configs (agent_group_id TEXT PRIMARY KEY, skills TEXT);
      INSERT INTO agent_groups VALUES ('ag-1', '通用助手'), ('ag-2', '财务助手');
      INSERT INTO messaging_groups VALUES ('mg-1', NULL), ('mg-2', '2026-08-01T00:00:00.000Z');
      INSERT INTO messaging_group_agents VALUES ('wire-1');
      INSERT INTO users VALUES ('fs:u1');
      INSERT INTO sessions VALUES ('sess-1', 'ag-1', 'active', 'running'), ('sess-broken', 'ag-2', 'active', 'stopped');
      INSERT INTO container_configs VALUES ('ag-1', '"all"'), ('ag-2', '["lark-doc"]');
    `);

    const sessionDir = path.join(sessionsDir, 'ag-1', 'sess-1');
    fs.mkdirSync(sessionDir, { recursive: true });
    const inbound = new Database(path.join(sessionDir, 'inbound.db'));
    inbound.exec(`
      CREATE TABLE messages_in (status TEXT, timestamp TEXT, tries INTEGER);
      CREATE TABLE delivered (status TEXT, delivered_at TEXT);
      INSERT INTO messages_in VALUES ('completed', '2026-08-12T01:00:00.000Z', 0), ('failed', '2026-08-12T02:00:00.000Z', 2), ('pending', '2026-08-12T03:00:00.000Z', 0);
      INSERT INTO delivered VALUES ('delivered', '2026-08-12T03:05:00.000Z');
    `);
    inbound.close();
    const outbound = new Database(path.join(sessionDir, 'outbound.db'));
    outbound.exec("CREATE TABLE processing_ack (status TEXT); INSERT INTO processing_ack VALUES ('processing')");
    outbound.close();

    const snapshot = collectDashboardSnapshot({
      db, sessionsDir, skillsDir, officialSkillsManifest: officialManifest,
      window: '24h', now: new Date('2026-08-12T04:00:00.000Z'),
    });
    db.close();

    expect(snapshot.runtime).toMatchObject({ agentGroups: 2, messagingGroups: 1, users: 1, sessions: 2, runningContainers: 1 });
    expect(snapshot.outcomes).toMatchObject({ completed: 1, failed: 1, pending: 1, delivered: 1, processing: 1, successRate: 50 });
    expect(snapshot.outcomes.unreadableSessionDbs).toBe(1);
    expect(snapshot.outcomes.recentFailures[0]).toMatchObject({ agentGroupName: '通用助手', tries: 2 });
    expect(snapshot.skills.items).toEqual([
      expect.objectContaining({ name: 'lark-doc', source: '飞书官方', enabledGroupCount: 2 }),
      expect.objectContaining({ name: 'welcome', source: 'NanoClaw', enabledGroupCount: 1 }),
    ]);
  });
});
