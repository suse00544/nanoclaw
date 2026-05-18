import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { scanFollowUps } from './follow-up-scanner.js';

describe('scanFollowUps', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'followup-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns due items when next_check is in the past', () => {
    const groupDir = path.join(tempDir, 'testgroup');
    const followUpsDir = path.join(groupDir, 'follow-ups');
    fs.mkdirSync(followUpsDir, { recursive: true });

    const item = {
      next_check: new Date(Date.now() - 60000).toISOString(),
      status: 'active',
      title: 'Test follow-up',
    };
    fs.writeFileSync(
      path.join(followUpsDir, 'test-item.json'),
      JSON.stringify(item),
    );

    const results = scanFollowUps(tempDir);

    expect(results).toHaveLength(1);
    expect(results[0].groupFolder).toBe('testgroup');
    expect(results[0].filename).toBe('test-item.json');
    expect(results[0].content.title).toBe('Test follow-up');
  });

  it('skips items with next_check in the future', () => {
    const groupDir = path.join(tempDir, 'testgroup');
    const followUpsDir = path.join(groupDir, 'follow-ups');
    fs.mkdirSync(followUpsDir, { recursive: true });

    const item = {
      next_check: new Date(Date.now() + 3600000).toISOString(),
      status: 'active',
      title: 'Future item',
    };
    fs.writeFileSync(
      path.join(followUpsDir, 'future.json'),
      JSON.stringify(item),
    );

    const results = scanFollowUps(tempDir);
    expect(results).toHaveLength(0);
  });

  it('skips items with status != active', () => {
    const groupDir = path.join(tempDir, 'testgroup');
    const followUpsDir = path.join(groupDir, 'follow-ups');
    fs.mkdirSync(followUpsDir, { recursive: true });

    const item = {
      next_check: new Date(Date.now() - 60000).toISOString(),
      status: 'completed',
      title: 'Done item',
    };
    fs.writeFileSync(
      path.join(followUpsDir, 'done.json'),
      JSON.stringify(item),
    );

    const results = scanFollowUps(tempDir);
    expect(results).toHaveLength(0);
  });

  it('handles missing follow-ups directory gracefully', () => {
    const groupDir = path.join(tempDir, 'emptygroup');
    fs.mkdirSync(groupDir, { recursive: true });

    const results = scanFollowUps(tempDir);
    expect(results).toHaveLength(0);
  });

  it('handles malformed JSON gracefully', () => {
    const groupDir = path.join(tempDir, 'testgroup');
    const followUpsDir = path.join(groupDir, 'follow-ups');
    fs.mkdirSync(followUpsDir, { recursive: true });

    fs.writeFileSync(path.join(followUpsDir, 'bad.json'), 'not json{{{');

    const results = scanFollowUps(tempDir);
    expect(results).toHaveLength(0);
  });
});
