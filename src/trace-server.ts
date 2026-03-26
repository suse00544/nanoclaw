/**
 * Trace Viewer Server for NanoClaw
 * Displays conversation traces from the database
 */
import { createServer } from 'http';
import path from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';

import { GROUPS_DIR, STORE_DIR } from './config.js';
import { logger } from './logger.js';

const TRACE_PORT = 18765;

function openDb(): Database.Database {
  return new Database(path.join(STORE_DIR, 'messages.db'), { readonly: true });
}

interface TraceMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  sender_name?: string;
}

interface Trace {
  id: string;
  startTime: string;
  endTime: string;
  messageCount: number;
  preview: string;
}

// Group messages into traces by time gap (> 30 min = new trace)
function groupIntoTraces(messages: any[]): Trace[] {
  if (messages.length === 0) return [];

  const traces: Trace[] = [];
  let currentTrace: { messages: any[]; startTime: string; endTime: string } | null = null;

  for (const msg of messages) {
    const msgTime = new Date(msg.timestamp).getTime();

    if (!currentTrace) {
      currentTrace = { messages: [msg], startTime: msg.timestamp, endTime: msg.timestamp };
    } else {
      const lastTime = new Date(currentTrace.endTime).getTime();
      if (msgTime - lastTime > 30 * 60 * 1000) {
        // Gap > 30 min, start new trace
        traces.push({
          id: currentTrace.messages[0].id,
          startTime: currentTrace.startTime,
          endTime: currentTrace.endTime,
          messageCount: currentTrace.messages.length,
          preview: currentTrace.messages[0].content.slice(0, 60),
        });
        currentTrace = { messages: [msg], startTime: msg.timestamp, endTime: msg.timestamp };
      } else {
        currentTrace.messages.push(msg);
        currentTrace.endTime = msg.timestamp;
      }
    }
  }

  // Push last trace
  if (currentTrace) {
    traces.push({
      id: currentTrace.messages[0].id,
      startTime: currentTrace.startTime,
      endTime: currentTrace.endTime,
      messageCount: currentTrace.messages.length,
      preview: currentTrace.messages[0].content.slice(0, 60),
    });
  }

  return traces.reverse(); // Newest first
}

const HTML = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>NanoClaw Trace Viewer</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #0f0f17;
    --bg2: #1a1a2e;
    --bg3: #16213e;
    --accent: #e94560;
    --accent2: #0f3460;
    --text: #eee;
    --text2: #888;
    --user-msg: #2d5a3d;
    --assistant-msg: #1a3a5c;
    --border: #2a2a4a;
  }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: var(--bg);
    color: var(--text);
    height: 100vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  header {
    background: var(--bg2);
    padding: 12px 20px;
    display: flex;
    gap: 16px;
    align-items: center;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  h1 { font-size: 16px; color: var(--accent); font-weight: 600; }
  .group-select {
    padding: 6px 12px;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--bg3);
    color: var(--text);
    font-size: 14px;
    min-width: 200px;
  }
  .main {
    display: flex;
    flex: 1;
    overflow: hidden;
  }
  .sidebar {
    width: 320px;
    background: var(--bg2);
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
  }
  .sidebar-header {
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
    font-size: 13px;
    color: var(--text2);
  }
  .trace-list {
    flex: 1;
    overflow-y: auto;
    padding: 8px;
  }
  .trace-item {
    padding: 12px;
    border-radius: 8px;
    margin-bottom: 6px;
    cursor: pointer;
    background: var(--bg3);
    border: 1px solid transparent;
    transition: all 0.15s;
  }
  .trace-item:hover {
    border-color: var(--accent2);
  }
  .trace-item.active {
    border-color: var(--accent);
    background: var(--accent2);
  }
  .trace-time {
    font-size: 11px;
    color: var(--text2);
    margin-bottom: 4px;
  }
  .trace-preview {
    font-size: 13px;
    line-height: 1.4;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .trace-count {
    font-size: 11px;
    color: var(--accent);
    margin-top: 4px;
  }
  .detail {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .detail-header {
    padding: 16px 20px;
    border-bottom: 1px solid var(--border);
    background: var(--bg2);
    flex-shrink: 0;
  }
  .detail-title {
    font-size: 14px;
    color: var(--accent);
  }
  .messages {
    flex: 1;
    overflow-y: auto;
    padding: 20px;
  }
  .message {
    margin-bottom: 16px;
    max-width: 80%;
  }
  .message.user {
    margin-left: auto;
  }
  .message.assistant {
    margin-right: auto;
  }
  .message-header {
    font-size: 11px;
    color: var(--text2);
    margin-bottom: 4px;
    padding: 0 4px;
  }
  .message.user .message-header {
    text-align: right;
  }
  .message-content {
    padding: 12px 16px;
    border-radius: 12px;
    font-size: 14px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .message.user .message-content {
    background: var(--user-msg);
    border-bottom-right-radius: 4px;
  }
  .message.assistant .message-content {
    background: var(--assistant-msg);
    border-bottom-left-radius: 4px;
  }
  .empty-state {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--text2);
    font-size: 14px;
  }
</style>
</head>
<body>
<header>
  <h1>Trace Viewer</h1>
  <select class="group-select" id="groupSelect">
    <option value="">Select group...</option>
  </select>
</header>
<div class="main">
  <div class="sidebar">
    <div class="sidebar-header">
      <span id="traceCount">0</span> traces
    </div>
    <div class="trace-list" id="traceList"></div>
  </div>
  <div class="detail">
    <div class="detail-header">
      <div class="detail-title" id="detailTitle">Select a trace</div>
    </div>
    <div class="messages" id="messageList">
      <div class="empty-state">Select a trace to view messages</div>
    </div>
  </div>
</div>

<script>
const $ = id => document.getElementById(id);
let currentTrace = null;

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit'
  });
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Load groups
fetch('/api/groups')
  .then(r => r.json())
  .then(groups => {
    const select = $('groupSelect');
    groups.forEach(g => {
      if (g.folder === 'global' || g.folder === 'main' || g.folder.startsWith('.')) return;
      const opt = document.createElement('option');
      opt.value = g.folder;
      opt.textContent = g.name || g.folder;
      select.appendChild(opt);
    });
    if (select.options.length > 1) {
      select.selectedIndex = 1;
      loadTraces(select.value);
    }
  });

// Group change
$('groupSelect').addEventListener('change', () => {
  const folder = $('groupSelect').value;
  if (!folder) return;
  loadTraces(folder);
});

async function loadTraces(folder) {
  $('traceList').innerHTML = '<div class="empty-state">Loading...</div>';
  $('messageList').innerHTML = '<div class="empty-state">Select a trace</div>';
  currentTrace = null;

  try {
    const res = await fetch('/api/traces/' + folder);
    const traces = await res.json();
    $('traceCount').textContent = traces.length;
    renderTraceList(traces);
  } catch (e) {
    $('traceList').innerHTML = '<div class="empty-state">Failed to load</div>';
  }
}

function renderTraceList(traces) {
  const container = $('traceList');
  if (traces.length === 0) {
    container.innerHTML = '<div class="empty-state">No traces found</div>';
    return;
  }

  let html = '';
  for (const t of traces) {
    const isActive = currentTrace && currentTrace.id === t.id ? 'active' : '';
    html += '<div class="trace-item ' + isActive + '" data-id="' + t.id + '" data-start="' + t.startTime + '">' +
      '<div class="trace-time">' + formatTime(t.startTime) + ' - ' + formatTime(t.endTime) + '</div>' +
      '<div class="trace-preview">' + escapeHtml(t.preview) + '</div>' +
      '<div class="trace-count">' + t.messageCount + ' messages</div>' +
    '</div>';
  }
  container.innerHTML = html;

  container.querySelectorAll('.trace-item').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.id;
      const start = el.dataset.start;
      loadTraceDetails(id, start);
    });
  });
}

async function loadTraceDetails(traceId, startTime) {
  const folder = $('groupSelect').value;
  $('messageList').innerHTML = '<div class="empty-state">Loading...</div>';
  $('detailTitle').textContent = formatTime(startTime);

  // Highlight selected
  document.querySelectorAll('.trace-item').forEach(el => {
    el.classList.toggle('active', el.dataset.id === traceId);
  });

  try {
    const res = await fetch('/api/traces/' + folder + '/' + encodeURIComponent(traceId));
    const data = await res.json();
    currentTrace = data;
    renderMessages(data.messages);
  } catch (e) {
    $('messageList').innerHTML = '<div class="empty-state">Failed to load</div>';
  }
}

function renderMessages(messages) {
  const container = $('messageList');
  if (!messages || messages.length === 0) {
    container.innerHTML = '<div class="empty-state">No messages</div>';
    return;
  }

  let html = '';
  for (const msg of messages) {
    const role = msg.role || (msg.is_from_me ? 'user' : 'assistant');
    html += '<div class="message ' + role + '">' +
      '<div class="message-header">' + (msg.sender_name || role) + ' · ' + formatTime(msg.timestamp) + '</div>' +
      '<div class="message-content">' + escapeHtml(msg.content) + '</div>' +
    '</div>';
  }
  container.innerHTML = html;
  container.scrollTop = 0;
}
</script>
</body>
</html>`;

export function startTraceServer(): void {
  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${TRACE_PORT}`);

    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    // List groups
    if (url.pathname === '/api/groups' && req.method === 'GET') {
      try {
        const entries = fs.readdirSync(GROUPS_DIR, { withFileTypes: true });
        const groups = entries
          .filter(e => e.isDirectory())
          .map(e => ({ name: e.name, folder: e.name }))
          .filter(g => !g.folder.startsWith('.'));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(groups));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    // List traces for a group: /api/traces/:folder
    const tracesMatch = url.pathname.match(/^\/api\/traces\/([^/]+)$/);
    if (tracesMatch && req.method === 'GET') {
      const folder = tracesMatch[1];
      try {
        const db = openDb();
        // Find chat_jid for this folder
        const groupRow = db.prepare(
          "SELECT jid FROM registered_groups WHERE folder = ?"
        ).get(folder) as { jid: string } | undefined;

        if (!groupRow) {
          db.close();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify([]));
          return;
        }

        const messages = db.prepare(
          "SELECT * FROM messages WHERE chat_jid = ? ORDER BY timestamp ASC"
        ).all(groupRow.jid) as any[];

        db.close();

        const traces = groupIntoTraces(messages);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(traces));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    // Get trace details: /api/traces/:folder/:traceId
    const detailMatch = url.pathname.match(/^\/api\/traces\/([^/]+)\/(.+)$/);
    if (detailMatch && req.method === 'GET') {
      const folder = detailMatch[1];
      const traceId = decodeURIComponent(detailMatch[2]);
      try {
        const db = openDb();
        const groupRow = db.prepare(
          "SELECT jid FROM registered_groups WHERE folder = ?"
        ).get(folder) as { jid: string } | undefined;

        if (!groupRow) {
          db.close();
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Group not found' }));
          return;
        }

        // Get all messages for this chat
        const messages = db.prepare(
          "SELECT * FROM messages WHERE chat_jid = ? ORDER BY timestamp ASC"
        ).all(groupRow.jid) as any[];

        db.close();

        // Group into traces and find the specific one
        if (messages.length === 0) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ messages: [] }));
          return;
        }

        let currentTrace: { messages: any[]; startTime: string; endTime: string } | null = null;
        const traces: { id: string; messages: any[] }[] = [];

        for (const msg of messages) {
          const msgTime = new Date(msg.timestamp).getTime();

          if (!currentTrace) {
            currentTrace = { messages: [msg], startTime: msg.timestamp, endTime: msg.timestamp };
          } else {
            const lastTime = new Date(currentTrace.endTime).getTime();
            if (msgTime - lastTime > 30 * 60 * 1000) {
              traces.push({
                id: currentTrace.messages[0].id,
                messages: currentTrace.messages,
              });
              currentTrace = { messages: [msg], startTime: msg.timestamp, endTime: msg.timestamp };
            } else {
              currentTrace.messages.push(msg);
              currentTrace.endTime = msg.timestamp;
            }
          }
        }
        if (currentTrace) {
          traces.push({
            id: currentTrace.messages[0].id,
            messages: currentTrace.messages,
          });
        }

        // Find trace by ID
        const found = traces.find(t => t.id === traceId);
        if (!found) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Trace not found' }));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ messages: found.messages }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    // Serve HTML
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(HTML);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  });

  server.listen(TRACE_PORT, '0.0.0.0', () => {
    logger.info({ port: TRACE_PORT }, 'Trace server started');
  });
}
