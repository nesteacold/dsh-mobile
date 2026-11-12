// Spec 011 P2 item 4 — the controller accessor behind the row long-press (rename / archive), plus the
// capability list the list screen reads to decide whether those controls exist at all.
//
// The rules pinned here are the ones this session has already been burned by:
//   * no live socket is NOT a protocol error (it answers `{ ok: false, code }` like `readTeam` answers
//     `unavailable`) — but a REFUSAL by the Host is, and it must reject with `CoreError` carrying the
//     Host's code rather than quietly reporting success;
//   * the Host's raw `message` is never what a screen shows, so only the code is asserted here;
//   * success is ONLY the one receipt kind for THIS session — any other kind, or a receipt naming
//     another session, is a malformed reply that rejects `client/bad-message` instead of being
//     reported as a quiet success;
//   * `capabilities` on the snapshot comes from the Host's `hello` and nothing else.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AppController } from '../src/app-state';
import type { CompanionClient } from '../src/core/client';
import { CoreError } from '../src/core/errors';
import { resetAppState } from './support/stubs/react-native.stub';

const SESSION = 'sess-actions';

function controllerWith(client: unknown): AppController {
  resetAppState('active');
  const controller = new AppController({ locale: () => 'en' });
  // Private on purpose: the TEST may reach in, the UI may not.
  (controller as unknown as { client: unknown }).client = client;
  return controller;
}

/** Records what the accessor actually sent, so the frame is asserted, not assumed. */
function fakeClient(state: string, reply: unknown, hello?: { capabilities?: string[] }): CompanionClient {
  const sent: { type: string; payload: unknown }[] = [];
  const client = {
    state,
    hello: hello === undefined ? null : { capabilities: hello.capabilities ?? [] },
    close: () => {},
    stop: () => {},
    on: () => {},
    off: () => {},
    request: async (type: string, payload: unknown) => {
      sent.push({ type, payload });
      if (reply instanceof Error) throw reply;
      return reply as Record<string, unknown>;
    },
    /** Test-only window onto the recorded frames. */
    __sent: sent,
  };
  return client as unknown as CompanionClient;
}

const sentOf = (client: CompanionClient): { type: string; payload: unknown }[] =>
  (client as unknown as { __sent: { type: string; payload: unknown }[] }).__sent;

describe('renameSession', () => {
  it('with no client it answers a code instead of throwing', async () => {
    resetAppState('active');
    const controller = new AppController({ locale: () => 'en' });
    try {
      assert.deepEqual(await controller.renameSession(SESSION, 'New name'), { ok: false, code: 'client/bad-state' });
    } finally {
      controller.stop();
    }
  });

  it('with a client that is not ready it also answers a code (no throw, nothing sent)', async () => {
    const client = fakeClient('closed', { kind: 'session-renamed' });
    const controller = controllerWith(client);
    try {
      assert.deepEqual(await controller.renameSession(SESSION, 'New name'), { ok: false, code: 'client/bad-state' });
      assert.equal(sentOf(client).length, 0, 'a closed socket sends nothing');
    } finally {
      controller.stop();
    }
  });

  it('sends session-rename with the trimmed title and reports the GATEWAY title, not the draft', async () => {
    // The gateway normalises what it stores and echoes that value (lib/index.mjs:1962-1964); a
    // different value in the receipt is what the row must show, never the local draft.
    const client = fakeClient('ready', { kind: 'session-renamed', sessionId: SESSION, title: 'Host normalised' });
    const controller = controllerWith(client);
    try {
      const outcome = await controller.renameSession(SESSION, '  Sprint 3  ');
      assert.deepEqual(outcome, { ok: true, sessionId: SESSION, title: 'Host normalised' });
      assert.equal(sentOf(client).length, 1);
      assert.equal(sentOf(client)[0]?.type, 'session-rename');
      assert.deepEqual(sentOf(client)[0]?.payload, { sessionId: SESSION, title: 'Sprint 3' });
    } finally {
      controller.stop();
    }
  });

  it('a reply of another KIND rejects client/bad-message (never reported as a rename)', async () => {
    // Negative control for the kind check: `session-archived` is a real receipt of another op.
    for (const reply of [
      { kind: 'session-archived', sessionId: SESSION },
      { kind: 'ping' },
      { kind: 'session-title-changed', sessionId: SESSION },
    ]) {
      const client = fakeClient('ready', reply);
      const controller = controllerWith(client);
      try {
        await assert.rejects(
          () => controller.renameSession(SESSION, 'New name'),
          (error: unknown) => error instanceof CoreError && error.code === 'client/bad-message',
          `${JSON.stringify(reply)} must not read as a rename`,
        );
      } finally {
        controller.stop();
      }
    }
  });

  it('a receipt for ANOTHER session rejects client/bad-message', async () => {
    const client = fakeClient('ready', { kind: 'session-renamed', sessionId: 'sess-other', title: 'New name' });
    const controller = controllerWith(client);
    try {
      await assert.rejects(
        () => controller.renameSession(SESSION, 'New name'),
        (error: unknown) => error instanceof CoreError && error.code === 'client/bad-message',
      );
    } finally {
      controller.stop();
    }
  });

  it('refuses a blank or over-long title before it reaches the wire', async () => {
    const client = fakeClient('ready', { kind: 'session-renamed' });
    const controller = controllerWith(client);
    try {
      await assert.rejects(() => controller.renameSession(SESSION, '   '), /title is empty/);
      await assert.rejects(() => controller.renameSession(SESSION, 'a'.repeat(201)), /title is too-long/);
      assert.equal(sentOf(client).length, 0, 'an unusable title is never sent');
    } finally {
      controller.stop();
    }
  });

  it('a Host refusal REJECTS with the Host code (never reported as success)', async () => {
    const client = fakeClient('ready', { kind: 'error', code: 'session/not-found', message: 'session not found' });
    const controller = controllerWith(client);
    try {
      await assert.rejects(
        () => controller.renameSession(SESSION, 'New name'),
        (error: unknown) => error instanceof CoreError && error.code === 'session/not-found',
      );
    } finally {
      controller.stop();
    }
  });

  it('an error frame without a code still rejects (it does not fall through to ok)', async () => {
    const client = fakeClient('ready', { kind: 'error' });
    const controller = controllerWith(client);
    try {
      await assert.rejects(() => controller.renameSession(SESSION, 'New name'), (error: unknown) => error instanceof CoreError);
    } finally {
      controller.stop();
    }
  });
});

describe('archiveSession', () => {
  it('with no client it answers a code instead of throwing', async () => {
    resetAppState('active');
    const controller = new AppController({ locale: () => 'en' });
    try {
      assert.deepEqual(await controller.archiveSession(SESSION), { ok: false, code: 'client/bad-state' });
    } finally {
      controller.stop();
    }
  });

  it('sends session-archive with only the session id', async () => {
    const client = fakeClient('ready', { kind: 'session-archived', sessionId: SESSION });
    const controller = controllerWith(client);
    try {
      assert.deepEqual(await controller.archiveSession(` ${SESSION} `), { ok: true, sessionId: SESSION });
      assert.equal(sentOf(client)[0]?.type, 'session-archive');
      assert.deepEqual(sentOf(client)[0]?.payload, { sessionId: SESSION });
    } finally {
      controller.stop();
    }
  });

  it('a Host refusal REJECTS with the Host code', async () => {
    const client = fakeClient('ready', { kind: 'error', code: 'auth/revoked', message: 'device revoked' });
    const controller = controllerWith(client);
    try {
      await assert.rejects(
        () => controller.archiveSession(SESSION),
        (error: unknown) => error instanceof CoreError && error.code === 'auth/revoked',
      );
    } finally {
      controller.stop();
    }
  });

  it('a reply of another KIND rejects client/bad-message (never reported as an archive)', async () => {
    // Negative control for the kind check: `session-renamed` is a real receipt of another op.
    for (const reply of [
      { kind: 'session-renamed', sessionId: SESSION, title: 'x' },
      { kind: 'ping' },
      { kind: 'session-archives', archivedSessionIds: [SESSION] },
    ]) {
      const client = fakeClient('ready', reply);
      const controller = controllerWith(client);
      try {
        await assert.rejects(
          () => controller.archiveSession(SESSION),
          (error: unknown) => error instanceof CoreError && error.code === 'client/bad-message',
          `${JSON.stringify(reply)} must not read as an archive`,
        );
      } finally {
        controller.stop();
      }
    }
  });

  it('a receipt for ANOTHER session rejects client/bad-message', async () => {
    const client = fakeClient('ready', { kind: 'session-archived', sessionId: 'sess-other' });
    const controller = controllerWith(client);
    try {
      await assert.rejects(
        () => controller.archiveSession(SESSION),
        (error: unknown) => error instanceof CoreError && error.code === 'client/bad-message',
      );
    } finally {
      controller.stop();
    }
  });

  it('throws a CoreError for a blank id', async () => {
    const client = fakeClient('ready', { kind: 'session-archived' });
    const controller = controllerWith(client);
    try {
      await assert.rejects(() => controller.archiveSession('  '), /needs a session id/);
    } finally {
      controller.stop();
    }
  });
});

describe('snapshot.capabilities', () => {
  it('is the Host hello statement, and `[]` before any handshake', async () => {
    resetAppState('active');
    const controller = new AppController({ locale: () => 'en' });
    try {
      assert.deepEqual(controller.snapshot().capabilities, [], 'no client ⇒ no advertised capability');
    } finally {
      controller.stop();
    }
  });

  it('carries exactly what the Host advertised (no client-side merging)', async () => {
    const client = fakeClient('ready', { kind: 'ping' }, { capabilities: ['sessions-read', 'prompt', 'cancel', 'approval-v1'] });
    const controller = controllerWith(client);
    try {
      assert.deepEqual(controller.snapshot().capabilities, ['sessions-read', 'prompt', 'cancel', 'approval-v1']);
    } finally {
      controller.stop();
    }
  });

  it('a hello without capabilities reads as empty, not as undefined', async () => {
    const client = fakeClient('ready', { kind: 'ping' }, {});
    const controller = controllerWith(client);
    try {
      assert.deepEqual(controller.snapshot().capabilities, []);
    } finally {
      controller.stop();
    }
  });
});
