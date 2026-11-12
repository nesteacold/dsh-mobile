// Workspace grouping for the list screen — the three name-resolution paths, and the live merge.
//
// Priority (lead's requirement): `workspaceLabel` on the session → the paired `workspaces` entry's
// name → "Other". A raw workspace id must never become a section header, and the "Other" bucket is
// always last and always single.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { applyWorkspaceBinding, SessionsStore, type SessionSummary } from '../src/core/sessions';
import {
  OTHER_WORKSPACE_KEY,
  groupSessionsByWorkspace,
  resolveWorkspaceLabel,
} from '../src/ui/workspace-groups';

const NOW = Date.parse('2026-11-11T09:00:00Z');

function session(over: Partial<SessionSummary> & { id: string }): SessionSummary {
  return { title: 'Session', state: 'idle', updatedAt: NOW, needsDecision: false, ...over };
}

describe('group label priority', () => {
  it('1. prefers the label the Host sends on the session', () => {
    const rows = [
      session({ id: 's1', workspaceId: 'ws-1', workspaceLabel: 'DiskTree' }),
      session({ id: 's2', workspaceId: 'ws-1' }),
    ];
    const groups = groupSessionsByWorkspace(rows, [{ id: 'ws-1', name: 'A DIFFERENT NAME' }]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0]?.label, 'DiskTree', 'the session label wins over the workspaces name');
    assert.equal(groups[0]?.isOther, false);
  });

  it('2. falls back to the paired workspaces entry (name, then the path basename)', () => {
    assert.equal(
      resolveWorkspaceLabel('ws-2', [session({ id: 's3', workspaceId: 'ws-2' })], [{ id: 'ws-2', name: 'DXVK_Project' }]),
      'DXVK_Project',
    );
    assert.equal(
      resolveWorkspaceLabel('ws-3', [session({ id: 's4', workspaceId: 'ws-3' })], [{ id: 'ws-3', path: '/home/me/REA_Project' }]),
      'REA_Project',
      'a path is reduced to its last segment, never shown whole',
    );
    assert.equal(
      resolveWorkspaceLabel('ws-3', [session({ id: 's4', workspaceId: 'ws-3' })], [{ id: 'ws-3', path: 'C:\\work\\DXVK\\' }]),
      'DXVK',
    );
  });

  it('3. falls back to ONE trailing "Other" group when nothing names the workspace', () => {
    const rows = [
      session({ id: 's1', workspaceId: 'ws-nameless' }),
      session({ id: 's2', workspaceId: 'ws-also-nameless' }),
      session({ id: 's3' }), // no workspaceId at all
    ];
    const groups = groupSessionsByWorkspace(rows, []);
    assert.equal(groups.length, 1, 'unresolvable workspaces merge instead of repeating "Other"');
    assert.equal(groups[0]?.isOther, true);
    assert.equal(groups[0]?.label, null, 'the caller supplies the localized "Other" copy');
    assert.equal(groups[0]?.key, OTHER_WORKSPACE_KEY);
    assert.equal(groups[0]?.sessions.length, 3);
  });

  it('never uses a raw workspace id as a group name', () => {
    const groups = groupSessionsByWorkspace([session({ id: 's1', workspaceId: 'ws-secret-id' })], []);
    for (const group of groups) {
      assert.notEqual(group.label, 'ws-secret-id');
    }
  });
});

describe('group ordering', () => {
  it('sorts named groups by label and keeps "Other" last, newest first inside a group', () => {
    const rows = [
      session({ id: 'a1', workspaceId: 'ws-b', workspaceLabel: 'Beta', updatedAt: NOW - 1_000 }),
      session({ id: 'a2', workspaceId: 'ws-a', workspaceLabel: 'Alpha', updatedAt: NOW - 2_000 }),
      session({ id: 'a3', workspaceId: 'ws-b', workspaceLabel: 'Beta', updatedAt: NOW }),
      session({ id: 'a4', workspaceId: 'ws-unknown' }),
    ];
    const groups = groupSessionsByWorkspace(rows, []);
    assert.deepEqual(groups.map((group) => group.label ?? '(other)'), ['Alpha', 'Beta', '(other)']);
    const beta = groups[1];
    assert.deepEqual(beta?.sessions.map((row) => row.id), ['a3', 'a1'], 'newest first inside the group');
  });

  it('returns no groups for no sessions', () => {
    assert.deepEqual(groupSessionsByWorkspace([], []), []);
  });
});

describe('live workspace binding from session events', () => {
  it('merges a binding onto an existing row WITHOUT touching its title', () => {
    const store = new SessionsStore({ now: () => NOW });
    store.setAll([{ sessionId: 's-live', running: true, updatedAt: NOW, projections: { values: { title: 'Real title' } } }]);
    assert.equal(store.get('s-live')?.workspaceId, undefined);

    store.applyWorkspace('s-live', { workspaceId: 'ws-9', workspaceLabel: 'REA_Project' });
    const row = store.get('s-live');
    assert.equal(row?.workspaceId, 'ws-9');
    assert.equal(row?.workspaceLabel, 'REA_Project');
    assert.equal(row?.title, 'Real title', 'a workspace event must never blank the title');
    assert.equal(row?.state, 'running', 'other fields survive');
  });

  it('ignores a binding for an unknown session (the next list carries the full row)', () => {
    const store = new SessionsStore({ now: () => NOW });
    store.setAll([]);
    store.applyWorkspace('s-missing', { workspaceId: 'ws-9' });
    assert.equal(store.get('s-missing'), undefined);
  });

  it('the pure merge leaves absent fields absent and never invents a workspace', () => {
    const base = session({ id: 's1' });
    assert.deepEqual(applyWorkspaceBinding(base, {}), base);
    assert.equal(applyWorkspaceBinding(undefined, { workspaceId: 'ws-1' }), undefined);
    const merged = applyWorkspaceBinding(base, { workspaceId: '', workspaceLabel: '' });
    assert.equal(merged?.workspaceId, undefined, 'empty strings are not a binding');
  });
});
