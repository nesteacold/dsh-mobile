// Spec 021 — the web bootstrap's cold-start retry.
//
// The defect this guards: on a browser, `startup.ensure()` (→ `controller.start()`) loads the stored
// host list, and `pair()` refuses `client/bad-state` ("not ready") until that has happened. When the
// start failed, the web bootstrap kept rendering the pair screen — and the only retry in the layout,
// `attemptUnlock`, is the NATIVE gate's button, which web never renders because the Host's passkey is
// the gate there. So every pairing attempt was refused forever with no way out.
//
// The fix is in `app/_layout.tsx` only: the bootstrap shows the failure and a retry control that
// re-runs the same startup path. There is no component renderer in this repo (see
// test/ui-test-hooks.test.ts), so this test asserts the wiring against the source, and the retry
// SEMANTICS against the real `StartupSequence` the layout drives.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { StartupSequence, type StartupStatus } from '../src/core/startup';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LAYOUT = readFileSync(path.join(ROOT, 'app', '_layout.tsx'), 'utf8');
const I18N = readFileSync(path.join(ROOT, 'i18n', 'index.ts'), 'utf8');

/** The `WebBootstrap` function body: the retry control must live there, not in the native gate. */
function webBootstrapSource(source: string): string {
  const start = source.indexOf('function WebBootstrap(');
  assert.ok(start > 0, 'WebBootstrap is defined');
  const end = source.indexOf('function WebLockGate(', start);
  assert.ok(end > start, 'WebLockGate follows WebBootstrap');
  return source.slice(start, end);
}

describe('web bootstrap: a failed cold start is retryable', () => {
  const bootstrap = webBootstrapSource(LAYOUT);

  it('renders a retry control that re-runs the startup path', () => {
    assert.match(bootstrap, /testID="web-startup-retry"/, 'the retry button exists');
    assert.match(bootstrap, /onPress=\{onRetryStartup\}/, 'it calls the startup retry prop');
    // The root layout hands the bootstrap the same `ensure()` call the mount effect makes: not a
    // second attempt, not a bare `controller.start()` — one shared startup path.
    assert.match(LAYOUT, /onRetryStartup=\{\(\) => void runStartup\(\)\}/);
    assert.match(LAYOUT, /const started = await startup\.ensure\(\);/);
  });

  it('says why, and only while the start is pending or failed', () => {
    assert.match(bootstrap, /startupFailed \? 'startup\.failed' : 'startup\.starting'/);
    // Both locales carry the copy (the i18n suite also proves the tables stay key-for-key equal).
    for (const key of ['startup.failed', 'startup.retry', 'startup.starting']) {
      assert.match(I18N, new RegExp(`'${key.replace('.', '\\.')}'`), `${key} is declared`);
      assert.equal(I18N.match(new RegExp(`'${key.replace('.', '\\.')}':`, 'g'))?.length, 2, `${key} is in vi and en`);
    }
  });

  it('blocks the pair panel while startup is pending or failed', () => {
    // `pair()` is refused `client/bad-state` before the host list loads, so a press during a failed
    // start can only fail. The retry button sits OUTSIDE the blocked view and stays reachable.
    assert.match(bootstrap, /pointerEvents=\{startupFailed \|\| startupPending \? 'none' : 'auto'\}/);
    const notice = bootstrap.indexOf('testID="web-startup-notice"');
    const blocked = bootstrap.indexOf("pointerEvents={startupFailed || startupPending ? 'none' : 'auto'}");
    assert.ok(notice > 0 && blocked > notice, 'the notice (with retry) is rendered before the blocked body');
  });

  it('leaves the native gate alone', () => {
    // The retry state is fed only to the web bootstrap; the native branch keeps the A020 gate and
    // its own retry (`attemptUnlock`), unchanged.
    assert.equal(LAYOUT.match(/startupStatus=\{startupStatus\}/g)?.length, 1, 'one consumer, the web bootstrap');
    assert.match(LAYOUT, /gateMessage !== null \? <Text style=\{\[styles\.message/);
  });
});

describe('web bootstrap: the retry re-invokes the same startup', () => {
  /** The layout's `runStartup`, with the status a component would render from. */
  function harness(start: () => Promise<void>) {
    const startup = new StartupSequence({ start, reset: () => undefined });
    let status: StartupStatus = startup.status;
    const runStartup = async (): Promise<boolean> => {
      status = 'starting';
      const started = await startup.ensure();
      status = startup.status;
      return started;
    };
    return { startup, runStartup, status: () => status };
  }

  it('a failed start is reported, and the retry runs `start()` again and recovers', async () => {
    let starts = 0;
    const { runStartup, status } = harness(async () => {
      starts += 1;
      if (starts === 1) throw new Error('secure store unavailable');
    });

    assert.equal(await runStartup(), false);
    assert.equal(status(), 'failed');

    // What the retry button does: the SAME path, not a fresh sequence and not a bare start().
    assert.equal(await runStartup(), true);
    assert.equal(status(), 'ready');
    assert.equal(starts, 2, 'the retry actually re-read the hosts');
  });

  it('the pending frame is what the panel is blocked on, until the attempt settles', async () => {
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { runStartup, status } = harness(() => gate);

    const first = runStartup();
    assert.equal(status(), 'starting', 'a start in flight blocks pairing');

    release();
    assert.equal(await first, true);
    assert.equal(status(), 'ready', 'and releases it once the host list is loaded');
  });
});
