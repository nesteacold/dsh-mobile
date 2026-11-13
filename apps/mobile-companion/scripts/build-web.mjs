#!/usr/bin/env node
// PWA web build (spec 020 requirements 4 + 7): `expo export --platform web`, then inject the
// manifest link, the CSP and the service-worker registration into the generated HTML shell.
//
// WHY A POST-PROCESS STEP: `expo export` generates `index.html` itself and this app has no
// `app/+html.tsx`; the PWA tags have to be added to the emitted shell. Injecting them here keeps
// the change inside the build script (no framework file is edited) and makes the CSP auditable in
// one place. The step is idempotent: re-running it never duplicates a tag.
//
// CSP NOTES (reviewer: read):
//   * `script-src 'self'` — no inline scripts, no eval, no CDN. The SW is registered from an
//     external `register-sw.js`.
//   * `connect-src 'self' wss: https:` — the app talks to the Host over `wss://<host>.ts.net`,
//     which is a different origin; the transport relies on the browser CA store (no pinning), so
//     this must be allowed. There is no way to pin a certificate in a browser (spec 020 §owner).
//   * `style-src 'self' 'unsafe-inline'` — react-native-web emits inline style attributes; an
//     attribute-level style is not covered by `style-src` directives in CSP2, but RN-web also
//     injects <style> tags, so 'unsafe-inline' is required for styles only (never for scripts).
//   * `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'` — hardening.
//   * Deliberately NO `worker-src`/`service-worker` relaxation beyond 'self'.

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_DIR = path.join(ROOT, 'dist');
const INDEX = path.join(OUT_DIR, 'index.html');

/**
 * The files the service worker precaches at install (`/precache.json`, read by `public/sw.js`).
 *
 * Why the build writes this: the shell's bundles are content-hashed, so only the build knows their
 * names. Without a precache a FIRST visit never fills the cache (nothing is controlled yet, so those
 * requests bypass the worker) and an offline reload fails — found by an offline reload test.
 *
 * Positive allowlist, like the worker's own: the HTML shell (`/`), hashed bundles/assets under
 * `_expo/static/`, and the static shell files. `sw.js` itself, this list and `metadata.json` are
 * never listed. Pure: it takes the output directory's file list, so it is unit-testable.
 */
export function buildPrecacheList(relativeFiles) {
  const SHELL_FILES = ['manifest.json', 'icon.svg', 'icon-maskable.svg', 'register-sw.js'];
  const normalised = relativeFiles.map((file) => file.split(path.sep).join('/'));
  const list = ['/'];
  for (const file of normalised.slice().sort()) {
    if (file.startsWith('_expo/static/') || SHELL_FILES.includes(file)) list.push(`/${file}`);
  }
  return list;
}

/** Every regular file under `dir`, relative to it (forward-slash independent). */
function listFiles(dir, base = dir) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...listFiles(full, base));
    else found.push(path.relative(base, full));
  }
  return found;
}

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  // `wss://*.ts.net:*` — the port is explicit on purpose: port 443 on the tailnet is already used
  // by another service (owner decision 2026-11-11, spec 020 §Port), so the Host listens on e.g.
  // 8443 and a port-less source expression would not match it. `https:` is NOT allowed: the app
  // makes no cross-origin HTTP request (the API rides the same-origin shell or the WSS socket).
  //
  // SAME-ORIGIN case (owner decision 2026-11-13): the PWA and the gateway share one tailnet HTTPS
  // origin, and the socket is `wss://<location.host>/ws/mobile` on it. The wildcard above is what
  // admits it: `*.ts.net` is a host-part suffix match and `*` is any port, so the page's own
  // `<name>.ts.net:<port>` is covered — and `src/core/gateway-address.ts` derives nothing else.
  // `'self'` stays as a second, belt-and-braces allowance; the derivation never depends on CSP3's
  // `'self'` scheme-upgrade rule being implemented. No source expression hardcodes the machine
  // name, and `wss://*` is deliberately not added: it would re-open every host.
  "connect-src 'self' wss://*.ts.net:*",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** Tags this script owns; any previous copy is stripped first so the step is idempotent. */
const MANAGED = [
  /<meta http-equiv="Content-Security-Policy"[^>]*>\s*/gi,
  /<link rel="manifest"[^>]*>\s*/gi,
  /<link rel="icon"[^>]*>\s*/gi,
  /<link rel="apple-touch-icon"[^>]*>\s*/gi,
  /<meta name="theme-color"[^>]*>\s*/gi,
  /<script src="\/register-sw\.js"[^>]*><\/script>\s*/gi,
];

function inject(html) {
  let output = html;
  for (const pattern of MANAGED) output = output.replace(pattern, '');
  const tags = [
    `<meta http-equiv="Content-Security-Policy" content="${CSP}">`,
    '<link rel="manifest" href="/manifest.json">',
    // An explicit icon stops the browser from falling back to `/favicon.ico`, which this export does
    // not contain (it produced a 404 in the console on every load). SVG only: one asset, no binary.
    '<link rel="icon" type="image/svg+xml" href="/icon.svg">',
    '<link rel="apple-touch-icon" href="/icon.svg">',
    '<meta name="theme-color" content="#0b1220">',
    '<script src="/register-sw.js" defer></script>',
  ].join('\n    ');
  if (output.includes('</head>')) return output.replace('</head>', `    ${tags}\n  </head>`);
  // No <head> (unexpected shell shape): prepend so the tags still apply, and say so loudly.
  console.warn('build-web: index.html has no </head>; tags prepended');
  return `${tags}\n${output}`;
}

function main() {
  const skipExport = process.argv.includes('--skip-export');
  if (!skipExport) {
    // Run the Expo CLI through this Node executable: no shell, so no argument-escaping hazard and
    // no `shell: true` (Windows .cmd shims are the only reason one might reach for it).
    const expoCli = path.join(ROOT, 'node_modules', 'expo', 'bin', 'cli');
    const result = spawnSync(
      process.execPath,
      [expoCli, 'export', '--platform', 'web', '--output-dir', 'dist'],
      { cwd: ROOT, stdio: 'inherit' },
    );
    if (result.status !== 0) {
      console.error(`build-web: expo export failed (status ${String(result.status)})`);
      process.exit(result.status ?? 1);
    }
  }
  if (!existsSync(INDEX)) {
    console.error(`build-web: ${INDEX} was not produced by the export`);
    process.exit(1);
  }
  const before = readFileSync(INDEX, 'utf8');
  const after = inject(before);
  writeFileSync(INDEX, after, 'utf8');
  const injected = ['Content-Security-Policy', 'rel="manifest"', 'register-sw.js', 'rel="icon"'].filter((needle) => after.includes(needle));
  console.log(`build-web: injected ${injected.length}/4 PWA tags into dist/index.html (${injected.join(', ')})`);
  for (const asset of ['manifest.json', 'sw.js', 'register-sw.js', 'icon.svg']) {
    if (!existsSync(path.join(OUT_DIR, asset))) console.warn(`build-web: WARNING ${asset} missing from dist/ (public/ not copied?)`);
  }
  const precache = buildPrecacheList(listFiles(OUT_DIR));
  writeFileSync(path.join(OUT_DIR, 'precache.json'), `${JSON.stringify(precache, null, 2)}\n`, 'utf8');
  console.log(`build-web: wrote precache.json (${precache.length} entries)`);
}

// Run only as a script: importing this file (the unit test does) must not start a build.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main();
