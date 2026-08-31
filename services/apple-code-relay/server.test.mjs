import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import test, { afterEach } from 'node:test';

const openServers = [];
const childProcesses = [];

afterEach(async () => {
  for (const child of childProcesses.splice(0)) child.kill('SIGTERM');
  await Promise.all(openServers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

async function start(overrides = {}) {
  const { createRelayServer } = await import('./server.mjs');
  const server = createRelayServer({
    ingestToken: 'ingest-secret',
    viewToken: 'view-secret',
    ...overrides,
  });
  openServers.push(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

test('exports a relay server factory', async () => {
  const relay = await import('./server.mjs').catch(() => ({}));

  assert.equal(typeof relay.createRelayServer, 'function');
});

test('stores an uploaded six-digit code and reveals it exactly once', async () => {
  const baseUrl = await start();
  const uploaded = await fetch(`${baseUrl}/ingest`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer ingest-secret',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ code: '123456' }),
  });
  assert.equal(uploaded.status, 202);

  const status = await fetch(`${baseUrl}/?token=view-secret`);
  assert.equal(status.status, 200);
  assert.match(await status.text(), /有一条新验证码/);

  const firstReveal = await fetch(`${baseUrl}/reveal?token=view-secret`, { method: 'POST' });
  assert.equal(firstReveal.status, 200);
  assert.match(await firstReveal.text(), /123456/);

  const secondReveal = await fetch(`${baseUrl}/reveal?token=view-secret`, { method: 'POST' });
  assert.equal(secondReveal.status, 410);
});

test('rejects unauthorized uploads and malformed codes', async () => {
  const baseUrl = await start();
  const unauthorized = await fetch(`${baseUrl}/ingest`, {
    method: 'POST',
    headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' },
    body: JSON.stringify({ code: '123456' }),
  });
  assert.equal(unauthorized.status, 401);

  const malformed = await fetch(`${baseUrl}/ingest`, {
    method: 'POST',
    headers: { authorization: 'Bearer ingest-secret', 'content-type': 'application/json' },
    body: JSON.stringify({ code: '12345' }),
  });
  assert.equal(malformed.status, 400);
  assert.equal((await fetch(`${baseUrl}/?token=wrong`)).status, 401);
});

test('never accepts the upload token in a logged URL query string', async () => {
  const baseUrl = await start();
  const response = await fetch(`${baseUrl}/ingest?token=ingest-secret`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: '123456' }),
  });

  assert.equal(response.status, 401);
});

test('rejects valid JSON that is not an upload object', async () => {
  const baseUrl = await start();
  const response = await fetch(`${baseUrl}/ingest`, {
    method: 'POST',
    headers: { authorization: 'Bearer ingest-secret', 'content-type': 'application/json' },
    body: 'null',
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'six_digit_code_required' });
});

test('expires an unclaimed code after the configured TTL', async () => {
  let now = 1_000_000;
  const baseUrl = await start({ ttlSeconds: 5, now: () => now });
  await fetch(`${baseUrl}/ingest`, {
    method: 'POST',
    headers: { authorization: 'Bearer ingest-secret', 'content-type': 'application/json' },
    body: JSON.stringify({ code: '654321' }),
  });
  now += 6_000;

  const reveal = await fetch(`${baseUrl}/reveal?token=view-secret`, { method: 'POST' });
  assert.equal(reveal.status, 410);
  assert.doesNotMatch(await reveal.text(), /654321/);
});

test('uses the TTL configured through the service environment', async () => {
  const previous = process.env.APPLE_CODE_TTL_SECONDS;
  process.env.APPLE_CODE_TTL_SECONDS = '7';
  const baseUrl = await start();
  if (previous === undefined) delete process.env.APPLE_CODE_TTL_SECONDS;
  else process.env.APPLE_CODE_TTL_SECONDS = previous;

  const response = await fetch(`${baseUrl}/ingest`, {
    method: 'POST',
    headers: { authorization: 'Bearer ingest-secret', 'content-type': 'application/json' },
    body: JSON.stringify({ code: '234567' }),
  });
  assert.deepEqual(await response.json(), { ok: true, expires_in: 7 });
});

test('notifies the configured Feishu webhook without exposing the code', async () => {
  const received = [];
  const webhook = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"code":0}');
  });
  openServers.push(webhook);
  await new Promise((resolve) => webhook.listen(0, '127.0.0.1', resolve));

  const baseUrl = await start({
    publicUrl: 'https://codes.example.test',
    feishuWebhookUrl: `http://127.0.0.1:${webhook.address().port}/hook`,
  });
  const uploaded = await fetch(`${baseUrl}/ingest`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer ingest-secret',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ code: '789012' }),
  });

  assert.equal(uploaded.status, 202);
  assert.deepEqual(received, [
    {
      msg_type: 'text',
      content: {
        text: 'Apple 验证码已更新（300 秒内有效）：https://codes.example.test/?token=view-secret',
      },
    },
  ]);
  assert.doesNotMatch(JSON.stringify(received), /789012/);
});

test('reuses Feishu app credentials to notify a configured chat', async () => {
  const calls = [];
  const feishuApi = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    calls.push({
      url: req.url,
      authorization: req.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url === '/open-apis/auth/v3/tenant_access_token/internal') {
      res.end('{"code":0,"tenant_access_token":"tenant-token","expire":7200}');
    } else {
      res.end('{"code":0}');
    }
  });
  openServers.push(feishuApi);
  await new Promise((resolve) => feishuApi.listen(0, '127.0.0.1', resolve));

  const baseUrl = await start({
    publicUrl: 'https://codes.example.test',
    feishuAppId: 'cli_test',
    feishuAppSecret: 'app-secret',
    feishuChatId: 'oc_test',
    feishuApiBase: `http://127.0.0.1:${feishuApi.address().port}`,
  });
  const uploaded = await fetch(`${baseUrl}/ingest`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer ingest-secret',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ code: '345678' }),
  });

  assert.equal(uploaded.status, 202);
  assert.deepEqual(calls, [
    {
      url: '/open-apis/auth/v3/tenant_access_token/internal',
      authorization: undefined,
      body: { app_id: 'cli_test', app_secret: 'app-secret' },
    },
    {
      url: '/open-apis/im/v1/messages?receive_id_type=chat_id',
      authorization: 'Bearer tenant-token',
      body: {
        receive_id: 'oc_test',
        msg_type: 'text',
        content: JSON.stringify({
          text: 'Apple 验证码已更新（300 秒内有效）：https://codes.example.test/?token=view-secret',
        }),
      },
    },
  ]);
});

test('runs as a standalone service with a health endpoint', async () => {
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));

  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('.', import.meta.url),
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      APPLE_CODE_INGEST_TOKEN: 'ingest-secret',
      APPLE_CODE_VIEW_TOKEN: 'view-secret',
    },
    stdio: 'ignore',
  });
  childProcesses.push(child);

  let response;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      response = await fetch(`http://127.0.0.1:${port}/healthz`);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  assert.equal(response?.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});
