// The debug log's sink choice per platform (FR-011).
//
// On the web (PWA) build there is no `expo-file-system`, so a build made with
// `EXPO_PUBLIC_DSH_DEBUG_LOG=1` has to send the *same redacted* lines to the browser console, where
// the operator reads them in Safari/Chrome devtools. These cases pin exactly that:
//
//   * flag on  + web    → exactly one sink, and it writes `[dsh] <level> <text>` at the matching
//                         console level;
//   * flag off          → no sink at all, on either platform (a normal build records nothing);
//   * native            → the file sink, unchanged (no console output).
//
// The console is a recording stub: `DebugLog` and the sink never touch the real one here, and the web
// platform is passed in rather than forced into the shared `react-native` stub (the suite runs on
// `Platform.OS === 'android'`, and other test files share that stub).

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { DebugLog, type LogLine } from '../src/core/debug-log';
import { createDebugLogConsoleSink, debugLogSinksFromEnv } from '../src/platform/debug-log-file';

type Call = { method: 'log' | 'warn' | 'error'; text: string };

/** A `console`-shaped recorder: `DebugLog`'s sinks are write-only, so this is all it needs. */
function recordingConsole(): { target: Pick<Console, 'log' | 'warn' | 'error'>; calls: Call[] } {
  const calls: Call[] = [];
  const record = (method: Call['method']) => (text: string) => {
    calls.push({ method, text });
  };
  return { target: { log: record('log'), warn: record('warn'), error: record('error') }, calls };
}

function line(level: LogLine['level'], text: string): LogLine {
  return { at: Date.UTC(2026, 10, 16, 3, 4, 5, 6), level, text };
}

const previousFlag = process.env.EXPO_PUBLIC_DSH_DEBUG_LOG;

function setFlag(value: string | undefined): void {
  if (value === undefined) delete process.env.EXPO_PUBLIC_DSH_DEBUG_LOG;
  else process.env.EXPO_PUBLIC_DSH_DEBUG_LOG = value;
}

describe('debugLogSinksFromEnv', () => {
  beforeEach(() => setFlag(undefined));
  afterEach(() => setFlag(previousFlag));

  it('web + flag on: exactly one sink, writing "[dsh] <level> <text>" at the matching console level', () => {
    setFlag('1');
    const recorder = recordingConsole();
    const sinks = debugLogSinksFromEnv({ platform: 'web', console: recorder.target });

    assert.equal(sinks.length, 1);

    (sinks[0] as (l: LogLine) => void)(line('info', 'socket open'));
    (sinks[0] as (l: LogLine) => void)(line('warn', 'listener failed'));
    (sinks[0] as (l: LogLine) => void)(line('error', 'handshake timeout'));
    (sinks[0] as (l: LogLine) => void)(line('debug', 'tick'));

    assert.deepEqual(recorder.calls, [
      { method: 'log', text: '[dsh] info socket open' },
      { method: 'warn', text: '[dsh] warn listener failed' },
      { method: 'error', text: '[dsh] error handshake timeout' },
      { method: 'log', text: '[dsh] debug tick' },
    ]);
  });

  it('web + flag on: the text is passed through verbatim, never decorated with extra fields', () => {
    setFlag('1');
    const recorder = recordingConsole();
    const sinks = debugLogSinksFromEnv({ platform: 'web', console: recorder.target });
    const alreadyRedacted = 'pair rejected token=[redacted]';

    (sinks[0] as (l: LogLine) => void)(line('info', alreadyRedacted));

    assert.deepEqual(recorder.calls, [{ method: 'log', text: `[dsh] info ${alreadyRedacted}` }]);
  });

  it('web + flag off: no sink at all', () => {
    for (const value of [undefined, '', '0', 'true']) {
      setFlag(value);
      assert.deepEqual(debugLogSinksFromEnv({ platform: 'web', console: recordingConsole().target }), []);
    }
  });

  it('native: the flag never produces a console sink (the file sink stays the native path)', () => {
    setFlag('1');
    const recorder = recordingConsole();
    const sinks = debugLogSinksFromEnv({ platform: 'android', console: recorder.target });

    // `expo-file-system` is not loadable under the Node test hooks, so the file sink is `null` here
    // and the list is empty — the point is that nothing was routed to the console.
    for (const sink of sinks) sink(line('info', 'native'));
    assert.deepEqual(recorder.calls, []);
  });
});

describe('createDebugLogConsoleSink', () => {
  // The flag lives outside this block, so it is set here again (the hooks above are scoped to the
  // sibling suite). The console is still the recording stub: nothing reaches the real one.
  beforeEach(() => setFlag('1'));
  afterEach(() => setFlag(previousFlag));

  it('writes through DebugLog so the sink only ever sees the redacted line', () => {
    const recorder = recordingConsole();
    const sinks = debugLogSinksFromEnv({ platform: 'web', console: recorder.target });
    const log = new DebugLog({ sinks, now: () => 1_760_000_000_000 });

    log.info('paired', { token: 'super-secret-token' });

    assert.equal(recorder.calls.length, 1);
    const written = (recorder.calls[0] as Call).text;
    assert.match(written, /^\[dsh\] info /);
    assert.ok(!written.includes('super-secret-token'), `token leaked into the console line: ${written}`);
  });

  it('a throwing console does not escape to the caller', () => {
    const sink = createDebugLogConsoleSink({
      log: () => {
        throw new Error('console is gone');
      },
      warn: () => undefined,
      error: () => undefined,
    });
    assert.doesNotThrow(() => sink(line('debug', 'x')));
  });
});
