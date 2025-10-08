const http = require('http');
const { URL } = require('url');
const crypto = require('crypto');

const { log } = require('../logger');
const {
  GITHUB_WEBHOOK_ENABLED,
  GITHUB_WEBHOOK_PORT,
  GITHUB_WEBHOOK_PATH,
  GITHUB_WEBHOOK_SECRET,
} = require('../config');
const { handlePushWebhook } = require('./announcer');

const tag = log.tag('GITHUB-WEBHOOK');
let server = null;

function verifySignature(secret, signature, payloadBuffer) {
  if (!secret) return true;
  if (!signature) return false;
  const expected = Buffer.from(
    `sha256=${crypto.createHmac('sha256', secret).update(payloadBuffer).digest('hex')}`,
    'utf8',
  );
  const provided = Buffer.from(String(signature), 'utf8');
  if (expected.length !== provided.length) return false;
  return crypto.timingSafeEqual(expected, provided);
}

function readRequestBody(req, maxBytes = 1 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;

    req.on('data', (chunk) => {
      received += chunk.length;
      if (received > maxBytes) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      resolve(Buffer.concat(chunks));
    });

    req.on('error', (err) => {
      reject(err);
    });
  });
}

async function handleRequest(req, res) {
  const url = new URL(req.url || '/', 'http://localhost');
  if (url.pathname !== GITHUB_WEBHOOK_PATH) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'text/plain', Allow: 'POST' });
    res.end('Method Not Allowed');
    return;
  }

  let body;
  try {
    body = await readRequestBody(req);
  } catch (err) {
    tag.warn(`Failed to read webhook body: ${err?.message || err}`);
    res.writeHead(err?.message === 'Payload too large' ? 413 : 400, { 'Content-Type': 'text/plain' });
    res.end('Invalid payload');
    return;
  }

  if (GITHUB_WEBHOOK_SECRET) {
    const signature = req.headers['x-hub-signature-256'];
    if (!verifySignature(GITHUB_WEBHOOK_SECRET, signature, body)) {
      tag.warn('Rejected webhook with invalid signature.');
      res.writeHead(401, { 'Content-Type': 'text/plain' });
      res.end('Invalid signature');
      return;
    }
  }

  let payload;
  try {
    payload = body.length ? JSON.parse(body.toString('utf8')) : {};
  } catch (err) {
    tag.warn(`Failed to parse webhook JSON: ${err?.message || err}`);
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Invalid JSON');
    return;
  }

  const event = req.headers['x-github-event'];
  if (event === 'ping') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('pong');
    return;
  }

  if (event !== 'push') {
    tag.debug(`Ignoring unsupported GitHub event type=${event}`);
    res.writeHead(202, { 'Content-Type': 'text/plain' });
    res.end('Ignored');
    return;
  }

  try {
    await handlePushWebhook(payload);
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
  } catch (err) {
    tag.error(`Failed to process GitHub webhook: ${err?.stack || err}`);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Internal error');
  }
}

function startGithubWebhookServer() {
  if (!GITHUB_WEBHOOK_ENABLED) {
    return null;
  }
  if (!GITHUB_WEBHOOK_PORT) {
    tag.warn('GitHub webhook enabled but GITHUB_WEBHOOK_PORT is not set.');
    return null;
  }
  if (server) {
    return server;
  }

  server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      tag.error(`Unhandled webhook error: ${err?.stack || err}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
      }
      res.end('Internal error');
    });
  });

  server.listen(GITHUB_WEBHOOK_PORT, () => {
    tag.info(`Listening for GitHub webhooks on port ${GITHUB_WEBHOOK_PORT}${GITHUB_WEBHOOK_PATH}`);
  });

  server.on('error', (err) => {
    tag.error(`GitHub webhook server error: ${err?.stack || err}`);
  });

  return server;
}

module.exports = { startGithubWebhookServer };
