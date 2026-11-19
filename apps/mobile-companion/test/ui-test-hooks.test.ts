// Maestro hook guard — the app-side `testID`s the device flows (e2e/maestro) are meant to address.
//
// There is no component renderer in this repo (no react-test-renderer), so this is a **source**
// test: it reads the three screens and asserts the hooks the flow proposal in
// `e2e/README.md` §"Test hooks required before this is fully automated" asks for. It exists so a
// refactor cannot silently drop a hook (which would put the flows back on placeholder/hint taps)
// and so a hook cannot start embedding free text.
//
// What it enforces:
//   * the exact proposed hook set, per file, with the number of occurrences each is rendered at
//     (e.g. `approval-state-<id>` is rendered once per state branch);
//   * dynamic IDs are built only from stable identifiers — the tab value, the session id and the
//     approval id — never from the composer draft, the search query, a session title, the
//     approval preview/notice, or an error string. A `testID` ends up in the accessibility tree
//     and in flow logs, so a prompt or a pairing-code fragment must never reach it (FR-011);
//   * static IDs stay lowercase ASCII with no spaces, which both Maestro and the platform
//     accessibility bridges match literally; and
//   * the banner hooks keep a localized `accessibilityLabel` instead of a hard-coded copy.
//
// Dynamic IDs are host data (`sess-alpha`, `apv-hash` from the fixture). Maestro treats `id`
// selectors as regular expressions, so a flow must escape an opaque id before using it in
// `id: "approval-approve-<escaped>"`; the fixture ids are hyphen-only, which is regex-safe.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { planOtpAddress, planPairSubmit } from '../src/core/gateway-address';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'app');
// Spec 021: the pair screen body moved to `src/ui/pair-panel.tsx` so the web bootstrap of the root
// layout can render it before any route mounts (a browser whose passkey is not asserted yet has no
// navigator). `app/pair.tsx` is the thin route wrapper, so the hooks are guarded where they are
// rendered — same hooks, same counts, exactly like the list screen's move below.
const PAIR = path.join(path.resolve(APP_DIR, '..', 'src', 'ui'), 'pair-panel.tsx');
// Spec 011 P1-A: the session list moved from `app/index.tsx` to the Conversations tab
// (`app/(tabs)/conversations.tsx`) when the app gained the bottom tab bar. The guard set is
// unchanged — same hooks, same counts — only the file it reads moved with the screen.
const INDEX = path.join(APP_DIR, '(tabs)', 'index.tsx');
const SESSION = path.join(APP_DIR, 'session', '[id].tsx');

/** Every `testID="…"` / `testID={`…`}` literal in a source file, in source order. */
function hooks(source: string): string[] {
  const found: string[] = [];
  const pattern = /testID=(?:"([^"]+)"|\{`([^`]+)`\})/g;
  for (const match of source.matchAll(pattern)) found.push(match[1] ?? match[2] ?? '');
  return found;
}

function count(ids: string[], id: string): number {
  return ids.filter((entry) => entry === id).length;
}

/** The dynamic hooks the flows are allowed to depend on, and what the variable must be. */
const DYNAMIC_HOOKS = new Map<string, string>([
  // Parity redesign: the per-tab hook went away with the tab bar; these are the list screen's
  // dynamic hooks, each keyed by a stable id (never by free text).
  ['session-row-${item.session.id}', 'a host session id'],
  ['chip-${host.gatewayId}', 'a paired gateway id'],
  ['section-${key}', 'a workspace id (or the internal "other"/"all" bucket)'],
  ['workspace-option-${workspace.id}', 'a host workspace id'],
  ['menu-group-${mode}', 'a fixed group mode (workspace | none)'],
  ['approval-card-${card.approvalId}', 'a host approval id'],
  ['approval-state-${card.approvalId}', 'a host approval id'],
  ['approval-approve-${card.approvalId}', 'a host approval id'],
  ['approval-reject-${card.approvalId}', 'a host approval id'],
  // Spec 018 item 4: question cards keyed by the Host's rpcId, never by question text.
  ['question-card-${card.rpcId}', 'a host question rpcId'],
  ['question-option-${card.rpcId}-${optionIndex}', 'a host question rpcId and option index'],
  ['question-custom-${card.rpcId}', 'a host question rpcId'],
  ['question-notice-${card.rpcId}', 'a host question rpcId'],
  ['question-submit-${card.rpcId}', 'a host question rpcId'],
  ['question-skip-${card.rpcId}', 'a host question rpcId'],
  // Spec 018 item 3: one row per scheduled task, keyed by the task's own id (never a title).
  ['schedules-row-${row.id}', 'a host scheduled-task id'],
]);

describe('pair screen hooks', () => {
  const ids = hooks(readFileSync(PAIR, 'utf8'));

  it('exposes the paste field and the submit button the pair-paste subflow needs', () => {
    assert.equal(count(ids, 'pair-manual-input'), 1);
    assert.equal(count(ids, 'pair-submit'), 1);
    // Contract revision 5: the one-time-code flow adds a mode switch and its own two inputs. Every
    // hook is static (a pairing code never reaches a testID, FR-011), and each is rendered once.
    for (const id of ['pair-mode-code', 'pair-mode-otp', 'pair-otp-address', 'pair-otp-input', 'pair-otp-submit']) {
      assert.equal(count(ids, id), 1, `${id} is rendered exactly once`);
    }
    // Spec 031 §8: the PWA shows the page's own origin as read-only text (never an address field),
    // and an unsupported host gets its own guidance box instead of the code form.
    assert.equal(count(ids, 'pair-otp-origin'), 1);
    assert.equal(count(ids, 'pair-web-unsupported'), 1);
    // An 8-digit code pasted into "QR or code" lands on the code tab; this is the line that says so.
    assert.equal(count(ids, 'pair-otp-detected'), 1);
    // Spec 032 amendment: the DEMO-ONLY diagnosis line (`code · stage=…`). Static and rendered once;
    // the panel gates it on `controller.demoMode`, so a shipped screen renders no such element.
    assert.equal(count(ids, 'pair-failure-detail'), 1);
    assert.deepEqual(ids.toSorted(), [
      'pair-failure-detail',
      'pair-image-picker',
      'pair-manual-input',
      'pair-mode-code',
      'pair-mode-otp',
      'pair-otp-address',
      'pair-otp-detected',
      'pair-otp-input',
      'pair-otp-origin',
      'pair-otp-pin',
      'pair-otp-submit',
      // Spec 043: the bounded-window scan-failure hint and its retry action.
      'pair-scan-retry',
      'pair-scan-timeout',
      'pair-submit',
      'pair-web-unsupported',
    ]);
  });
});

describe('session list hooks', () => {
  const source = readFileSync(INDEX, 'utf8');
  const ids = hooks(source);

  it('exposes the header, source switcher, menu and composer hooks', () => {
    // Parity redesign: the per-tab hooks are gone with the tab bar. The composer's send button keeps
    // the LEGACY `new-session` hook (the lead's option (a)), so the authoring flows 15–18 did not have
    // to be rewritten; the rest are the new list-level controls.
    for (const id of ['list-source', 'list-menu', 'list-composer-input']) {
      assert.equal(count(ids, id), 1, `${id} is rendered exactly once`);
    }
    for (const id of ['workspace-home', 'new-session', 'new-session-reason', 'new-session-error']) {
      assert.equal(count(ids, id), 1, `${id} keeps the legacy authoring-flow contract`);
    }
  });

  it('exposes a hook per row keyed by the session id', () => {
    assert.equal(count(ids, 'session-row-${item.session.id}'), 1);
  });

  it('marks the banner and keeps its localized accessibility label', () => {
    assert.equal(count(ids, 'banner'), 1);
    assert.match(source, /testID="banner"\s+accessibilityLabel=\{banner\}/);
  });
});

describe('session screen hooks', () => {
  const source = readFileSync(SESSION, 'utf8');
  const ids = hooks(source);

  it('exposes the composer and send button', () => {
    assert.equal(count(ids, 'session-composer'), 1);
    assert.equal(count(ids, 'session-send'), 1);
  });

  it('exposes the three spec 041 controls (permission picker, context ring, attach)', () => {
    // Static hooks: the three owner-reported missing controls must stay addressable by Maestro.
    for (const id of ['session-permission-picker', 'session-context-ring', 'session-attach']) {
      assert.equal(count(ids, id), 1, `${id} is rendered exactly once`);
    }
    // The attach sheet's choices and cancel control stay static: no filename or Host receipt id
    // ever reaches a testID (FR-011). They are rendered once each in their own branches.
    for (const id of [
      'session-attach-sheet', 'session-attach-image', 'session-attach-file',
      'session-attach-cancel', 'session-attach-receipt',
    ]) {
      assert.equal(count(ids, id), 1, `${id} is rendered exactly once`);
    }
    assert.match(source, /testID="session-permission-picker"\s*$/m);
    assert.match(source, /testID="session-context-ring"\s*$/m);
    assert.match(source, /testID="session-attach"\s*$/m);
  });

  it('exposes per-card, per-decision and per-state hooks keyed by the approval id', () => {
    assert.equal(count(ids, 'approval-card-${card.approvalId}'), 1);
    assert.equal(count(ids, 'approval-approve-${card.approvalId}'), 1);
    assert.equal(count(ids, 'approval-reject-${card.approvalId}'), 1);
    // decide-on-computer | review-again | already-decided | resolved
    assert.equal(count(ids, 'approval-state-${card.approvalId}'), 4);
  });

  it('marks the banner and keeps its localized accessibility label', () => {
    assert.equal(count(ids, 'banner'), 1);
    assert.match(source, /testID="banner"\s+accessibilityLabel=\{banner\}/);
  });
});

describe('pair screen: the one-time-code form on a phone', () => {
  const source = readFileSync(PAIR, 'utf8');

  it('refuses the 8-digit code on native BEFORE any connection is attempted', () => {
    // A code carries no certificate, and the native transport refuses an unpinned socket outright,
    // so the attempt would burn one of the Host's three proofs before failing. The guard must
    // therefore sit before this form's own `controller.pair(...)` call, not after it.
    //
    // Spec 031 §8: the guard is the seam (`planPairSubmit`), which answers `native`/`otpNative` for
    // a phone's code. Both handlers call it; the CODE handler is the second call, and its refusal
    // must return before any controller call — the QR flow's `pair()` earlier in the file must not
    // stand in for it.
    const seamCalls = [...source.matchAll(/\bplanPairSubmit\(/g)].map((match) => match.index ?? -1);
    assert.equal(seamCalls.length, 2, 'each submit handler consults the seam');
    const codeHandlerStart = seamCalls[1] ?? -1;
    assert.ok(codeHandlerStart > 0, 'the code handler calls the seam');
    const guard = source.indexOf("if (decision.kind === 'blocked')", codeHandlerStart);
    assert.ok(guard > codeHandlerStart, 'the code handler checks its own decision');
    // The OTP form's connect: the FIRST `controller.pair(` after the guard.
    const connect = source.indexOf('controller.pair(', guard);
    assert.ok(connect > 0, 'the OTP form does connect on the web');
    assert.ok(guard < connect, 'the guard runs before the connection is opened');
    // It refuses through the copy the screen renders, and returns before touching any controller.
    const guarded = source.slice(guard, connect);
    assert.match(guarded, /setFailure\(refusalKey[\s\S]*?return;/, 'the failure is rendered and the handler returns');
    assert.equal(guarded.includes('controller.'), false, 'nothing reaches the controller');
    assert.equal(source.includes('otpGatewayUrl(otpAddress'), false, 'the code never dials a typed address');
  });

  it('keeps a supported web page on the one-time-code flow', () => {
    // Spec 020/031: a browser cannot pin by construction, so the code flow is its honest first-use
    // path — through the page's OWN origin (`planOtpAddress`), never a typed address.
    //
    // The guard is the seam, not a short-circuit: a supported page reaches the decision as `otp`,
    // and only `blocked` refuses. The guard up front is the render (no code form on a foreign page).
    assert.match(source, /const otpBlocked = web\.kind === 'unsupported'/);
    const codeHandlerStart = ([...source.matchAll(/\bplanPairSubmit\(/g)].map((match) => match.index ?? -1))[1] ?? -1;
    assert.ok(codeHandlerStart > 0, 'the code handler calls the seam');
    assert.match(
      source.slice(codeHandlerStart),
      RegExp("if \\(decision\\.kind !== 'otp'\\) \\{[\\s\\S]*?return;[\\s\\S]*?\\n" + '    }'.replace('}', '\\}')),
    );
    assert.ok(source.slice(codeHandlerStart).includes('url = decision.url'), 'the web code handler dials the seam URL');
    assert.ok(source.slice(codeHandlerStart).includes('planNativeOtpSubmit(otpAddress, otpPin)'), 'the native handler validates address+pin');
    // The connect uses the seam's own `url`/`origin` — never `otpGatewayUrl(otpAddress)` — and it
    // comes after the `blocked` guard above, so a refused code never opens a socket.
    // The connect hands the controller the seam's own `url` (labelled with its `origin` as the name
    // shown while connecting) — never `otpGatewayUrl(otpAddress)`, the typed native field.
    assert.ok(source.slice(codeHandlerStart).includes("controller.pair('', { otp: {"));
    assert.ok(source.slice(codeHandlerStart).includes('certSha256: pin'));
    // And the seam itself: a supported page gets the code flow, a phone does not.
    assert.equal(planPairSubmit(planOtpAddress({ protocol: 'https:', host: 'host.example.ts.net:8443' }), true, false).kind, 'otp');
    assert.deepEqual(planPairSubmit(planOtpAddress(null), true, false), { kind: 'blocked', reason: 'otpNative' });
  });
});

describe('hook shape', () => {
  const sources = [PAIR, INDEX, SESSION].map((file) => ({ file, ids: hooks(readFileSync(file, 'utf8')) }));

  it('never derives a hook from free text (prompt, draft, search query, title, preview, notice)', () => {
    const forbidden = /(manual|text|query|title|preview|notice|lastError|toolName|banner\b)/;
    for (const { file, ids } of sources) {
      for (const id of ids) {
        if (!id.includes('${')) continue;
        assert.ok(DYNAMIC_HOOKS.has(id), `${path.relative(APP_DIR, file)}: unexpected dynamic hook ${id}`);
        const expression = id.slice(id.indexOf('${') + 2, -1);
        assert.ok(!forbidden.test(expression), `${path.relative(APP_DIR, file)}: hook ${id} embeds free text`);
      }
    }
  });

  it('keeps static hooks lowercase ASCII without whitespace (Maestro/accessibility safe)', () => {
    for (const { file, ids } of sources) {
      for (const id of ids) {
        if (id.includes('${')) continue;
        assert.match(id, /^[a-z][a-z0-9-]*$/, `${path.relative(APP_DIR, file)}: hook ${id} is not a safe literal`);
      }
    }
  });

  it('keeps the pair screen free of dynamic hooks (the code itself is never an id)', () => {
    assert.deepEqual(hooks(readFileSync(PAIR, 'utf8')).filter((id) => id.includes('${')), []);
  });
});
