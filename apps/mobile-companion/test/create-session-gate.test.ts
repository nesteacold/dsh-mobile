// `createSession` must only report success when the HOST gave it a session id.
//
// Why: the gateway answers refusals with a typed frame — `{kind:'error', code, message}` — instead of
// throwing (`plugins/mobile-gateway/lib/index.mjs:1646-1666`). An id-less frame leaves the app with
// nothing to navigate to; treated as success it produces a phantom session: the UI clears the composer
// and draws the prompt, while the Host has no session and no turn can ever start.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_STATE = readFileSync(path.join(ROOT, 'src', 'app-state.ts'), 'utf8');

/** The body of `createSession`, from its signature to the end of the method. */
function createSessionBody(): string {
  const start = APP_STATE.indexOf('async createSession(input: { workspaceId: string })');
  assert.notEqual(start, -1, 'createSession is found');
  const end = APP_STATE.indexOf('/** Fetch the model catalog', start);
  return APP_STATE.slice(start, end === -1 ? APP_STATE.length : end);
}

describe('createSession — success requires an id from the Host', () => {
  const body = createSessionBody();

  it('rejects a typed error frame instead of treating it as created', () => {
    assert.match(body, /if \(answer\.kind === 'error'\)/, 'the gateway error frame is checked');
    // The check must come BEFORE the id is read, otherwise an error frame is also an "empty id" and
    // the real refusal code would be replaced by a generic message.
    const errorCheck = body.indexOf("answer.kind === 'error'");
    const idRead = body.indexOf('answer.sessionId');
    assert.ok(errorCheck !== -1 && idRead !== -1, 'both branches exist');
    assert.ok(errorCheck < idRead, 'the refusal is classified before the id is inspected');
  });

  it('surfaces the refusal code rather than a generic failure', () => {
    assert.match(body, /const code = typeof answer\.code === 'string' && answer\.code !== '' \? answer\.code : 'client\/bad-message'/,
      'the host code is passed through, with a safe fallback');
    assert.match(body, /return \{ ok: false, code, /, 'the classified code is what the caller receives');
  });

  it('still requires a non-empty session id before reporting success', () => {
    assert.match(body, /if \(sessionId === ''\) return \{ ok: false, code: 'client\/bad-message' \}/);
    assert.match(body, /return \{ ok: true, value: sessionId \}/, 'the id comes from the reply');
    // Nothing local may be invented as the id.
    assert.equal(/ok: true, value: (?!sessionId)/.test(body), false, 'no optimistic/local id');
  });

  it('requires the socket to be ready before asking the Host', () => {
    const ready = body.indexOf("this.client?.state !== 'ready'");
    const request = body.indexOf('session-create');
    assert.ok(ready !== -1 && request !== -1 && ready < request, 'state is checked before the request');
  });
});

// Measured by `packaging` on the gateway (2026-11-11): sending a workspace NAME, an old id, an empty
// string or no field at all all produce `remote/argument-denied` and ZERO Host calls — no session is
// created, which is exactly the "created but nothing on the Host" report. Only an id taken from the
// CURRENT `workspaces` reply works (31 ms, `session-created`).
describe('createSession — the workspace id is validated against the latest list', () => {
  const body = createSessionBody();

  it('checks the id against the newest workspaces reply and refreshes once before giving up', () => {
    assert.match(body, /this\.authoring\.workspaces\.some\(\(workspace\) => workspace\.id === id\)/,
      'the id is compared with the loaded workspaces');
    const refresh = body.indexOf('await this.listWorkspaces()');
    const deny = body.indexOf('return { ok: false, code: WORKSPACE_DENIED_CODE }');
    assert.notEqual(refresh, -1, 'the list is refreshed when the id is unknown');
    assert.ok(refresh < deny, 'refreshing happens BEFORE refusing');
    assert.match(body, /id !== '' &&/, 'an empty id is never considered valid');
  });

  it('refuses a dead workspace without ever issuing the create request', () => {
    const deny = body.indexOf('return { ok: false, code: WORKSPACE_DENIED_CODE }');
    const request = body.indexOf("request('session-create'");
    assert.notEqual(deny, -1, 'a stale id is refused');
    assert.ok(deny < request, 'the refusal happens before session-create is sent');
  });

  it('never sends a name: the payload uses the validated id only', () => {
    assert.match(body, /request\('session-create', \{ workspaceId: input\.workspaceId \}\)/);
    assert.equal(/workspaceName|workspaceLabel|name:/.test(body), false, 'no label/name is ever sent');
  });

  it('carries the Host code AND message through on a refusal, and refreshes on a denial', () => {
    assert.match(body, /const message = typeof answer\.message === 'string' \? answer\.message : ''/);
    assert.match(body, /return \{ ok: false, code, \.\.\.\(message === '' \? \{\} : \{ message \}\) \}/);
    assert.match(body, /if \(code === WORKSPACE_DENIED_CODE\) await this\.listWorkspaces\(\)/,
      'a denied workspace refreshes the list so the picker stops offering a dead id');
  });

  it('the composer shows a specific instruction for a dead workspace, and the code for anything else', () => {
    const listScreen = readFileSync(path.join(ROOT, 'app', '(tabs)', 'index.tsx'), 'utf8');
    assert.match(listScreen, /createError\.code === 'remote\/argument-denied'/, 'the denial is special-cased');
    assert.match(listScreen, /tr\('authoring\.workspaceGone'\)/, 'with actionable copy');
    assert.match(listScreen, /\$\{tr\('authoring\.createFailed'\)\} \(\$\{createError\.code\}\)/, 'other codes are shown verbatim');
    assert.match(listScreen, /createError\.message === undefined \? '' : ` — \$\{createError\.message\}`/,
      'the Host wording is surfaced too');
  });
});
