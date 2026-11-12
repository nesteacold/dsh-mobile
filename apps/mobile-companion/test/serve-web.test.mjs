// scripts/serve-web.mjs — the loopback static server behind `tailscale serve`.
//
// This is the only surface that publishes the built PWA to the tailnet, so a path that escapes
// dist/ is not a bug in a helper: it is the whole source tree (src/, .env, credentials) being
// downloadable from a URL. Every case below is a reviewer-found hole or the header contract the
// PWA depends on (docs/web-pwa.md §"Hosting requirements").

import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { startServeWeb } from '../scripts/serve-web.mjs';

// Raw request: assert on status, headers and the literal body — `fetch` would hide the HEAD body
// rule and follow nothing on Windows, so keep it primitive.
const get = (port, pathname, method = 'GET') =>
  new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: pathname, method }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });

describe('serve-web: path containment and header contract', () => {
  let tmp;
  let root;
  let outside;
  let port;
  let server;

  before(async () => {
    tmp = mkdtempSync(path.join(tmpdir(), 'serve-web-'));
    root = path.join(tmp, 'dist');
    outside = path.join(tmp, 'outside');
    mkdirSync(root);
    mkdirSync(outside);
    mkdirSync(path.join(root, 'assets'));
    writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>pwa</title>');
    writeFileSync(path.join(root, 'sw.js'), '// service worker');
    writeFileSync(path.join(root, 'manifest.json'), '{"name":"companion"}');
    writeFileSync(path.join(root, 'assets', 'main.js'), 'console.log("main")');
    // Secrets a traversal or link would otherwise expose.
    writeFileSync(path.join(root, '.env'), 'TOKEN=leak-me');
    writeFileSync(path.join(root, 'assets', 'main.js.map'), '{"sources":["../../src/app.ts"]}');
    writeFileSync(path.join(tmp, 'secret.txt'), 'outside-the-root');
    writeFileSync(path.join(outside, 'secret.txt'), 'outside-the-root');
    // A junction named like an ordinary asset: a name check cannot see this.
    symlinkSync(outside, path.join(root, 'junction'), 'junction');
    ({ server, port } = await startServeWeb({ dir: root, port: 0 }));
  });

  after(() => {
    server.closeAllConnections();
    server.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('serves the entry page and assets from dist', async () => {
    const index = await get(port, '/');
    assert.equal(index.status, 200);
    assert.match(String(index.headers['content-type']), /text\/html/);
    assert.match(index.body.toString(), /pwa/);
    const asset = await get(port, '/assets/main.js');
    assert.equal(asset.status, 200);
    assert.match(String(asset.headers['content-type']), /javascript/);
    const manifest = await get(port, '/manifest.json');
    assert.equal(manifest.headers['content-type'], 'application/manifest+json');
  });

  it('keeps the CSP / nosniff / referrer headers on every response', async () => {
    for (const pathname of ['/', '/nope', '/.env']) {
      const res = await get(port, pathname);
      assert.match(String(res.headers['content-security-policy']), /frame-ancestors 'none'/);
      assert.equal(res.headers['x-content-type-options'], 'nosniff');
      assert.equal(res.headers['referrer-policy'], 'no-referrer');
    }
  });

  it('404s plain and encoded traversal, never echoing a filesystem path', async () => {
    for (const pathname of ['/../secret.txt', '/assets/../../secret.txt', '/%2e%2e/secret.txt', '/assets/%2e%2e%2f%2e%2e%2fsecret.txt', '/..%5csecret.txt']) {
      const res = await get(port, pathname);
      assert.equal(res.status, 404, pathname);
      assert.doesNotMatch(res.body.toString(), /outside-the-root|serve-web-|dist\\\\/i);
    }
  });

  it('404s a junction pointing outside dist (both as a component and as the leaf)', async () => {
    for (const pathname of ['/junction/secret.txt', '/junction/']) {
      const res = await get(port, pathname);
      assert.equal(res.status, 404, pathname);
      assert.doesNotMatch(res.body.toString(), /outside-the-root/);
    }
  });

  it('404s dotfiles and dot-segments, including nested ones', async () => {
    for (const pathname of ['/.env', '/.git/config', '/assets/.hidden']) {
      const res = await get(port, pathname);
      assert.equal(res.status, 404, pathname);
      assert.doesNotMatch(res.body.toString(), /leak-me/);
    }
  });

  it('404s every *.map request even when the file exists', async () => {
    for (const pathname of ['/assets/main.js.map', '/assets/main.js%2emap']) {
      const res = await get(port, pathname);
      assert.equal(res.status, 404, pathname);
    }
  });

  it('405s POST/PUT/DELETE with Allow: GET, HEAD', async () => {
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const res = await get(port, '/', method);
      assert.equal(res.status, 405, method);
      assert.equal(res.headers.allow, 'GET, HEAD');
      assert.equal(res.body.length, 0);
    }
  });

  it('HEAD returns the GET headers and no body', async () => {
    const head = await get(port, '/assets/main.js', 'HEAD');
    const full = await get(port, '/assets/main.js', 'GET');
    assert.equal(head.status, 200);
    assert.equal(head.headers['content-type'], full.headers['content-type']);
    assert.equal(head.headers['content-length'], full.headers['content-length']);
    assert.equal(head.body.length, 0);
  });

  it('survives malformed URLs and hostile requests without crashing', async () => {
    const malformed = await get(port, '/%E0%A4%A');
    assert.equal(malformed.status, 400);
    const deep = await get(port, '/assets/');
    assert.equal(deep.status, 404);
    // Still answering after all of the above: the handler never threw out of the socket callback.
    const alive = await get(port, '/');
    assert.equal(alive.status, 200);
  });

  it('refuses to start on a non-loopback host, and with a non-integer port', () => {
    for (const options of [{ dir: root, port: 0, host: '0.0.0.0' }, { dir: root, port: Number.NaN }]) {
      assert.throws(() => startServeWeb(options), /loopback 127\.0\.0\.1 only/);
    }
  });

  it('leaves a live server alone: a second bind on the same port rejects instead of exiting', async () => {
    await assert.rejects(startServeWeb({ dir: root, port }), (error) => error.code === 'EADDRINUSE');
  });
});
