# 027 — Plugin self-update ("Check for updates")

Package: `plugins/devices` (UI + Host), covers the linked `@dsh-ext/*` plugins of this repo.
Owner decision 2026-11-13: option 3 (own update button), not a registry.

## Why
The plugins are installed as `link:` checkouts, so DSH's Plugin Manager never shows **Update**.

## Behaviour
1. **Check** (manual button in Devices settings; optional check on start, off by default):
   - read local checkout: current branch, HEAD, `package.json` versions of devices/mobile-gateway;
   - `git fetch --tags origin` (read-only on the working tree);
   - latest release = highest semver tag `v*` on origin; show current vs latest and the release notes
     (`git log --oneline HEAD..<tag>`), plus each plugin's `engines.dsh` at that tag and whether it
     accepts the running DSH version.
2. **Update** (explicit click + confirm dialog):
   - refuse when: working tree dirty, HEAD not an ancestor of the tag (no fast-forward), target
     `engines.dsh` rejects the running DSH, or a check is already running;
   - apply only `git merge --ff-only <tag>`. Never reset/stash/checkout/clean/force.
   - run `npm ci --ignore-scripts` only if a lockfile changed; report the literal tail;
   - on success show "Restart DSH to load vX.Y.Z" — never restart DSH itself.
3. **Rollback**: record the previous HEAD; a "Roll back" button does `git merge --ff-only` is not
   possible backwards, so it is offered only as instructions (the previous commit id) — no destructive git.

## Security
- Only the configured remote URL `github.com/nesteacold/dsh-mobile` (shown, not editable from the UI).
- Tags must be reachable from `origin/main`; optional `git verify-tag` when a signing key is configured
  (report "unsigned" otherwise, never block silently).
- git runs with a fixed argv (no shell), a timeout, and `GIT_TERMINAL_PROMPT=0`; no credentials read
  or logged. Owner-only action (local UI principal), never reachable from a remote device or the gateway WS.
- Reviewer pass mandatory (network + code execution surface).

## Tests
Fake git runner: clean/dirty, ff/non-ff, no tags, engines mismatch, timeout, concurrent check.
