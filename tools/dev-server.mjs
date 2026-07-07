#!/usr/bin/env node
// Minimal static dev server for web/ with COOP/COEP headers.
// Required for SharedArrayBuffer (WASM threads) in browser.
// Usage: node tools/dev-server.mjs [port=8080] [root=.]
// Serves from repo root so importmap "../packages/..." paths resolve correctly.
// Redirects / and /index.html → /web/index.html for convenience.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const port = Number(process.argv[2]) || 8080;
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  process.argv[3] ?? '.',
);

const MIME = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.mjs':  'application/javascript',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.css':  'text/css',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.orf':  'application/octet-stream',
  '.dng':  'application/octet-stream',
};

const SECURITY_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'cross-origin',
  // Dev: never cache. Without this the browser aggressively caches the 1.7 MB
  // raw_converter_wasm_bg.wasm and even Ctrl+Shift+R can serve a stale build, so
  // a rebuilt pkg silently never reaches the page.
  'Cache-Control': 'no-store, no-cache, must-revalidate',
};

// P5-3: Brotli serving micro-win for first-load .wasm (and .js). Serve .br sibling with
// Content-Encoding: br when client advertises it. IDB cache covers repeats; this wins the initial viewer's impression.
// Drop foo.wasm.br next to foo.wasm; ~2.7 MB -> ~700 KB.
function pickWasmPath(filePath, acceptEncoding) {
  if (!/\.wasm$|\.js$/i.test(filePath)) return { path: filePath, encoding: null };
  const wantsBr = acceptEncoding && /\bbr\b/i.test(acceptEncoding);
  if (wantsBr) {
    const br = filePath + '.br';
    if (fs.existsSync(br)) return { path: br, encoding: 'br' };
  }
  return { path: filePath, encoding: null };
}

http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);

  // Redirect bare root to web/index.html so muscle-memory URLs still work.
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(302, { ...SECURITY_HEADERS, Location: '/web/index.html' });
    res.end(); return;
  }

  let filePath = path.join(root, url.pathname);

  // Directory → index.html, or the wasm-bindgen module entry when there is none.
  // wasm-bindgen-rayon's workerHelpers spawns thread workers that do
  // `import('../../..')`, which resolves to the pkg directory URL (e.g. /web/pkg/);
  // serve raw_converter_wasm.js so the rayon thread pool can boot.
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    const idx = path.join(filePath, 'index.html');
    const wbEntry = path.join(filePath, 'raw_converter_wasm.js');
    filePath = fs.existsSync(idx) ? idx : (fs.existsSync(wbEntry) ? wbEntry : idx);
  }

  // Path traversal guard
  if (!filePath.startsWith(root)) {
    res.writeHead(403, SECURITY_HEADERS); res.end('Forbidden'); return;
  }

  if (!fs.existsSync(filePath)) {
    res.writeHead(404, SECURITY_HEADERS); res.end('Not found'); return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME[ext] ?? 'application/octet-stream';

  // P5-3: apply brotli negotiation (only affects .wasm/.js; transparent to client URL)
  const accept = req.headers['accept-encoding'] || '';
  const picked = pickWasmPath(filePath, accept);
  const headers = { ...SECURITY_HEADERS, 'Content-Type': contentType, 'Vary': 'Accept-Encoding' };
  if (picked.encoding === 'br') headers['Content-Encoding'] = 'br';

  res.writeHead(200, headers);

  fs.createReadStream(picked.path).pipe(res);
}).listen(port, () => {
  console.log(`Dev server: http://localhost:${port}  (root: ${root})`);
  console.log(`Home:       http://localhost:${port}/web/index.html`);
  console.log('COOP/COEP active → SharedArrayBuffer available → simd-mt WASM tier');
});
