import path from 'path';

import { ADMIN_DASHBOARD_HOST, ADMIN_DASHBOARD_PORT, DATA_DIR } from '../../config.js';
import { onHostShutdown, onHostStart } from '../../host-lifecycle.js';
import { log } from '../../log.js';
import { createAdminDashboardServer } from './server.js';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
let server: ReturnType<typeof createAdminDashboardServer> | null = null;

onHostStart(async ({ db }) => {
  if (ADMIN_DASHBOARD_PORT === 0) {
    log.info('Admin dashboard disabled');
    return;
  }
  if (!LOOPBACK_HOSTS.has(ADMIN_DASHBOARD_HOST)) {
    throw new Error('NANOCLAW_ADMIN_HOST must be a loopback address until dashboard authentication is configured');
  }

  server = createAdminDashboardServer({
    db,
    sessionsDir: path.join(DATA_DIR, 'v2-sessions'),
    skillsDir: path.resolve(process.cwd(), 'container', 'skills'),
    officialSkillsManifest: path.resolve(process.cwd(), 'container', 'lark-cli-skills.json'),
    staticDir: path.resolve(process.cwd(), 'admin-ui', 'dist'),
  });
  await new Promise<void>((resolve, reject) => {
    server?.once('error', reject);
    server?.listen(ADMIN_DASHBOARD_PORT, ADMIN_DASHBOARD_HOST, () => resolve());
  });
  log.info('Admin dashboard ready', { url: `http://${ADMIN_DASHBOARD_HOST}:${ADMIN_DASHBOARD_PORT}` });
});

onHostShutdown(async () => {
  const active = server;
  server = null;
  if (!active) return;
  await new Promise<void>((resolve, reject) => active.close((error) => error ? reject(error) : resolve()));
});
