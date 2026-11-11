# Plan — 009 Remote iOS build pipeline

**Spec**: [`spec.md`](./spec.md) · **Created**: 2026-11-09 · **Owner**: lead · **Impl**: coder · **Review**: reviewer

## Decisions (locked by the owner's answers)

| # | Decision | Rationale |
|---|---|---|
| D1 | Trigger = **SSH from the Windows machine over Tailscale**. No GitHub remote exists; GitHub Actions is out of scope. | Owner choice; no remote, no push approval yet |
| D2 | Artifact = **`.ipa` retrieved to Windows**, plus **opt-in `-Upload`** to TestFlight via ASC API key on the Mac. | Owner choice; store action stays gated |
| D3 | Build root = **dedicated APFS volume with `-quota 30g`**, deleted whole at the end. | Hard disk cap; deletion is atomic (no partial leftovers) |
| D4 | **No persistent cache by default** (cold pods/npm each run). `-KeepPodsCache` opts into a bounded cache and changes the baseline math. | SC-002 (±1 GB) is the owner's real constraint; speed is secondary |
| D5 | **Device-only build**: `-destination 'generic/platform=iOS'`, never install a Simulator runtime. | Saves 8–12 GB; E2E is out of scope |
| D6 | Signing = **automatic**, `-allowProvisioningUpdates` + ASC API key path on the Mac. | Keeps key material on the Mac only; no secret in repo/logs |
| D7 | Windows side must run on **Windows PowerShell 5.1** (this machine has no `pwsh`). | Verified: `pwsh` absent; repo convention |
| D8 | Source transfer = **working tree packaged via `git ls-files -z -co --exclude-standard` → tar → ssh**, extracted into the build volume; excludes `.dsh-wiki/`, `dist/`, `artifacts/`, `node_modules/`, `.git/`. `-FromHead` packages `HEAD` instead. | `git archive HEAD` would ship stale code: the repo routinely has 50+ uncommitted files; the package must be the code under test, not a snapshot |
| D9 | The remote orchestrator is **staged on the Mac once per run** (`$HOME/.dsh-ios-build/ios-build.sh`, sha256-verified) and executed as `bash <file> …`; the tar arrives on the script's **stdin**. It MUST NOT be piped as `bash -s`. | `bash -s` would parse the tar bytes as shell input and corrupt/abort the run; only a script read from a file leaves stdin free for the payload. The script keeps a dedicated fd for the tar and redirects its own stdin to `/dev/null` so subshells cannot steal payload bytes |

## File layout (all new; nothing else changes)

```
apps/mobile-companion/
├── scripts/remote-ios-build/
│   ├── Invoke-RemoteIosBuild.ps1      # Windows driver (PS 5.1)
│   ├── ios-build.conf.example         # host/user/team/quota/floors — no secrets
│   ├── mac/
│   │   ├── bootstrap-mac.sh           # idempotent one-time checks/installs
│   │   └── ios-build.sh               # remote orchestrator (preflight→build→upload→cleanup)
│   └── test/
│       └── dryrun.Tests.ps1           # PS parse + dry-run contract checks
└── docs/remote-ios-build.md           # operator runbook (setup, run, exit codes, recovery)
```

Config precedence: `-ConfigFile` param → `$env:DSH_IOS_BUILD_CONF` → `scripts/remote-ios-build/ios-build.conf`
(git-ignored copy of the example) → defaults in the script. Secrets are **never** in this file.

## Remote flow (`mac/ios-build.sh`)

```
set -Eeuo pipefail; trap cleanup EXIT INT TERM HUP
0. stdin split: exec 3<&0 (payload fd) then exec </dev/null — subshells and traps can never eat tar bytes
   args (--commit --source --profile --team-id --quota --floor-gb --upload --no-sign --force --self-test)
1. preflight: uname/xcode-select -p/xcodebuild -version/disk floor/idle check/lock mkdir (atomic)
2. baseline: df -g / → record free GB
3. volume:   diskutil apfs addVolume <container> APFS IosBuild -quota <quota>g
             mount → /Volumes/IosBuild ; subdirs src/ home/ npm/ dd/ out/
4. source:   tar -x (from stdin, git archive) → /Volumes/IosBuild/src
5. deps:     npm ci --cache /Volumes/IosBuild/npm  (cwd = apps/mobile-companion)
6. prebuild: npx expo prebuild --platform ios --no-install  (generates ios/)
7. pods:     cd ios && pod install --deployment
8. archive:  xcodebuild archive -workspace ... -scheme ... \
               -destination 'generic/platform=iOS' \
               -archivePath /Volumes/IosBuild/out/app.xcarchive \
               -derivedDataPath /Volumes/IosBuild/dd \
               [-allowProvisioningUpdates -authenticationKeyPath ... -authenticationKeyID ... -authenticationKeyIssuerID ...]
             (--no-sign → CODE_SIGNING_ALLOWED=NO, own exit path)
9. export:   xcodebuild -exportArchive -archivePath … -exportOptionsPlist (generated, no secrets) → out/app.ipa
10. stage:   copy .ipa + ExportOptions.plist → $STAGE_ROOT/artifacts/<run-id>/ — **before** the upload, so an
             upload failure still leaves a retrievable artifact
11. upload:  only with --upload → xcrun altool --upload-app -f app.ipa -t ios --apiKey … --apiIssuer …
12. cleanup (trap, always): kill caffeinate, umount, diskutil apfs deleteVolume, rm lock,
             optional pods-cache purge, postflight df assertion (≤ +1 GB), emit RESULT json block.
             Cleanup MUST NOT sleep the Mac — the driver still has to retrieve the artifact.
```

`RESULT {...}` is the last line on stdout — the driver parses it (exit codes still authoritative).

## Windows flow (`Invoke-RemoteIosBuild.ps1`)

1. Load config, validate params, resolve repo root (`git rev-parse --show-toplevel`).
2. `-DryRun` → print plan: ssh target, commit, quota, floor, volume path, upload command (key **ID** only), and exit 0. No ssh call.
3. Reachability: `ssh -o BatchMode=yes -o ConnectTimeout=10 <target> true` → fail exit 2 after ≤30 s.
4. Lock probe + preflight are re-checked remotely (authoritative) — the driver only reports.
5. `git archive --format=tar HEAD | ssh … 'bash -s -- <args>'` → remote log streamed via `Tee-Object` to
   `artifacts/ios/<UTC-timestamp>/build.log`; exit code captured from `ssh`.
6. On success: `scp` the `.ipa` (+ `ExportOptions.plist`) into the same run dir; verify non-zero size and ZIP magic.
7. Print run summary: artifact path, duration, exit code, disk baseline→final.

Artifacts dir `apps/mobile-companion/artifacts/` must be **git-ignored** (add to `.gitignore`).

## Disk math (Apple Silicon, device-only)

| Step | Peak |
|---|---|
| source + `npm ci` | 1.5 GB |
| `expo prebuild` + `pod install` (cold) | 3 GB |
| `xcodebuild archive` DerivedData | 6 GB |
| archive + `.ipa` | 0.5 GB |
| **total** | **~11 GB** ⇒ quota 30 GB leaves 2.7× headroom |

Baseline cleanup (owner runs once, not automated by the pipeline): `simctl delete unavailable`,
`~/Library/Developer/Xcode/iOS DeviceSupport/*`, `Archives/*`, `DerivedData/*`, `pod cache clean --all`,
`tmutil thinlocalsnapshots /`.

## Guardrails

- **Single-flight**: `mkdir "$LOCK"` (atomic). Stale lock (> 90 min, pid gone) is reclaimed **with a warning line** in the log.
- **Idle**: `ioreg -c IOHIDSystem` `HIDIdleTime/1e9` < 600 s → exit 2 unless `--force`. Policy line always logged.
- **Never sleep mid-build**: `caffeinate -dimsu -w $$ &` then kill in trap. Power-down is **driver-owned**:
  the remote script must not sleep at its own exit (the driver still has to `scp` the artifact and delete the
  stage dir afterwards), so the driver issues the final power action once retrieval is done. **Default is
  stay-awake**; `-SleepAfterBuild` / `-ShutdownAfterBuild` opt into suspending the Mac. A sleeping remote cannot
  be woken by this pipeline, so sleeping by default turned every follow-up build into a manual wake.
- **Environment normalisation (FR-019)**: the remote shell is non-login and non-interactive. `ios-build.sh`
  prepends `/opt/homebrew/bin`, `/usr/local/bin` and `~/.gem/ruby/*/bin` to PATH, and forces a UTF-8 locale when
  the session has none — otherwise `pod` is "not found" and `pod install` aborts with
  `Unicode Normalization not appropriate for ASCII-8BIT`. Both were real failures, observed 2026-11-09.
- **Timeout**: macOS has no `timeout(1)`; use a watchdog subshell (`( sleep 3600; kill -TERM $$ ) &`) killed in the trap.
- **Redaction**: log filter drops lines matching `AuthKey|BEGIN PRIVATE KEY|issuer|p8`; key path printed as `…/AuthKey_<ID>.p8` (ID only).
- **No daemon**: nothing installed; SSH + `bash -s` only.

## Security

- ssh config: `BatchMode=yes`, **`StrictHostKeyChecking=yes`** by default (pinned `known_hosts`), one-shot
  `-AcceptHostKey` → `accept-new` for first contact only, key-only auth (`PasswordAuthentication no`
  server-side), `ListenAddress` = Tailscale IP only.
- Tailscale ACL: only the owner's Windows node may reach the Mac on 22.
- ASC key (`~/.appstoreconnect/private_keys/AuthKey_<ID>.p8`, mode 600) and issuer UUID live in
  `~/.dsh-ios-build.conf` on the Mac (mode 600) — outside the repo, never transferred.
- Reviewer must verify: no secret echo path, no `set -x` around signing, `.gitignore` covers artifacts,
  driver does not log ssh command lines containing key material.

## Phases

1. **P0 — no Mac needed**: scripts written; `-DryRun` + PS 5.1 parse test green on Windows.
2. **P1 — toolchain smoke**: `--no-sign` build produces an unsigned `.ipa`; proves prebuild/pods/xcodebuild and
   the whole disk lifecycle. Owner runs `bootstrap-mac.sh` once.
3. **P2 — signed artifact**: automatic signing with the ASC key; `.ipa` on Windows.
4. **P3 — TestFlight**: `-Upload` end-to-end, one owner-approved run.

## Verification (what "done" means for the coder)

- `powershell -NoProfile -ExecutionPolicy Bypass -File Invoke-RemoteIosBuild.ps1 -DryRun` exits 0, prints the plan,
  and makes **zero** ssh calls (verifiable with `-WhatIfSsh`/log assertion).
- `[System.Management.Automation.Language.Parser]::ParseFile` on the driver reports 0 errors under 5.1.
- `bash -n mac/ios-build.sh` and `bash -n mac/bootstrap-mac.sh` are clean (Git Bash on Windows is acceptable).
- Exit codes match the spec table; `--help` documents them.
- No secret literal, path, or echo in either script or in the runbook (reviewer check).
