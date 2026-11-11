# Blocker record — `expo-modules-jsi` vs Swift 6.2

**Status**: **RESOLVED — a signed-out `.ipa` builds** (`--jsi-sendable-patch`) · **Recorded**: 2026-11-09/10 ·
**Spec**: [`spec.md`](./spec.md) · **Runbook**: [`../../apps/mobile-companion/docs/remote-ios-build.md`](../../apps/mobile-companion/docs/remote-ios-build.md)

## Re-confirmed 2026-11-10, and the runbook consequence

Rebuilding with today's source **fails without the flag** (`exit 4`, `ARCHIVE FAILED` on the
`Build ExpoModulesJSI xcframework` phase) and **succeeds with it** (`exit 0`, 3 m 42 s,
`artifacts/ios/20261110T092346Z/app.ipa`, 10,671,717 B, SHA-256
`8EAD6FF4910E48664A37C225A5BA10C3EDE022A54F0C4AD70F685C6A2B518C9B`). Two things worth writing down:

1. **The "unsigned smoke test" command in the runbook is wrong without the flag.** A plain
   `-NoSign -Profile development -Force` run cannot succeed on this Mac; it must be
   `-NoSign -Profile development -Force -JsiSendablePatch`. Anyone following the older text will
   conclude iOS is broken.
2. **The failure is easy to misdiagnose as a dependency regression.** The log's last activity is
   `CompileC ... RNWorklets`, and `react-native-worklets` / `react-native-reanimated` are present in
   `node_modules` but are **not** direct `dependencies` — they are optional peers of
   `react-native-web`/`react`. I chased that first and it was a dead end: the lockfile has not
   changed since 2026-11-09 06:39, the iOS package **excludes `node_modules`**, and the successful
   09-Nov build already contained worklets (461 `RNWorklets`/`ExpoModulesWorklets` mentions, 617
   `reanimated`). The real error is one line in the Swift compile, and it is this blocker.

The rebuilt artifact was also checked for content, not just exit code: `Payload/DSHCompanion.app`
with `en.lproj` + `vi.lproj`, and its `main.jsbundle` (3,067,224 B) contains `pairing-challenge`,
`pairing-proof`, `pairing-pending` and the new approval copy — so the iOS build carries today's
pairing-proof client, not a stale bundle.

## Result (measured, twice)

```
exit=0  status=ok  durationSec=207
archive: /Volumes/DSHIosBuild/out/app.xcarchive
export: unsigned .ipa packaged (DSHCompanion.app)
done: build ok
cleanup: volume DSHIosBuild deleted (verified: none left in the APFS container)
cleanup: free space 23 GB -> 23 GB (within 1 GB)
```

Artifact: `artifacts/ios/<run-id>/app.ipa`, **10.7 MB**, valid ZIP, contains
`Payload/DSHCompanion.app/{DSHCompanion, main.jsbundle, Info.plist}` and `Info.plist` carries
`com.dshext.companion` / `DSH Companion` / `0.1.0`. Reproduced on a second run (10.17 MB). Source was the
**working tree** (62–63 uncommitted files), not a stale HEAD.

## The fix that worked: `--jsi-sendable-patch`

Two edits, both inside the disposable build volume, both semantics-preserving:

1. `JavaScriptValue+Slot.swift`: `public struct Slot: ~Copyable` → `: ~Copyable, @unchecked Sendable`. The struct
   already stores `nonisolated(unsafe) let start: UnsafeMutableRawPointer`, so the assertion matches the code.
2. `JavaScriptObject.swift` (~line 944): build the Slot **outside** the isolated closure instead of sending the raw
   pointer into it —
   ```swift
   let slotValue = JavaScriptValue.Slot(slot)
   try runtime._withUnsafeGuaranteedRef { runtime in
     try JavaScriptActor.assumeIsolated { try encode(slotValue, runtime) }
   ```
   This is the important one: the diagnostic named `slot` (the pointer), not the Slot type, so `Sendable` alone
   was not enough. The call site's own comment already states the closure runs synchronously on the same thread.

**Caveat that must not be lost:** this edits third-party concurrency code in a client that handles pairing
credentials. It compiles and the artifact is correct, but per repo policy it needs a **reviewer pass** before the
production/signed path relies on it, and it must be dropped when Expo ships a jsi that compiles natively.
It stays **opt-in** (`--jsi-sendable-patch`), never the default.

## Why the default (unpatched) path still fails

`expo-modules-jsi@58.0.22` (latest) declares `swift_version = '6.0'` and builds its xcframework from a Pods script
phase that runs a nested `xcodebuild` under **`env -i`**, so no build setting of ours reaches it. Xcode 26.0.1 ships
Swift 6.2, which rejects `JavaScriptObject.swift:946: error: sending 'slot' risks causing data races`.
A newer Xcode (the package's own script comments reference 26.4/27) would make the default path work with no patch.

## Host

| | |
|---|---|
| Mac | `Sunjins-Mac-mini.local`, Apple Silicon, macOS **26.6.2** |
| Xcode | **26.0.1** (17A400), `xcode-select` → `/Applications/Xcode.app/Contents/Developer` |
| Swift (Xcode) | **6.2** (swiftlang-6.2.0.19.9) |
| Swift (CLT) | **6.1.2** (`/Library/Developer/CommandLineTools/usr/bin/swiftc`) |
| CocoaPods | 1.16.2 at `/opt/homebrew/bin/pod` |
| Free disk | 24 GB (healthy: the cleanup leak is fixed) |

## Where the build stops

```
expo-modules-jsi/apple/Sources/ExpoModulesJSI/Runtime/Values/JavaScriptObject.swift:946:36:
error: sending 'slot' risks causing data races
** ARCHIVE FAILED **
```

`expo-modules-jsi@58.0.22` is the **latest published** version (checked: `npm view expo-modules-jsi versions`).
Its podspec declares `swift_version = '6.0'`, and it builds its xcframework from a Pods **script phase** that runs a
nested `xcodebuild` under **`env -i`** — a clean environment with no inherited build settings. That is why no flag
of ours reaches the failing compilation.

## Experiments already run (all failed, all measured)

| # | Attempt | Result |
|---|---|---|
| 1 | Default: Xcode 26.0.1 / Swift 6.2, Swift 6 mode | `sending 'slot' risks causing data races` |
| 2 | Patch nested build → `SWIFT_VERSION=5` | data-race gone; next error `'$' is not a valid digit in integer literal` (bare-slash regex) |
| 3 | + `-enable-bare-slash-regex` via `OTHER_SWIFT_FLAGS` | regex fixed; next error `'exception' file not found` (C++ interop off in Swift 5 mode) |
| 4 | + `SWIFT_ENABLE_CXX_INTEROP`/`HEADER_SEARCH_PATHS` | `Microtasks.h` / `TypedArray.h not found` — my header override broke the package's own includes |
| 5 | + `-cxx-interoperability-mode=default` (correct Swift 6.2 name) | `'jsi/jsi.h' file not found` — the package's C++ interop needs Swift 6 mode, not Swift 5 |
| 6 | Keep Swift 6, swap compiler: `SWIFT_EXEC=<CLT swiftc 6.1.2>` | `Swift.swiftmodule/arm64e-apple-ios.swiftinterface:1:1: error` — Swift 6.1 cannot read Xcode 26's SDK interface |
| 7 | Look for a prebuilt xcframework to skip compiling | none: `prebuilds/` ships **headers only** (`ExpoModulesJSIHeaders.tar.gz`); `Products/*.xcframework` is always built by the script |

**Conclusion**: the failure is not a configuration mistake. `expo-modules-jsi` 58.0.22 requires a Swift 6 toolchain
that accepts its strict-concurrency code, and Xcode 26.0.1's Swift 6.2 does not. No build setting available on this
host changes that, and an older compiler cannot be mixed with the newer SDK.

## The two real options (owner decision)

### A. Upgrade Xcode on the Mac (recommended for SDK 58)

The package's own script comments reference **Xcode 26.4 / Xcode 27**, i.e. it was written against a newer toolchain
than the installed 26.0.1. Describe the disk work first:

- Xcode 26.4+ download is ~10 GB; installed footprint ~40 GB with SDKs and simulator runtimes.
- The Mac has **24 GB** free. The removable candidates, largest first:
  - `/Library/Developer/CoreSimulator` **49 GB** — the iOS 18.6 + iOS 26.0 runtime disk images. Removing iOS 18.6
    alone frees ~8–10 GB and is re-downloadable from Xcode Settings.
  - `~/Library/Application Support` 18 GB, `~/Library/Containers` 22 GB, `~/fvm` 10 GB — the owner's own data,
    not ours to touch.
- After the upgrade: `sudo xcode-select -s /Applications/Xcode.app`, accept the license, rerun
  `Invoke-RemoteIosBuild.ps1 -SelfTest`, then the unsigned build.

### B. Downgrade Expo to match Xcode 26.0.1

Changes `apps/mobile-companion` dependencies (SDK 58 → the SDK line that predates this JSI pod's Swift-6 code). This
touches the product's dependency graph and lockfile, so it needs the owner's explicit approval, and it must be
re-verified against `packages/mobile-protocol` (contract v1) and the RN new-architecture assumptions.

### C. Override only `expo-modules-jsi` — **tested, eliminated**

Run through the pipeline probe `--jsi-override=<version>` (installs into the disposable volume only; the repo
and the Mac are untouched). **Key detail learned:** `npm install expo-modules-jsi@ver --no-save` is useless here —
`expo-modules-core` keeps its **own nested copy** which wins at build time (the failing compile came from
`node_modules/expo-modules-core/node_modules/expo-modules-jsi`). Only npm `overrides` rewrites the whole tree;
after that the log shows exactly one copy: `deps: PROBE jsi copies: expo-modules-core/node_modules/expo-modules-jsi=58.0.14`.

| JSI version | Result with Xcode 26.0.1 / Swift 6.2 |
|---|---|
| 58.0.22 (latest, what SDK 58 resolves) | `JavaScriptObject.swift:946: error: sending 'slot' risks causing data races` |
| 58.0.14 | data-race gone, then 5 × `error: 'weak' must be a mutable variable` |
| **58.0.20** | **compiles cleanly** (no data race, no `weak let`) — but then `expo-modules-core@58.0.30` fails with `type 'JavaScriptValue' has no member 'encoding'`, an API only present in jsi ≥ 58.0.21 |
| 58.0.20 + core 58.0.20 | gets further still, then fails in the app's own Expo glue: `expo/ios/Expo/ExpoReactNativeFactoryDelegate.swift:16:39: error: cannot find 'ExpoRootViewController' in scope` (core 58.0.20 predates the class expo 58.0.23 expects) |

Source scan across publishes (both defects, per version):

| | 58.0.14 | 58.0.16 | 58.0.20 | 58.0.21 | 58.0.22 |
|---|---|---|---|---|---|
| `weak let` (rejected by 6.2) | 5 | 0 | 0 | 0 | 0 |
| `Slot(slot)` data race | 0 | 0 | 0 | 1 | 1 |

So the constraint chain inside SDK 58 is rigid: `expo 58.0.23` → `expo-modules-core 58.0.30` → needs
`JavaScriptValue.encoding` → only exists in `expo-modules-jsi ≥ 58.0.21` → every such version has the Swift 6.2
data-race error. **There is no combination of published versions that compiles on this host.** Lowering core to
match the good jsi breaks expo's own iOS glue. Option C is closed by measurement, not by opinion.

Two useful consequences:
1. The data-race defect is **specific to jsi ≥ 58.0.21**, not systemic — so a newer Xcode (which accepts that code)
   makes the whole SDK 58 stack work. This is the cheapest path to the objective.
2. If Expo publishes a jsi patch above 58.0.22 that also removes the region-isolation error, the default pipeline
   starts working with no changes: `--jsi-override` exists for exactly that probe.

## What is already proven working (do not re-litigate)

- SSH over Tailscale (key-only, `StrictHostKeyChecking=yes`), staged orchestrator + sha256 verify.
- Source transfer of the **working tree** (59 uncommitted files included), 502 entries, no `node_modules`.
- APFS volume with quota, mount, `npm ci`, `expo prebuild --platform ios`, `pod install` (locale fixed).
- Unsigned signing flags, exit-code contract, and **cleanup that leaves zero orphaned volumes** — the 16.5 GB leak
  is fixed and re-verified after every build (`free space 23 GB -> 23 GB (within 1 GB)`).
- 205 automated checks pass (`test/dryrun.Tests.ps1 -IncludeBash` 178 + `test/package.Tests.ps1` 27).
