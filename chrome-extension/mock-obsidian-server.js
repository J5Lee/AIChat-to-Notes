// Mock server for Obsidian Local REST API (coddingtonbear/obsidian-local-rest-api)
// Usage:
//   node mock-obsidian-server.js
// Then set extension Obsidian URL to:
//   http://127.0.0.1:27123  (extension will normalize to /vault)
// And Obsidian Key to:
//   test-key
//
// This server will:
// - accept PUT /vault/<filename>
// - require Authorization: Bearer test-key
// - write the body to ./mock-vault/<filename>

import http from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const HOST = '127.0.0.1';
const PORT = 27123;
const REQUIRED_KEY = process.env.OBSIDIAN_KEY || 'test-key';
const VAULT_DIR = new URL('./mock-vault/', import.meta.url);
mkdirSync(VAULT_DIR, { recursive: true });

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...headers });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const { method, url, headers } = req;
  if (!url) return send(res, 400, 'Missing url');

  if (method === 'GET' && url === '/health') {
    return send(res, 200, 'ok');
  }

  const auth = headers['authorization'] || '';
  if (auth !== `Bearer ${REQUIRED_KEY}`) {
    return send(res, 401, `Unauthorized. Expected Authorization: Bearer ${REQUIRED_KEY}`);
  }

  if (method !== 'PUT') {
    return send(res, 405, `Method not allowed: ${method}`);
  }

  if (!url.startsWith('/vault/')) {
    return send(res, 404, `Not found. Expected PUT /vault/<filename>, got ${url}`);
  }

  const rawPath = decodeURIComponent(url.slice('/vault/'.length));
  if (!rawPath || rawPath.includes('..') || rawPath.startsWith('/')) {
    return send(res, 400, `Invalid path: ${rawPath}`);
  }

  let body = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    try {
      const outPath = join(VAULT_DIR.pathname, rawPath);
      // Ensure subfolders exist if any
      const folder = outPath.split('/').slice(0, -1).join('/');
      mkdirSync(folder, { recursive: true });
      writeFileSync(outPath, body, 'utf8');
      send(res, 200, 'ok');
      // eslint-disable-next-line no-console
      console.log(`[mock-obsidian] wrote ${rawPath} (${body.length} bytes)`);
    } catch (e) {
      send(res, 500, String(e?.message || e));
    }
  });
});

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`[mock-obsidian] listening on http://${HOST}:${PORT}`);
  console.log(`[mock-obsidian] vault dir: ${VAULT_DIR.pathname}`);
  console.log(`[mock-obsidian] required key: ${REQUIRED_KEY}`);
});
