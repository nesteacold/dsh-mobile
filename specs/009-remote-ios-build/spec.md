# Feature Specification: Remote iOS build pipeline (Tailscale Mac, disk-bounded)

**Feature Branch**: `009-remote-ios-build`

**Created**: 2026-11-09

**Status**: Draft

**Input**: Owner request — "có một máy Mac … setup tailscale và remote … cần pipeline build tự động để tránh
chiếm máy và dọn dẹp sau khi build xong vì sắp hết ổ cứng". Clarified by the owner: trigger = SSH from the
Windows dev machine; output = `.ipa` + TestFlight upload; free disk on the Mac = **>50 GB**; Mac = **Apple
Silicon, Xcode installed**.

**Touches**: `apps/mobile-companion/` (scripts + docs only; no app source change), `specs/009-remote-ios-build/`.

## Context and constraints

- `dsh-ext` has **no git remote**; GitHub Actions is therefore not available and is out of scope for this
  feature. Pushing to a remote needs separate owner approval.
- `apps/mobile-companion` has **no `ios/` directory yet**; the first build must run `expo prebuild --platform ios`
  and `pod install`.
- The Mac belongs to a third party ("máy Mac của bạn"), reachable only over **Tailscale**. It MUST NOT be
  occupied outside a build, and MUST be left with the same free disk it had before the build.
- Repo hard boundaries apply unchanged: no credential, signing key, or APNs/ASC secret in git, logs, or
  artifacts; **no store upload without explicit owner approval** (TestFlight included); no EAS quota spend.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - One command builds an iOS artifact from Windows (Priority: P1)

The owner, sitting at the Windows machine with no macOS, runs one command and gets a signed `.ipa` plus a
build log back on Windows. The command does the source transfer, dependency install, prebuild, archive, export
and retrieval; it needs no Xcode GUI and no manual step on the Mac.

**Why this priority**: Without it there is no iOS build path at all (no Mac locally, no remote CI). Everything
else refines this.

**Independent Test**: From a clean Windows shell, run the driver script against the Mac; assert a `.ipa` exists
under the local artifacts directory, `file *` reports an iOS zip payload, and the exit code is 0 on success.

**Acceptance Scenarios**:

1. **Given** a reachable Mac with Xcode and >50 GB free, **When** the owner runs the driver once, **Then** a
   signed `.ipa` and a complete log land on Windows and the command exits 0.
2. **Given** the Mac is unreachable over Tailscale, **When** the driver runs, **Then** it fails within ~30 s
   with a clear message naming the tunnel, and nothing is transferred.
3. **Given** `-DryRun`, **When** the driver runs, **Then** it prints every planned remote step and the disk
   budget, changes nothing on the Mac, and exits 0.

---

### User Story 2 - The Mac's disk is left exactly as it was found (Priority: P1)

Every build is confined to a dedicated APFS volume with a hard size cap, and the whole volume is deleted at the
end. Before the build the driver records free space; after the build it proves free space returned to baseline.
A leftover of more than 1 GB is a reported failure, not a silent leak.

**Why this priority**: The owner's stated blocker is a nearly-full disk. A pipeline that leaks DerivedData is
worse than no pipeline.

**Independent Test**: Run the build twice; record `df -g` before/after each; assert (a) the build volume is
gone, (b) free space is within 1 GB of baseline, (c) no `DerivedData`/source tree remains under the build root.

**Acceptance Scenarios**:

1. **Given** a successful build, **When** cleanup runs, **Then** the build volume no longer exists and free
   space is within 1 GB of the pre-build value.
2. **Given** a build that fails mid-archive, **When** the failure unwinds, **Then** cleanup still runs and the
   same disk assertions hold.
3. **Given** the Mac reports free space below the configured floor, **When** the driver starts, **Then** it
   aborts before transferring source or creating a volume, with exit code 2.

---

### User Story 3 - The Mac is never hogged (Priority: P2)

A build starts only when the machine is idle, only one build can run at a time, and the machine returns to
sleep when the build ends. Nobody has to remember to close anything.

**Why this priority**: Protects the third-party owner's machine from a forgotten 20-minute build or a wedged
second job.

**Independent Test**: Start two builds concurrently; the second is refused with the lock holder named. Simulate
input activity on the Mac; the driver refuses to start unless forced.

**Acceptance Scenarios**:

1. **Given** a build is running, **When** a second driver run starts, **Then** it exits 3 and names the running
   job; the Mac's CPU use does not double.
2. **Given** the Mac saw keyboard/mouse input < 600 s ago, **When** the driver runs without `-Force`, **Then**
   it exits 2 and reports the idle time.
3. **Given** a build finished, **When** the driver exits, **Then** the Mac goes back to sleep (or shuts down when
   `-ShutdownAfterBuild` was passed) and the display is not kept awake.

---

### User Story 4 - TestFlight upload is a deliberate, opt-in action (Priority: P3)

The owner can append `-Upload` to send the same `.ipa` to TestFlight using an App Store Connect API key that
lives only on the Mac. Without the flag, no network call to Apple is made.

**Why this priority**: Distribution matters eventually (A041/A043), but it is a store action gated on owner
approval per repo rules.

**Independent Test**: Run without `-Upload` and confirm no `altool`/`iTMSTransporter` process or Apple network
call occurs; run with `-Upload` and `-DryRun` and confirm the upload command is printed with the key ID only,
never the key material or issuer secret.

**Acceptance Scenarios**:

1. **Given** no `-Upload`, **When** the build succeeds, **Then** the pipeline performs no Apple API call.
2. **Given** `-Upload`, **When** the upload fails, **Then** the locally retrieved `.ipa` is kept, the failure is
   reported with Apple's message (secrets redacted), and the command exits 5.
3. **Given** any run, **When** logs are inspected, **Then** no `.p8` content, issuer UUID, or provisioning
   profile blob appears in them.

### Edge Cases

- Mac asleep but reachable (Tailscale up, `sshd` up): driver wakes it or fails fast — never hangs indefinitely.
- Tailscale drops mid-build: the remote side must still run its cleanup trap and leave no volume behind.
- Xcode license not accepted / `xcode-select` points at Command Line Tools: fail early with the exact remedy.
- No code-signing identity, or the provisioning profile expired: fail with exit 4 and identity **count** only.
- Two Apple team IDs configured: refuse and require `-TeamId` rather than guessing.
- Disk full *during* the build: the volume quota turns it into a clean build failure, not a corrupted host disk.
- Artifact transfer interrupted: local partial file is deleted, not left as a truncated `.ipa`.
- Build log too large: log is capped and truncated in the middle with a marker.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: A single Windows-side command MUST perform the whole build and return a `.ipa`; it MUST NOT
  require EAS, an Expo login, or any interactive prompt.
- **FR-002**: The pipeline MUST NOT consume EAS build quota and MUST NOT create an EAS project.
- **FR-003**: Remote build state MUST live in a dedicated APFS volume created with a size **quota** (default
  30 GB), and cleanup MUST delete that volume so no partial file can survive.
- **FR-004**: The pipeline MUST check remote free space before doing work (default floor 15 GB) and MUST verify
  free space returned to baseline (±1 GB) afterwards; a larger delta MUST be a reported failure.
- **FR-005**: Concurrent invocations MUST be refused by an atomic single-flight lock, naming the holder.
- **FR-006**: A build MUST NOT start while the Mac shows recent user input (default 600 s idle requirement) unless
  `-Force` is passed; the chosen policy MUST be recorded in the log.
- **FR-007**: Source MUST be the **current working tree** — tracked files plus untracked files that `.gitignore`
  does not exclude, including uncommitted edits — never a bare `git archive HEAD` (this repo carries dozens of
  uncommitted files during normal work, so a HEAD-only package would silently build stale code). The package
  MUST exclude `node_modules/`, build outputs (`dist/`, `artifacts/`), `.dsh-wiki/`, and `.git/`, and MUST
  preserve the repo layout so the app's `file:../../packages/mobile-protocol` dependency resolves.
  A `-FromHead` switch MAY package `HEAD` instead, for reproducing a committed build, and the log MUST state
  which source was used (HEAD vs worktree) plus the HEAD sha and the dirty-file count.
- **FR-008**: The pipeline MUST retrieve both the `.ipa` and the build log to Windows, into a per-run directory.
- **FR-009**: TestFlight upload MUST be opt-in (`-Upload`), MUST use an App Store Connect API key stored only on
  the Mac, and MUST never print the key or issuer value.
- **FR-010**: No secret material MUST enter the repo, the transferred source, the artifact directory, or logs.
  Scripts MUST accept paths/env names, never secret literals.
- **FR-011**: After a run the Mac MUST be left **idle but reachable by default** (awake, no build
  process, no `caffeinate`); `-SleepAfterBuild` suspends it and `-ShutdownAfterBuild` powers it off, both
  performed by the driver after retrieval. Default is awake because a suspended remote cannot be woken by
  this pipeline — a sleeping Mac made the next build impossible without a human touching the machine
  (observed 2026-11-09). No daemon or background agent may be installed by this feature.
- **FR-012**: Exit codes MUST be distinguishable per the contract below so the driver can be scripted.
- **FR-013**: A `-DryRun` mode MUST print the full plan (steps, paths, disk budget, upload command) without
  touching the Mac.
- **FR-014**: A one-time bootstrap path MUST verify/install prerequisites on the Mac (Tailscale, remote login,
  Xcode + license, volume helper, upload tool) and MUST be idempotent.
- **FR-015**: The Windows-side script MUST run on **Windows PowerShell 5.1** (`pwsh` is not installed on this
  machine): no PS7-only syntax, no Unicode/BOM traps.
- **FR-016**: The Mac MUST NOT sleep, unmount, or delete anything the driver still needs. Concretely: the
  artifact MUST be staged **before** the TestFlight upload attempt, retrieval MUST happen for a successful build
  **and** for an upload failure (exit 5), and the sleep/shutdown request MUST be issued **by the driver after**
  the artifact and log are on Windows (or after a bounded delay), never by the remote script at its own exit.
  A build whose upload failed MUST leave the `.ipa` on the Windows side.
- **FR-019**: The remote session MUST normalise its own environment, because ssh starts a non-login,
  non-interactive shell: `PATH` MUST include the Homebrew/user-gem bin directories (otherwise `node`, `npm` and
  `pod` are invisible) and the locale MUST be UTF-8 (otherwise Ruby/CocoaPods abort with
  `Unicode Normalization not appropriate for ASCII-8BIT`). The behaviour MUST be identical over ssh and in an
  interactive terminal, and MUST NOT depend on the owner's dotfiles.
- **FR-017**: Signing preflight MUST NOT require a pre-existing keychain identity when an App Store Connect API key
  is configured (automatic signing creates the certificate): missing identity is a **warning** in that case and a
  hard failure (exit 4) only when no API key is configured.
- **FR-018**: The remote orchestrator MUST be executed from a **file staged on the Mac** and verified by sha256
  before use — never piped to `bash -s` — because the source tar occupies the process's stdin. The script MUST
  reserve a dedicated file descriptor for the payload and redirect its own stdin to `/dev/null` so that
  subshells, traps, and child processes cannot consume tar bytes.
- **FR-020**: The driver MUST be able to wait for an unreachable Mac (`-WaitForHost <seconds>`, polling every
  15 s) and start the build when it answers, instead of failing and requiring the command to be re-run by hand.
  Without the flag it MUST fail fast with exit 2.
- **FR-021**: Cleanup MUST delete the APFS build volume **by name/device**, not by mount path, and MUST verify
  that no volume with that name remains registered in the container. `deleteVolume <path>` silently fails once
  the volume is unmounted, and each orphan keeps 1–3 GB that neither `/Volumes` nor `df` shows: measured
  2026-11-09, six orphans / 16.5 GB took the Mac from 22 GB to 9 GB free across six runs. A leftover MUST be a
  run failure (exit 6), the self-test MUST report orphans, and the next run MUST reclaim them before building.

### Exit code contract *(part of FR-012)*

| Code | Meaning |
|---|---|
| 0 | build ok (and upload ok, if requested) |
| 2 | preflight refusal: unreachable, not idle, low disk, bad params |
| 3 | another build holds the lock |
| 4 | build failure (prebuild / pods / compile / export / signing) |
| 5 | upload failure (artifact kept locally) |
| 6 | cleanup assertion failed (disk did not return to baseline, or volume still mounted) |

### Key Entities

- **Build run**: one invocation — id, start/end, git commit, profile, disk baseline, artifact path, exit code.
- **Build volume**: the quota-bounded APFS volume, its mount point, quota size, and deletion proof.
- **Artifact**: `.ipa` + `ExportOptions.plist` (no secrets) + log, per-run directory on Windows.
- **Lock**: single-flight marker on the Mac naming the holder and its start time.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A first-time build completes end-to-end (source transfer → TestFlight, if requested) in ≤ 35 min on
  the owner's Mac; subsequent builds ≤ 25 min.
- **SC-002**: Across 3 consecutive runs, free space on the Mac returns within **±1 GB** of baseline each time, and
  no build volume remains.
- **SC-003**: A failing build (deliberately broken source) still produces exit 4 **and** the SC-002 disk result.
- **SC-004**: Zero occurrences of `.p8` content, issuer value, certificate/expiry names, or profile blobs in any
  log, artifact, or committed file — verified by review, not assertion.
- **SC-005**: An unreachable-Mac run fails in ≤ 30 s with a message that names the cause; a busy-Mac run fails in
  ≤ 10 s.
- **SC-006**: No process, launchd agent, or mount from the pipeline survives the run (`ps`/`launchctl list`/
  `mount` clean afterwards).

## Out of scope

- GitHub Actions, any CI runner, any remote push (no git remote exists; needs owner approval).
- iOS Simulator builds and Maestro E2E on the Mac (needs an 8–12 GB runtime; revisit after disk headroom).
- Android builds, EAS Build/EAS Submit, App Store (production) submission, TestFlight beta review.
- Multiple Macs, build farms, or concurrent builds on one Mac.

## Assumptions

- Mac: Apple Silicon, macOS with Xcode installed and license accepted, >50 GB free at build time.
- Tailscale is installed on both hosts and the Mac is on the tailnet with SSH enabled; the ACL permits only the
  owner's Windows machine.
- An Apple Developer team exists; `expo.ios.bundleIdentifier` in `apps/mobile-companion/app.json` is the app id.
- The TestFlight API key (`.p8`) is placed on the Mac by the owner, outside the repo, mode 600.
- Each TestFlight upload is approved by the owner before the run (repo policy A043).
