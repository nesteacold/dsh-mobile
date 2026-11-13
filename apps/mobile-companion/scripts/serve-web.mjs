#!/usr/bin/env node
// Loopback static server for the BUILT PWA (dist/), used as the origin behind
// `tailscale serve --https=18443 http://127.0.0.1:<port>`.
//
// WHY NOT `npx serve`: docs/web-pwa.md §"Hosting requirements" lists headers the app cannot express.
// `frame-ancestors` inside the <meta> CSP is IGNORED by browsers, so the clickjacking guard only
// exists if the host sends it as a response header. This server sends the full policy as a header
// (the meta copy stays for `file://` review) plus the content types the service worker needs.
//
// Loopback only, by construction: it hard-refuses any --host that is not 127.0.0.1. TLS is
// Tailscale's job (the tailnet certificate), so this server speaks plain HTTP on 127.0.0.1.
//
// Read-only GET/HEAD surface: anything else is 405. Paths are decoded ONCE and then refused unless
// every component is a plain name (no `.`/`..`, no dotfiles, no `*.map`), so nothing under dist can
// reach files outside it. Belt and braces on top of that: each segment must not be a symlink or a
// reparse point (junction), which a name check alone cannot catch — a junction named `assets` is
// an ordinary name that points elsewhere — and the final realpath must still sit inside the
// realpathed root. Every fs error becomes a generic 404/500: a thrown exception would crash the
// whole server (an uncaught throw in a request handler takes the process down), and the message
// would echo a filesystem path to the caller.
//
// Usage: node scripts/serve-web.mjs [--port 18480] [--host 127.0.0.1] [--dir dist]

import { createServer } from 'node:http';
import { readFileSync, statSync, lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Same directives the build injects as <meta>, sent as a header so they are all enforced
// (notably frame-ancestors, which a meta element cannot carry).
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  // The SAME-ORIGIN gateway socket is admitted by `wss://*.ts.net:*`: the PWA and the gateway share
  // one tailnet HTTPS origin (`tailscale serve` routes `/ws/mobile` to the listener), and the
  // derived address is always `<name>.ts.net:<port>` — a host-part suffix match with any port.
  // `'self'` stays as a second, belt-and-braces allowance. No host is hardcoded and `wss://*` is
  // deliberately absent. Keep in step with scripts/build-web.mjs, which injects the same policy as
  // a <meta>.
  "connect-src 'self' wss://*.ts.net:*",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.css': 'text/css; charset=utf-8',
};

// The manifest is advertised as application/manifest+json (docs/web-pwa.md §3); the `types`
// option below is what lets a browser parse it as a manifest at all.
const typeFor = (file) => (file.endsWith('manifest.json') ? 'application/manifest+json' : TYPES[path.extname(file)] || 'application/octet-stream');

const baseHeaders = () => ({
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-cache',
});

// `error` is a bare level string on purpose: no exception text, no filesystem path reaches the
// caller, and no async throw can escape into an unhandled rejection.
const send = (res, status, extra = {}) => {
  res.writeHead(status, { ...baseHeaders(), 'Content-Type': 'text/plain', ...extra }).end();
};

// Windows reports junctions as other-reparse points, not symlinks; both must be refused.
const isLink = (stats) => stats.isSymbolicLink() || (typeof stats.isReparsePoint === 'function' && stats.isReparsePoint());

const inside = (root, target) => {
  const rel = path.relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};

/**
 * Map a request pathname to a servable absolute file, or null when nothing may be served.
 * `root` must already be realpathed. Throws only on unexpected fs errors (caught by the caller).
 */
const resolveFile = (root, pathname) => {
  // Root and a bare '/' both mean the single page app's entry.
  // `/pair` is the pairing-code link's entry (`/pair#a=…&c=…`, the fragment never reaches here):
  // the single page app serves it, as it serves `/`.
  const rel = pathname === '/' || pathname === '' || pathname === '/pair' || pathname === '/pair/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const segments = rel.split(/[\\/]/);
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return null;
    if (segment.startsWith('.')) return null; // dotfiles (.git, .env, .DS_Store, ...) stay private
    if (segment.toLowerCase().endsWith('.map')) return null; // source maps expose the source tree
  }
  const candidate = path.join(root, ...segments);
  if (!inside(root, candidate)) return null;

  // Walk one segment at a time so the component that IS the link is named; lstat does not follow it.
  let walked = root;
  for (const segment of segments) {
    walked = path.join(walked, segment);
    if (isLink(lstatSync(walked))) return null;
  }
  const real = realpathSync(candidate);
  if (!inside(root, real)) return null;
  if (!statSync(real).isFile()) return null;
  return real;
};

/**
 * Start the static server. Resolves once listening; `port` 0 picks an ephemeral port.
 */
export function startServeWeb({ dir, host = '127.0.0.1', port = 18480 } = {}) {
  if (host !== '127.0.0.1' || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`serve-web: refusing host=${host} port=${port} (loopback 127.0.0.1 only)`);
  }
  const requested = path.resolve(dir ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist'));
  const root = realpathSync(requested);
  try {
    if (!statSync(path.join(root, 'index.html')).isFile() || !statSync(path.join(root, 'sw.js')).isFile()) {
      throw new Error('missing');
    }
  } catch {
    throw new Error(`serve-web: ${root} is not a built PWA (run npm run build:web)`);
  }

  const server = createServer((req, res) => {
    try {
      const method = req.method || 'GET';
      if (method !== 'GET' && method !== 'HEAD') {
        send(res, 405, { Allow: 'GET, HEAD' });
        return;
      }
      let pathname;
      try {
        pathname = decodeURIComponent(new URL(req.url || '/', 'http://x').pathname);
      } catch {
        send(res, 400);
        return;
      }
      let file;
      try {
        file = resolveFile(root, pathname);
      } catch {
        // A miss mid-walk (ENOENT/ENOTDIR) or any other fs failure: the caller learns nothing.
        send(res, 404);
        return;
      }
      if (file === null) {
        send(res, 404);
        return;
      }
      let body;
      try {
        body = readFileSync(file);
      } catch {
        send(res, 404);
        return;
      }
      // A HEAD response carries the same headers a GET would, including Content-Length, and no body.
      res.writeHead(200, { ...baseHeaders(), 'Content-Type': typeFor(file), 'Content-Length': body.length });
      res.end(method === 'HEAD' ? undefined : body);
    } catch {
      try {
        send(res, 500);
      } catch {
        // The socket is already gone; nothing left to answer.
      }
    }
    // No unhandled 'error' on req/res is possible here: a throwing handler is wrapped above.
  });

  // A dead listen (EADDRINUSE) must reject, not crash the process.
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve({ server, port: server.address().port, host });
    });
  });
}

const main = async () => {
  const argOf = (flag, fallback) => {
    const index = process.argv.indexOf(flag);
    return index === -1 ? fallback : process.argv[index + 1];
  };
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const PORT = Number(argOf('--port', '18480'));
  const HOST = argOf('--host', '127.0.0.1');
  const DIR = path.resolve(ROOT, argOf('--dir', 'dist'));
  try {
    const { port, host } = await startServeWeb({ dir: DIR, host: HOST, port: PORT });
    console.log(`serve-web: ${realpathSync(DIR)} on http://${host}:${port} (pid ${process.pid})`);
  } catch (error) {
    console.error(`serve-web: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
};

// Only run when invoked as a script; `import` (the test) must not bind a port.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
