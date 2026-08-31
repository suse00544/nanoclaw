import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const DEFAULT_TTL_SECONDS = 300;
const MAX_BODY_BYTES = 8 * 1024;

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function tokensEqual(actual, expected) {
  const actualHash = createHash('sha256')
    .update(actual || '')
    .digest();
  const expectedHash = createHash('sha256')
    .update(expected || '')
    .digest();
  return timingSafeEqual(actualHash, expectedHash);
}

function bearerToken(req) {
  return req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1] || '';
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

function sendHtml(res, status, body) {
  res.writeHead(status, {
    'cache-control': 'no-store',
    'content-security-policy':
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'content-type': 'text/html; charset=utf-8',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
  });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) throw new Error('body_too_large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('invalid_json');
  }
}

function statusPage({ available, viewToken, code }) {
  const body = code
    ? `<div class="code">${code}</div><p class="warning">已从服务端销毁，请勿转发或截图。</p>`
    : available
      ? `<p class="available">有一条新验证码。</p><form method="post" action="/reveal?token=${encodeURIComponent(viewToken)}"><button type="submit">领取并销毁验证码</button></form>`
      : '<p>验证码不存在、已过期或已被领取。</p>';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Apple 验证码</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:32rem;margin:4rem auto;padding:0 1.2rem;color:#182230}.box{border:1px solid #d8dee8;border-radius:14px;padding:1.5rem}.available{color:#137333}.code{font:700 3rem ui-monospace,monospace;letter-spacing:.3em;text-align:center;margin:2rem}.warning{color:#b42318}button{font:inherit;background:#1769e0;color:#fff;border:0;border-radius:9px;padding:.75rem 1rem}</style></head><body><main class="box"><h1>Apple 验证码</h1>${body}</main></body></html>`;
}

async function notifyFeishu(config) {
  const { webhookUrl, publicUrl, viewToken, ttlSeconds } = config;
  if (!publicUrl) return;
  const link = `${publicUrl.replace(/\/$/, '')}/?token=${encodeURIComponent(viewToken)}`;
  const text = `Apple 验证码已更新（${ttlSeconds} 秒内有效）：${link}`;
  if (webhookUrl) {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ msg_type: 'text', content: { text } }),
    });
    if (!response.ok) throw new Error(`feishu_webhook_${response.status}`);
    return;
  }

  if (!config.appId || !config.appSecret || !config.chatId) return;
  const tokenResponse = await fetch(`${config.apiBase}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: config.appId, app_secret: config.appSecret }),
  });
  const tokenBody = await tokenResponse.json();
  if (!tokenResponse.ok || !tokenBody.tenant_access_token) throw new Error('feishu_token_failed');

  const sendResponse = await fetch(`${config.apiBase}/open-apis/im/v1/messages?receive_id_type=chat_id`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${tokenBody.tenant_access_token}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      receive_id: config.chatId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    }),
  });
  if (!sendResponse.ok) throw new Error(`feishu_send_${sendResponse.status}`);
}

export function createRelayServer(options = {}) {
  const ingestToken = options.ingestToken ?? process.env.APPLE_CODE_INGEST_TOKEN ?? '';
  const viewToken = options.viewToken ?? process.env.APPLE_CODE_VIEW_TOKEN ?? '';
  const ttlSeconds = options.ttlSeconds ?? positiveInteger(process.env.APPLE_CODE_TTL_SECONDS, DEFAULT_TTL_SECONDS);
  const publicUrl = options.publicUrl ?? process.env.APPLE_CODE_PUBLIC_URL ?? '';
  const feishuWebhookUrl = options.feishuWebhookUrl ?? process.env.FEISHU_WEBHOOK_URL ?? '';
  const feishuAppId = options.feishuAppId ?? process.env.FEISHU_APP_ID ?? '';
  const feishuAppSecret = options.feishuAppSecret ?? process.env.FEISHU_APP_SECRET ?? '';
  const feishuChatId = options.feishuChatId ?? process.env.FEISHU_CHAT_ID ?? '';
  const feishuDomain = options.feishuDomain ?? process.env.FEISHU_DOMAIN ?? 'feishu';
  const feishuApiBase =
    options.feishuApiBase ?? (feishuDomain === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn');
  const now = options.now ?? (() => Date.now());
  if (!ingestToken || !viewToken) throw new Error('APPLE_CODE_INGEST_TOKEN and APPLE_CODE_VIEW_TOKEN are required');

  let currentCode = null;
  const removeExpiredCode = () => {
    if (currentCode && currentCode.expiresAt <= now()) currentCode = null;
  };

  return createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/healthz') {
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/ingest') {
      if (!tokensEqual(bearerToken(req), ingestToken)) return sendJson(res, 401, { error: 'unauthorized' });
      let body;
      try {
        body = await readJson(req);
      } catch (error) {
        return sendJson(res, error.message === 'body_too_large' ? 413 : 400, { error: error.message });
      }
      const code = String(body?.code || '').match(/(?:^|\D)(\d{6})(?!\d)/)?.[1];
      if (!code) return sendJson(res, 400, { error: 'six_digit_code_required' });
      currentCode = { value: code, expiresAt: now() + ttlSeconds * 1000 };
      try {
        await notifyFeishu({
          webhookUrl: feishuWebhookUrl,
          publicUrl,
          viewToken,
          ttlSeconds,
          appId: feishuAppId,
          appSecret: feishuAppSecret,
          chatId: feishuChatId,
          apiBase: feishuApiBase,
        });
      } catch (error) {
        console.error('Feishu notification failed:', error.message);
      }
      return sendJson(res, 202, { ok: true, expires_in: ttlSeconds });
    }

    if (req.method === 'GET' && url.pathname === '/') {
      if (!tokensEqual(url.searchParams.get('token') || '', viewToken)) {
        return sendHtml(res, 401, statusPage({ available: false }));
      }
      removeExpiredCode();
      return sendHtml(res, 200, statusPage({ available: Boolean(currentCode), viewToken }));
    }

    if (req.method === 'POST' && url.pathname === '/reveal') {
      if (!tokensEqual(url.searchParams.get('token') || '', viewToken)) {
        return sendHtml(res, 401, statusPage({ available: false }));
      }
      removeExpiredCode();
      if (!currentCode) return sendHtml(res, 410, statusPage({ available: false }));
      const code = currentCode.value;
      currentCode = null;
      return sendHtml(res, 200, statusPage({ code }));
    }

    return sendJson(res, 404, { error: 'not_found' });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const host = process.env.HOST || '127.0.0.1';
  const port = positiveInteger(process.env.PORT, 8791);
  const server = createRelayServer();
  server.listen(port, host, () => console.log(`Apple code relay listening on http://${host}:${port}`));
}
