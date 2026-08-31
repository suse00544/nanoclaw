/** Persist ask_user_question bodies so terminal cards survive host restarts. */
import type { Migration } from './index.js';

export const migration022: Migration = {
  version: 22,
  name: 'question-render-metadata',
  up(db) {
    db.exec(`ALTER TABLE pending_questions ADD COLUMN question TEXT NOT NULL DEFAULT ''`);
  },
};
