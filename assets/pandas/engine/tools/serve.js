// Dev static server for the preview + the browser golden-trace page.
//
// Why this exists instead of `python3 -m http.server`: that server sends no
// `Cache-Control` and no `ETag`, only `Last-Modified`. Browsers then apply *heuristic*
// caching to ES modules and may serve a stale one without ever revalidating — so after
// an edit you get errors describing the code as it was, not as it is. The classic
// symptom is a `SyntaxError: doesn't provide an export named 'X'` for an export that
// demonstrably exists in the file on disk (and in the response body).
//
// So: every response here is `no-store`. Reload always fetches the real module graph,
// and a plain refresh is enough — no hard-reload discipline required.
//
// Zero dependencies, Node built-ins only, like everything else in this directory.
//   node tools/serve.js [--port 8137] [--root <dir>]

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname, relative, isAbsolute } from 'node:path';

const ENGINE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.map': 'application/json; charset=utf-8',
};

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const port = Number(arg('port', 8137));
const root = isAbsolute(arg('root', ENGINE_DIR)) ? arg('root', ENGINE_DIR) : join(process.cwd(), arg('root', ENGINE_DIR));

const server = createServer(async (req, res) => {
  // Strip the query (the preview and golden.html both take `?ticks=`/`?seed=`) and
  // decode, then resolve inside the root — a path that escapes it is rejected rather
  // than served.
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  const target = join(root, normalize(urlPath));
  const rel = relative(root, target);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('403 outside the served root\n');
    return;
  }

  try {
    let file = target;
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
      // The whole point of this file.
      'Cache-Control': 'no-store, must-revalidate',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    res.end(`404 ${urlPath}\n`);
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`port ${port} is already in use — something else is serving.`);
    console.error(`  lsof -nP -iTCP:${port} -sTCP:LISTEN     # what is it`);
    console.error(`  node tools/serve.js --port ${port + 1}  # or just use another port`);
    process.exit(1);
  }
  throw err;
});

server.listen(port, () => {
  console.log(`panda-engine dev server (no-store) serving ${root}`);
  console.log(`  preview:  http://localhost:${port}/tools/preview.html`);
  console.log(`  goldens:  http://localhost:${port}/tools/golden.html?ticks=10000`);
});
