# 019 — Parity Wave 3: high-risk features — design notes (beastcore, read-only R&D)

Date: 2026-11-11. Author: beastcore. Status: design input for lead; no code changed.
Labels: (a) measured/run · (b) read from source, path:line · (c) inferred, unverified.
Abbrev: `AL` = `plugins/mobile-gateway/lib/allowlist.mjs`; `CL` = `_upstream/Clarklevis1995__dsh-mobile/androidApp/src/main/kotlin/com/clarklevis/dsh/android/`.

Precedent: today every Wave-3 type is refused for device tokens by `ADMIN_ONLY_TYPES` (AL:71-102) and,
for the mutating ones, a second layer `COMPANION_DENIED_HOST_ENDPOINTS` (AL:110-120) (b). Nothing below
has been runtime-measured in this pass; no (a) facts. Contract `mobile-protocol-v1.md` and gap list
`docs/arch-notes/clarklevis-parity-gap-20261111.md` were not re-read this pass (budget) — lead should
cross-check scope names against them.

Common design rule for all items (c): a feature is unlocked only by a **new, never-default scope**
granted per device by the owner at pair time or later on desktop, revocable in isolation; both layers
(router allowlist and host-adapter deny list) must be lifted for that scope only, never globally.
Every unlock needs: (1) positive test with scope, (2) negative control same request without scope →
refused, (3) adversarial test (scope for X used to call Y), (4) revocation test (scope removed mid-session → next request refused).

---

## 1. File browser + previews (`file-list`, `file-resolve`, `file-download-*`)
- Clarklevis: request types `file-resolve, file-list, file-download-open/read/cancel` CL/AndroidSharedStateHolder.kt:3688-3691; capability gate `"file-downloads"` :1272, :1334; integrity/offset failure handling :2847-2849; UI ConversationScreen.kt:375 (b).
- Our allowlist: refused, AL:85 (b). Host endpoint `session/canOpenWorkspacePath` denied AL:118 (b).
- Threat (stolen token): read any file reachable by the resolver — source, `.env`, SSH keys if path escapes workspace; bulk exfiltration via chunked read (c).
- Narrowest design: scope `files:read` (never-default); server-side root jail = session workspace realpath, reject symlink escape, deny-glob (`.env*`, `*.pem`, `id_*`, `.git/`, DSH profile dir); size cap + per-device byte budget/day; read-only; audit log of path+bytes (no content).
- Tests: `..`/absolute/UNC/symlink/junction escape refused; deny-glob refused; negative control without scope; revoked scope mid-download stops next chunk; offset/hash mismatch.
- Reviewer: realpath after open (TOCTOU), Windows case/8.3 names, ADS `file:stream`, budget enforced server-side.
- Recommendation: **do later** (first, after Wave 2), read-only only.

## 2. Phone file upload (`file-upload-open/chunk/finish/cancel`)
- Clarklevis: CL/platform/AndroidFileUploadController.kt:128,155; capability `"file-upload-v1"` AndroidSharedStateHolder.kt:3098; timeout handling :3180-3187 (b).
- Allowlist: refused AL:86 (b); `session/attachment` denied AL:118 (b).
- Threat: write arbitrary bytes into workspace → poisons files the agent then executes (prompt/code injection), disk fill (c).
- Narrowest: scope `files:upload`; destination fixed to a per-session inbox dir (`.dsh-mobile-inbox/<session>/`), server-generated names, no overwrite, size/count caps, type sniff; agent only sees it as attachment the user explicitly sends.
- Tests: filename traversal, overwrite attempt, oversize, chunk reorder/replay, negative control, revoke.
- Reviewer: no client-chosen path ever reaches fs; quota; cleanup.
- Recommendation: **do later** (after item 1), inbox-only.

## 3. Slash commands (`commands`, `command-options`, `command-select`, `command-execute`)
- Clarklevis: SLASH_COMMAND_REQUEST_TYPES CL/AndroidSharedStateHolder.kt:3681-3682; execute :2102, :2496; capability `"commands"` :413, :1759 (b).
- Allowlist: refused AL:88; `commands/execute` denied AL:117 (b).
- Threat: commands are an open-ended surface (plugins register them) — can change model, permissions, compact/clear sessions, run plugin actions with Host authority; effectively admin (c).
- Narrowest: scope `commands:run` + **server-side command allowlist** (e.g. read-only/benign commands only); listing (`commands`) can be under a lighter `commands:list`; unknown/plugin commands refused by default.
- Tests: execute non-allowlisted command refused; command name spoof/casing; args injection; negative control; plugin-registered command not reachable.
- Reviewer: allowlist keyed on stable command id not display name; no passthrough of arbitrary args.
- Recommendation: **do later**, list-only first; execute with curated allowlist.

## 4. Agent permission control (`permission`, `permission-options`)
- Clarklevis: request `permission-options` AndroidSharedStateHolder.kt:1810; picker ConversationScreen.kt:2375-2422; global default change SettingsScreen.kt:334-339 (`setDefault("permission", …)`), values incl. `danger-full-access` ConversationScreen.kt:3767-3771 (b).
- Allowlist: refused AL:80; `permissions/*`, `permissionPresets/*` denied AL:113 (b).
- Threat: stolen token escalates session to `danger-full-access` → agent runs anything without approval; this defeats the whole approval model (c).
- Narrowest: viewing current mode read-only is fine; **lowering** (toward read-only/ask) may be allowed under `permissions:restrict`; raising never from phone. Global default: never.
- Tests: raise attempt refused even with scope; lower allowed; negative control; global default refused.
- Reviewer: monotonic-downward check done server-side against an ordered enum.
- Recommendation: **do** read+lower only; **do not** raise / global default.

## 5. Default model / agent preset (`default-model`, `save-default-model`, `agent-presets`, `select-agent-preset`)
- Clarklevis: requests AndroidSharedStateHolder.kt:1408-1446, save :1694-1701; screens SettingsScreen.kt:183-194, :375, :443 (b).
- Allowlist: refused AL:81-82; `agentPresets/select`, `settings/*` denied AL:115,112 (b).
- Threat: switch to an attacker-chosen/costly provider, preset with weaker prompts or wider tools; deployment-wide effect (c).
- Narrowest: read-only listing under `settings:read`; per-session preset select (`agentPresets/select`) under `sessions:configure` restricted to existing presets; save-default (global) desktop-only.
- Tests: unknown preset id refused; global save refused; negative control.
- Recommendation: **do later** read + per-session select; **do not** global save.

## 6. Workspace create (`directories`, `directory-create`, `workspace-create`, `workspaces`)
- Clarklevis: AndroidSharedStateHolder.kt:2583, :2597, :3677-3679; offline policy AndroidOfflineCatalogPolicy.kt:11 (b).
- Allowlist: refused AL:84; `workspace/create` denied AL:114 (b).
- Threat: `directories` = host filesystem enumeration outside any workspace; create = make dirs anywhere, then point agent there (c).
- Narrowest: no free browsing; owner-configured list of allowed parent roots; create only `<root>/<sanitized-name>`; scope `workspaces:create`.
- Tests: traversal/absolute name, root not in list, reserved names (CON, NUL), negative control.
- Recommendation: **do later** (low value vs risk); never expose `directories` free-form.

## 7. Plugin management (`plugin-*`, 16 types)
- Clarklevis: AndroidSharedStateHolder.kt:814-941 (catalog/update/install/enable); PluginsScreen.kt:184,262,289 (can disable the gateway itself) (b).
- Allowlist: refused AL:73-77; `pluginInventory/*`, `pluginManager/*` denied AL:111 (b).
- Threat: install arbitrary plugin = code execution on Host with full privileges; disable security plugins (c).
- Narrowest: at most read-only catalog view; no install/update/enable/remove/settings.
- Recommendation: **do not** (mutations); read-only catalog **do later** if ever.

## 8. Voice input (`speech-*`)
- Clarklevis: on-device mic + host transcription: capability `"speech-input-v1"` AndroidSharedStateHolder.kt:3095, events :3490,:3565; ConversationScreen.kt:1572-1574; AndroidVoiceInputAdapter.kt:91-187 (b).
- Allowlist: refused AL:89-90; `speech/*` denied AL:119 (b).
- Threat: `speech-configure`/`speech-prepare` may download models/change provider (network+disk); transcribe sends audio to Host provider (privacy, cost) (c).
- Narrowest: prefer **phone OS dictation** (no gateway surface at all); if host-side needed, allow only `speech-transcribe/cancel` under `speech:transcribe`, never configure/prepare.
- Recommendation: **do** via OS keyboard dictation (zero new surface); host speech **do not**.

## 9. Embedded Tailscale tunnel
- Clarklevis: in-process Go/tsnet node via gomobile CL/platform/TsnetTunnel.kt:18-30; controller TailscaleTunnelController.kt; settings TailscaleTunnelSettings.kt:20-135 (accounts in SharedPreferences :120); auth key paste TailscaleTunnelScreen.kt:396; transport route RtcGatewayTransport.kt:42 (b).
- Allowlist: n/a — no gateway message; it is a client network/auth surface (b).
- Threat: app holds tailnet node key + auth key → stolen phone/backup gives tailnet membership beyond DSH; large native Go dependency (c). Also requires login (owner-only act).
- Narrowest: do not embed; document using the official Tailscale app/VPN to reach the TLS gateway. If ever: keystore-backed secrets, no auth-key paste, ACL-tagged node, owner approval.
- Recommendation: **do not** (use system Tailscale).

---

## Lead review note (2026-11-11)

Scope-name conflict: `files:read` **already exists** in the contract vocabulary and is part of the
`standard` preset (`packages/mobile-protocol/src/index.mjs:165,262`), so the paired emulator holds it
today. The file browser must therefore use a **new**, never-default scope (working name
`workspace-files:read`) rather than reuse `files:read`; reusing it would silently grant directory
listing and downloads to every device already paired with the standard preset. Every other scope name
proposed here must likewise be checked against that vocabulary before implementation.

## Ranked summary

| Rank | Item | Risk | Recommendation | New scope |
|---|---|---|---|---|
| 1 | 8 Voice via OS dictation | none | do | — |
| 2 | 4 Permission view + lower only | med | do | `permissions:restrict` |
| 3 | 1 File browser read-only, jailed | high | do later | `files:read` |
| 4 | 5 Preset per-session select / read | med | do later | `settings:read`, `sessions:configure` |
| 5 | 3 Slash commands (list, curated execute) | high | do later | `commands:list`, `commands:run` |
| 6 | 2 Upload to inbox | high | do later | `files:upload` |
| 7 | 6 Workspace create in owner roots | high | do later | `workspaces:create` |
| 8 | 7 Plugin management | critical | do not | — |
| 9 | 9 Embedded Tailscale | critical | do not | — |

Uncertain: no runtime measurement; scope names are proposals, must be reconciled with contract v1 and gap note.
