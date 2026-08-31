import fs from 'fs';
import http, { type Server } from 'http';
import path from 'path';

import type Database from 'better-sqlite3';

import { collectDashboardSnapshot, type DashboardWindow } from './data.js';

/* eslint-disable no-catch-all/no-catch-all -- the HTTP boundary returns a stable local error response */

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
};

function headers(contentType: string, cacheControl = 'no-store'): Record<string, string> {
  return {
    'Cache-Control': cacheControl,
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; font-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    'Content-Type': contentType,
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  };
}

function sendJson(response: http.ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, headers('application/json; charset=utf-8'));
  response.end(JSON.stringify(value));
}

function parseWindow(url: URL): DashboardWindow {
  const value = url.searchParams.get('window');
  return value === '24h' || value === '30d' ? value : '7d';
}

export function createAdminDashboardServer(options: {
  db: Database.Database;
  sessionsDir: string;
  skillsDir: string;
  officialSkillsManifest: string;
  staticDir: string;
}): Server {
  return http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      sendJson(response, 405, { error: 'method_not_allowed' });
      return;
    }
    if (url.pathname === '/health') {
      sendJson(response, 200, { ok: true });
      return;
    }
    if (url.pathname === '/api/snapshot') {
      try {
        sendJson(response, 200, collectDashboardSnapshot({
          db: options.db,
          sessionsDir: options.sessionsDir,
          skillsDir: options.skillsDir,
          officialSkillsManifest: options.officialSkillsManifest,
          window: parseWindow(url),
        }));
      } catch (error) {
        sendJson(response, 500, { error: 'snapshot_failed', message: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    const requested = path.resolve(options.staticDir, relative);
    const staticRoot = path.resolve(options.staticDir);
    let filePath = requested.startsWith(`${staticRoot}${path.sep}`) || requested === staticRoot ? requested : '';
    if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      filePath = path.join(staticRoot, 'index.html');
    }
    if (!fs.existsSync(filePath)) {
      sendJson(response, 503, { error: 'dashboard_not_built' });
      return;
    }
    const extension = path.extname(filePath).toLowerCase();
    const immutable = filePath.includes(`${path.sep}assets${path.sep}`);
    response.writeHead(200, headers(CONTENT_TYPES[extension] ?? 'application/octet-stream', immutable ? 'public, max-age=31536000, immutable' : 'no-cache'));
    if (request.method === 'HEAD') response.end();
    else fs.createReadStream(filePath).pipe(response);
  });
}
