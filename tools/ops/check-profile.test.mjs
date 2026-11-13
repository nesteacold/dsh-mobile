// Tests for tools/ops/check-profile.mjs. Run: node --test tools/ops/check-profile.test.mjs
//
// Every case builds a throwaway "profile" directory in the OS temp dir — a package.json, a
// pnpm-lock.yaml importer and real node_modules symlinks/junctions to sibling "checkout" folders —
// then runs the checker as a child process and asserts the exit code and the table it prints. The
// real %USERPROFILE% is never read: --home and --profile-dir are always passed.
//
// The fixtures are built by code, so this file carries no machine path, host name or account name.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECKER = join(HERE, 'check-profile.mjs');

/** A temp tree with a home, two "checkouts" and a profile inside it. */
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'check-profile-'));
  const home = join(root, 'home');
  const profile = join(home, '.dsh', 'profiles', 'desktop');
  mkdirSync(profile, { recursive: true });
  return { root, home, profile };
}

/** A sibling checkout that can be linked to. */
function checkout(root, name) {
  const dir = join(root, 'checkouts', name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Write package.json + pnpm-lock.yaml + node_modules links for a profile.
 * `links` maps a package name to the absolute checkout path it should point at, per source:
 *   { declared, locked, linked } — the three places drift can appear independently.
 */
function writeProfile(profile, { links, extraDeps = {}, sections = {} }) {
  const dependencies = {};
  for (const [name, spec] of Object.entries(links)) {
    dependencies[name] = `link:${spec.declared ?? spec.linked ?? spec.locked}`;
  }
  Object.assign(dependencies, extraDeps);
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'dsh-profile-test', private: true, dependencies }, null, 2));

  const entries = [];
  for (const [name, spec] of Object.entries(links)) {
    // What the lockfile records is the state at the last install: the specifier copied verbatim
    // from package.json *then* (absolute), and the version as a path relative to the profile.
    const recorded = spec.locked ?? spec.declared ?? spec.linked;
    const relativeTarget = relative(profile, recorded).split('\\').join('/');
    entries.push(
      `      '${name}':`,
      `        specifier: link:${recorded.split('\\').join('/')}`,
      `        version: link:${relativeTarget}`,
    );
  }
  for (const [name, spec] of Object.entries(extraDeps)) {
    entries.push(`      '${name}':`, `        specifier: ${spec}`, `        version: ${spec.replace(/^\^/, '')}`);
  }
  const body = entries.length === 0 ? '    dependencies: {}\n' : `    dependencies:\n${entries.join('\n')}\n`;
  writeFileSync(join(profile, 'pnpm-lock.yaml'), `lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n${body}\npackages: {}\n`);

  const modules = join(profile, 'node_modules');
  mkdirSync(modules, { recursive: true });
  for (const [name, spec] of Object.entries(links)) {
    const linkedTarget = spec.linked ?? spec.declared ?? spec.locked;
    const linkPath = join(modules, ...name.split('/'));
    mkdirSync(dirname(linkPath), { recursive: true });
    if (spec.asCopy === true) {
      // An installed copy rather than a link: the case that silently stops following the checkout.
      mkdirSync(linkPath, { recursive: true });
      writeFileSync(join(linkPath, 'index.js'), '// copy\n');
      continue;
    }
    // 'junction' works without elevation on Windows for directories; elsewhere it is a symlink.
    symlinkSync(linkedTarget, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
  }
  return { dependencies, ...sections };
}

function run(args) {
  // The harness that runs these tests exports DSH_HOME / DSH_PROFILE / DSH_PROFILE_DIR for the live
  // session. Inheriting them would point the checker at the developer's real profile, so this
  // fixture strips them: every case is about the directory the test just built.
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith('DSH_')) env[name] = value;
  }
  const r = spawnSync(process.execPath, [CHECKER, ...args], { encoding: 'utf8', env });
  return { status: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout, stderr: r.stderr };
}

/** Every run passes --home so redaction and DSH_HOME never touch the real profile. */
const argsFor = (box, profile = box.profile) => ['--profile-dir', profile, '--home', box.home];

test('three-way agreement exits 0 and prints one ok row per link', () => {
  const box = sandbox();
  const gateway = checkout(box.root, 'mobile-gateway');
  const devices = checkout(box.root, 'devices');
  writeProfile(box.profile, { links: { '@dsh-ext/mobile-gateway': { declared: gateway }, '@dsh-ext/devices': { declared: devices } } });

  const r = run(argsFor(box));
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /@dsh-ext\/mobile-gateway/);
  assert.equal((r.stdout.match(/\bok\b/g) ?? []).length, 2);
  assert.doesNotMatch(r.stdout, /DRIFT/);
  assert.match(r.stderr, /all 2 link\(s\) agree/);
  rmSync(box.root, { recursive: true, force: true });
});

test('package.json moved ahead of the lockfile is drift (exit 1)', () => {
  const box = sandbox();
  const oldDir = checkout(box.root, 'old-place');
  const newDir = checkout(box.root, 'new-place');
  // The owner edited package.json to a re-cloned checkout; the lockfile still records the old one,
  // and node_modules still points at it.
  writeProfile(box.profile, { links: { '@dsh-ext/mobile-gateway': { declared: newDir, locked: oldDir, linked: oldDir } } });

  const r = run(argsFor(box));
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /DRIFT/);
  assert.match(r.out, /lockfile target is /);
  assert.match(r.out, /node_modules target is /);
  assert.match(r.stderr, /DRIFT in 1\/1 link\(s\)/);
  rmSync(box.root, { recursive: true, force: true });
});

test('a stale node_modules link alone is drift, even when the lockfile is current', () => {
  const box = sandbox();
  const wanted = checkout(box.root, 'wanted');
  const stale = checkout(box.root, 'stale');
  writeProfile(box.profile, { links: { '@dsh-ext/devices': { declared: wanted, locked: wanted, linked: stale } } });

  const r = run(argsFor(box));
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /node_modules target is /);
  assert.doesNotMatch(r.out, /lockfile target is /);
  rmSync(box.root, { recursive: true, force: true });
});

test('an equivalent relative spelling in the lockfile is not drift', () => {
  const box = sandbox();
  const target = checkout(box.root, 'target');
  // pnpm writes `version: link:../../../../checkouts/target` — a relative path — while package.json
  // holds the absolute one. Same directory, so this must pass.
  writeProfile(box.profile, { links: { '@dsh-ext/devices': { declared: target } } });
  const lock = readFileSync(join(box.profile, 'pnpm-lock.yaml'), 'utf8');
  assert.match(lock, /version: link:\.\.\//, 'the fixture really writes a relative version');

  const r = run(argsFor(box));
  assert.equal(r.status, 0, r.out);
  assert.doesNotMatch(r.stdout, /DRIFT/);
  rmSync(box.root, { recursive: true, force: true });
});

test('a lockfile that records a registry version where a link was asked for is drift', () => {
  const box = sandbox();
  const target = checkout(box.root, 'target');
  writeProfile(box.profile, { links: { '@dsh-ext/mobile-gateway': { declared: target } } });
  const lock = readFileSync(join(box.profile, 'pnpm-lock.yaml'), 'utf8')
    .replace(/^ {8}specifier: link:.*$/m, '        specifier: ^0.12.0')
    .replace(/^ {8}version: link:.*$/m, '        version: 0.12.0');
  writeFileSync(join(box.profile, 'pnpm-lock.yaml'), lock);

  const r = run(argsFor(box));
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /not a link/);
  rmSync(box.root, { recursive: true, force: true });
});

test('a missing node_modules link is drift, not an empty success', () => {
  const box = sandbox();
  const target = checkout(box.root, 'target');
  writeProfile(box.profile, { links: { '@dsh-ext/mobile-gateway': { declared: target } } });
  rmSync(join(box.profile, 'node_modules', '@dsh-ext', 'mobile-gateway'), { recursive: true, force: true });

  const r = run(argsFor(box));
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /node_modules entry is missing/);
  assert.match(r.out, /\(missing\)/);
  rmSync(box.root, { recursive: true, force: true });
});

test('an installed copy where a link belongs is drift', () => {
  const box = sandbox();
  const target = checkout(box.root, 'target');
  writeProfile(box.profile, { links: { '@dsh-ext/devices': { declared: target, asCopy: true } } });

  const r = run(argsFor(box));
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /node_modules entry is a directory, not a symlink/);
  rmSync(box.root, { recursive: true, force: true });
});

test('a dependency missing from the lockfile is drift', () => {
  const box = sandbox();
  const target = checkout(box.root, 'target');
  writeProfile(box.profile, { links: { '@dsh-ext/mobile-gateway': { declared: target } } });
  // Re-write the lockfile with no importer entries at all, keeping the link in node_modules.
  writeFileSync(join(box.profile, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies: {}\n");

  const r = run(argsFor(box));
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /not in the lockfile/);
  assert.match(r.out, /\(absent\)/);
  rmSync(box.root, { recursive: true, force: true });
});

test('registry dependencies are counted, not checked', () => {
  const box = sandbox();
  const target = checkout(box.root, 'target');
  writeProfile(box.profile, { links: { '@dsh-ext/devices': { declared: target } }, extraDeps: { 'left-pad': '^1.3.0' } });

  const r = run(argsFor(box));
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /1 registry dependency not checked/);
  rmSync(box.root, { recursive: true, force: true });
});

test('printed output redacts the home directory, wherever a path is echoed', () => {
  const box = sandbox();
  const elsewhere = checkout(box.root, 'elsewhere');
  // A second "home" stands in for the account name: it appears in the lockfile specifier, which is
  // the one place a raw path is printed verbatim (the columns go through `show`).
  const home2 = join(box.root, 'another-home');
  mkdirSync(home2, { recursive: true });
  writeProfile(box.profile, { links: { '@dsh-ext/mobile-gateway': { declared: elsewhere } } });
  const lock = readFileSync(join(box.profile, 'pnpm-lock.yaml'), 'utf8')
    .replace(/^ {8}specifier: link:.*$/m, `        specifier: link:${home2.split('\\').join('/')}/plugins/x`)
    .replace(/^ {8}version: link:.*$/m, `        version: link:${home2.split('\\').join('/')}/plugins/x`);
  writeFileSync(join(box.profile, 'pnpm-lock.yaml'), lock);

  const r = run(['--profile-dir', box.profile, '--home', home2]);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /lockfile target is ~\//, 'the home prefix is folded to ~ in the table');
  assert.ok(!r.out.includes(home2), `the raw home path must not appear:\n${r.out}`);
  assert.ok(!r.out.includes('another-home'), `the account-side path must not appear:\n${r.out}`);
  rmSync(box.root, { recursive: true, force: true });
});

test('a profile with no link: dependencies is "cannot inspect" (exit 2), not a pass', () => {
  const box = sandbox();
  writeProfile(box.profile, { links: {}, extraDeps: { 'left-pad': '^1.3.0' } });

  const r = run(argsFor(box));
  assert.equal(r.status, 2, r.out);
  assert.match(r.stderr, /nothing to check/);
  rmSync(box.root, { recursive: true, force: true });
});

test('a profile that was never installed is exit 2, not drift', () => {
  const box = sandbox();
  writeFileSync(join(box.profile, 'package.json'), JSON.stringify({ name: 'p', private: true, dependencies: { '@dsh-ext/devices': 'link:/nonexistent/devices' } }));

  const r = run(argsFor(box));
  assert.equal(r.status, 2, r.out);
  assert.match(r.stderr, /has never been installed/);
  rmSync(box.root, { recursive: true, force: true });
});

test('an unreadable lockfile is exit 2 with the reason, never a silent pass', () => {
  const box = sandbox();
  const target = checkout(box.root, 'target');
  writeProfile(box.profile, { links: { '@dsh-ext/devices': { declared: target } } });
  writeFileSync(join(box.profile, 'pnpm-lock.yaml'), 'this: is not\n  a pnpm lockfile\n');

  const r = run(argsFor(box));
  assert.equal(r.status, 2, r.out);
  assert.match(r.stderr, /cannot read/);
  assert.match(r.stderr, /no `importers:` section/);
  rmSync(box.root, { recursive: true, force: true });
});

test('--quiet prints no table but keeps the verdict', () => {
  const box = sandbox();
  const wanted = checkout(box.root, 'wanted');
  const stale = checkout(box.root, 'stale');
  writeProfile(box.profile, { links: { '@dsh-ext/devices': { declared: wanted, locked: wanted, linked: stale } } });

  const r = run([...argsFor(box), '--quiet']);
  assert.equal(r.status, 1, r.out);
  assert.equal(r.stdout.trim(), '');
  assert.match(r.stderr, /DRIFT in 1\/1/);
  rmSync(box.root, { recursive: true, force: true });
});

test('the default profile is resolved from the home directory at runtime, not hardcoded', () => {
  const box = sandbox();
  // The checkout sits INSIDE the home so every printed cell must fold to `~/...`: an absolute
  // spelling anywhere in the row is then a real redaction failure. (A sibling checkout is printed
  // absolute on purpose — the operator has to see where a drifted link points — and asserting
  // "the temp path never appears" against it only held on Windows, where `toPosix` makes the
  // backslash spelling of the fixture root fail to match the forward-slash spelling it prints.)
  const target = checkout(box.home, 'target');
  writeProfile(box.profile, { links: { '@dsh-ext/mobile-gateway': { declared: target } } });

  // No --profile-dir and no --profiles-root: only --home, so DSH_HOME derives as <home>/.dsh and the
  // one profile under <home>/.dsh/profiles is chosen.
  const r = run(['--home', box.home]);
  assert.equal(r.status, 0, r.out);
  assert.match(r.stdout, /profile: ~\/\.dsh\/profiles\/desktop/);
  assert.match(r.stdout, /~\/checkouts\/target/, 'a home-relative link target is printed as ~/...');
  assert.ok(!r.stdout.includes(box.root), `the temp path must be redacted:\n${r.stdout}`);
  rmSync(box.root, { recursive: true, force: true });
});

test('several profiles without --profile is exit 2: it never guesses which tree to check', () => {
  const box = sandbox();
  const target = checkout(box.root, 'target');
  writeProfile(box.profile, { links: { '@dsh-ext/mobile-gateway': { declared: target } } });
  const second = join(box.home, '.dsh', 'profiles', 'other');
  mkdirSync(second, { recursive: true });

  const r = run(['--home', box.home]);
  assert.equal(r.status, 2, r.out);
  assert.match(r.stderr, /several profiles/);
  rmSync(box.root, { recursive: true, force: true });
});

test('the checker never writes: the profile files are byte-identical after a run', () => {
  const box = sandbox();
  const target = checkout(box.root, 'target');
  writeProfile(box.profile, { links: { '@dsh-ext/devices': { declared: target } } });
  const linkPath = join(box.profile, 'node_modules', '@dsh-ext', 'devices');
  const before = {
    manifest: readFileSync(join(box.profile, 'package.json'), 'utf8'),
    lock: readFileSync(join(box.profile, 'pnpm-lock.yaml'), 'utf8'),
    linkTarget: readlinkSync(linkPath),
  };

  const r = run(argsFor(box));
  assert.equal(r.status, 0, r.out);
  assert.equal(readFileSync(join(box.profile, 'package.json'), 'utf8'), before.manifest);
  assert.equal(readFileSync(join(box.profile, 'pnpm-lock.yaml'), 'utf8'), before.lock);
  assert.equal(readlinkSync(linkPath), before.linkTarget);
  assert.deepEqual(
    readdirSync(box.profile).sort(),
    ['node_modules', 'package.json', 'pnpm-lock.yaml'],
    'no file is created next to the profile',
  );
  rmSync(box.root, { recursive: true, force: true });
});
