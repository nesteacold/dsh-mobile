// The gate's escape hatch must be UNCONDITIONAL, and it must actually ask and act.
//
// Lead decision 2026-11-16: web cannot read the status of a refused upgrade
// (`src/platform/pinned-transport.web.ts` reports 401, 403 and a network failure alike as
// `connect-failed` + close 1006), so `credentialRejected` can never fire on a PWA. If the
// "forget and pair again" button only appeared on that branch, a revoked device would stay stuck
// behind a gate whose only action cannot work — and Settings is behind the same gate.
//
// Review M1: `react-native-web`'s `Alert.alert` is a no-op, so the confirm step was inert on the PWA.
// The ask-then-forget decision therefore lives in `src/ui/confirm-forget.ts` and is EXECUTED here
// (web confirm true/false, native Alert with a destructive button). `app/_layout.tsx` has no render
// harness in this Node suite (the gate is inside the router), so the rest pins STRUCTURE: the button
// sits in the ordinary (credentialRejected: false) return, and both call sites pass the handler.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { browserConfirm, confirmAndForget, type ForgetAlertButton } from '../src/ui/confirm-forget';

const ROOT = path.resolve(__dirname, '..');
const LAYOUT = readFileSync(path.join(ROOT, 'app', '_layout.tsx'), 'utf8');
const ROOT_LAYOUT = LAYOUT.slice(
  LAYOUT.indexOf('export default function RootLayout()'),
  LAYOUT.indexOf('Spec 021 — the web bootstrap'),
);

/** The `WebLockGate` function body, from its declaration to the next top-level function. */
function gateBody(): string {
  const start = LAYOUT.indexOf('function WebLockGate(');
  assert.notEqual(start, -1, 'WebLockGate exists in app/_layout.tsx');
  const end = LAYOUT.indexOf('\nfunction ', start + 1);
  return LAYOUT.slice(start, end === -1 ? LAYOUT.length : end);
}

/** The ORDINARY return: everything after the closing brace of the `if (credentialRejected) {…}` block. */
function ordinaryReturn(): string {
  const body = gateBody();
  const ifStart = body.indexOf('if (credentialRejected) {');
  assert.notEqual(ifStart, -1, 'the credentialRejected early return exists');
  // The early block ends at the first line that is exactly `  }` after it (2-space indented close).
  const close = body.indexOf('\n  }\n', ifStart);
  assert.notEqual(close, -1, 'the early block is closed');
  const rest = body.slice(close + '\n  }\n'.length);
  assert.match(rest, /^\s*return \(/, 'what follows the early block is the ordinary return');
  return rest;
}

const COPY = { title: 'Forget & pair again', message: 'This removes pairing info.', cancel: 'Cancel' };

function harness(platform: string, confirmAnswer: boolean) {
  const calls = {
    confirm: [] as string[],
    alert: [] as Array<{ title: string; message: string; buttons: ForgetAlertButton[] }>,
    forget: 0,
  };
  const deps = {
    platform,
    confirm: (message: string) => {
      calls.confirm.push(message);
      return confirmAnswer;
    },
    alert: (title: string, message: string, buttons: ForgetAlertButton[]) => {
      calls.alert.push({ title, message, buttons });
    },
    forget: () => {
      calls.forget += 1;
    },
    copy: COPY,
  };
  return { calls, deps };
}

describe('confirmAndForget (the gate\'s confirm step, executed)', () => {
  it('web: a confirmed dialog calls forget exactly once, and never touches Alert', () => {
    const { calls, deps } = harness('web', true);
    confirmAndForget(deps);
    assert.equal(calls.forget, 1);
    assert.equal(calls.confirm.length, 1, 'the browser dialog was shown once');
    assert.ok(calls.confirm[0]?.includes(COPY.message), 'the dialog carries the explanation');
    assert.deepEqual(calls.alert, [], 'Alert.alert is a no-op on react-native-web and is not used there');
  });

  it('web: a dismissed dialog does not forget', () => {
    const { calls, deps } = harness('web', false);
    confirmAndForget(deps);
    assert.equal(calls.forget, 0);
    assert.equal(calls.confirm.length, 1);
    assert.deepEqual(calls.alert, []);
  });

  it('native: asks through Alert with a cancel and a destructive button; only the destructive one forgets', () => {
    for (const platform of ['ios', 'android']) {
      const { calls, deps } = harness(platform, true);
      confirmAndForget(deps);
      assert.equal(calls.forget, 0, `${platform}: nothing is forgotten before a button is pressed`);
      assert.deepEqual(calls.confirm, [], `${platform}: no browser dialog on native`);
      assert.equal(calls.alert.length, 1);
      const [alert] = calls.alert;
      assert.equal(alert?.title, COPY.title);
      assert.equal(alert?.message, COPY.message);
      const cancel = alert?.buttons.find((b) => b.style === 'cancel');
      const destructive = alert?.buttons.find((b) => b.style === 'destructive');
      assert.ok(cancel !== undefined && destructive !== undefined, `${platform}: cancel + destructive buttons`);
      (cancel as ForgetAlertButton).onPress?.(); // cancel: no handler, or one that does nothing
      assert.equal(calls.forget, 0, 'cancel does not forget');
      destructive.onPress?.();
      assert.equal(calls.forget, 1, `${platform}: the destructive button forgets exactly once`);
    }
  });

  it('browserConfirm refuses (does not confirm) when the environment has no confirm()', () => {
    const g = globalThis as { confirm?: unknown };
    const saved = g.confirm;
    try {
      delete g.confirm;
      assert.equal(browserConfirm()('x'), false, 'no dialog available must read as "not confirmed"');
      g.confirm = (message: string) => message === 'yes';
      assert.equal(browserConfirm()('yes'), true);
      assert.equal(browserConfirm()('no'), false);
    } finally {
      if (saved === undefined) delete g.confirm;
      else g.confirm = saved;
    }
  });
});

describe('the web lock gate always offers "forget and pair again"', () => {
  it('renders the forget button in the ORDINARY return (credentialRejected: false), via the confirming handler', () => {
    const main = ordinaryReturn();
    // Hooks now come from the single style factory the JSX consumes (see theme-color-scheme.test.ts,
    // which asserts the factory's VALUES behaviourally). Here we only pin the wiring order.
    assert.match(main, /testID=\{gate\.hooks\.gate\}/);
    assert.match(main, /testID=\{gate\.hooks\.forget\}/, 'the ordinary return renders a forget button');
    // It also renders the passkey action, so the forget button is a SECOND action next to it.
    assert.match(main, /testID=\{gate\.hooks\.action\}/);
    assert.ok(main.indexOf('testID={gate.hooks.forget}') > main.indexOf('testID={gate.hooks.action}'));
    // It calls the handler it was given (which asks first), never `forget()` on its own.
    assert.match(main, /onPress=\{onForget\}/, 'the button goes through the confirming handler');
    assert.doesNotMatch(main, /\.forget\(\)/);
  });

  it('renders every gate node from ONE style factory — no parallel style copy can drift', () => {
    const main = ordinaryReturn();
    // `ordinaryReturn()` reaches the exported factory at the end of the component's slice; the JSX
    // itself is everything before it. The factory's VALUES are asserted behaviourally elsewhere.
    const factoryAt = main.indexOf('export function webLockGateStyles');
    assert.ok(factoryAt > 0, 'the single style factory is exported from the layout');
    const jsx = main.slice(0, factoryAt);
    // WebLockGate resolves the palette once and renders from that object, not from a second copy.
    assert.match(gateBody(), /const gate = webLockGateStyles\(palette\);/);
    assert.match(jsx, /style=\{gate\.title\} testID=\{gate\.hooks\.title\}/);
    assert.match(jsx, /style=\{gate\.subtitle\}\s+testID=\{gate\.hooks\.subtitle\}/);
    assert.match(jsx, /style=\{gate\.action\}/);
    assert.match(jsx, /style=\{gate\.actionText\}/);
    assert.match(jsx, /style=\{gate\.forget\}/);
    assert.match(jsx, /style=\{gate\.forgetText\}/);
    assert.match(jsx, /accessibilityRole="button"/);
    // No leftover parallel style definitions for the gate in the rendered JSX.
    assert.doesNotMatch(jsx, /styles\.(tertiary|buttonText)/);
    assert.doesNotMatch(jsx, /backgroundColor: palette\.(surface|accent)/);
  });

  it('spec 045: neither gate is mounted on web — the legacy gate component is dead code', () => {
    assert.doesNotMatch(ROOT_LAYOUT, /<WebBootstrap\b/, 'WebBootstrap is never rendered');
    assert.doesNotMatch(ROOT_LAYOUT, /<WebLockGate\b/, 'WebLockGate is never rendered');
    assert.match(LAYOUT, /testID="legacy-web-lock-notice"/, 'an update notice replaces both');
    // The confirming handler is still available for the notice's forget-and-pair action.
    assert.match(LAYOUT, /onPairAnother=\{confirmForget\}/);
  });

  it('the layout handler delegates to confirmAndForget with the platform, the browser confirm and Alert (never a bare Alert.alert)', () => {
    const start = LAYOUT.indexOf('const confirmForget = useCallback(');
    assert.notEqual(start, -1, 'a confirming handler exists');
    const handler = LAYOUT.slice(start, LAYOUT.indexOf('}, [controller, tr]);', start));
    assert.match(handler, /confirmAndForget\(/);
    assert.match(handler, /platform: Platform\.OS/);
    assert.match(handler, /confirm: browserConfirm\(\)/);
    assert.match(handler, /Alert\.alert\(/, 'native still gets the Alert');
    assert.match(handler, /forget: \(\) => controller\.forget\(\)/);
    // The handler itself never forgets directly: only the executed `confirmAndForget` does, after a yes.
    assert.doesNotMatch(handler.replace(/forget: \(\) => controller\.forget\(\)/, ''), /\.forget\(\)/);
  });

  it('explains an unreachable computer after a `locked` passkey refusal, instead of staying silent', () => {
    const body = gateBody();
    // `passkey.web.ts` answers `locked` when no ready socket exists; that is `webLock.error`.
    assert.match(body, /lock\.error === 'locked'/, 'the explanation is driven by the real refusal reason');
    assert.match(body, /testID="web-lock-unreachable"/);
    assert.match(body, /tr\('unlock\.unreachable'\)/);
  });
});
