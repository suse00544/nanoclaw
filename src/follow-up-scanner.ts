import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';

export interface DueFollowUp {
  groupFolder: string;
  filename: string;
  filepath: string;
  content: Record<string, unknown>;
}

export function scanFollowUps(groupsDir: string): DueFollowUp[] {
  const due: DueFollowUp[] = [];
  const now = Date.now();

  let groupFolders: string[];
  try {
    groupFolders = fs.readdirSync(groupsDir).filter((f) => {
      try {
        return fs.statSync(path.join(groupsDir, f)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return due;
  }

  for (const groupFolder of groupFolders) {
    const followUpsDir = path.join(groupsDir, groupFolder, 'follow-ups');
    if (!fs.existsSync(followUpsDir)) continue;

    let files: string[];
    try {
      files = fs.readdirSync(followUpsDir).filter((f) => f.endsWith('.json'));
    } catch {
      continue;
    }

    for (const file of files) {
      const filepath = path.join(followUpsDir, file);
      try {
        const raw = fs.readFileSync(filepath, 'utf-8');
        const content = JSON.parse(raw);

        if (content.status !== 'active') continue;
        if (!content.next_check) continue;

        const nextCheck = new Date(content.next_check).getTime();
        if (isNaN(nextCheck) || nextCheck > now) continue;

        due.push({ groupFolder, filename: file, filepath, content });
      } catch (err) {
        logger.warn(
          { file: filepath, err },
          'Skipping malformed follow-up file',
        );
      }
    }
  }

  return due;
}
