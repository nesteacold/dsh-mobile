# Operations runbook — mobile gateway + PWA behind `tailscale serve`

Scope: one Windows host that runs DSH with `@dsh-ext/mobile-gateway`, serves the companion PWA, and is
reached from a phone over a tailnet. Roadmap P0-3 (`docs/arch-notes/audit-20261113-roadmap.md`).

Rule: deployment state (serve mounts, the logon task, the gateway listen target, profile links) is
changed **only** through `tools/ops/`, and this file is updated in the same change.

Placeholders used below — never write the real values into a file that is committed:

| Placeholder | Meaning |
|---|---|
| `<machine>.<tailnet>.ts.net` | this host's tailnet DNS name (`tailscale status --json`, `Self.DNSName`) |
| `HttpsPort` | the tailnet HTTPS port this deployment owns (default `30443`) |
| `PwaPort` | loopback port of the PWA static server (default `18480`) |
| `GatewayPort` | loopback port of the gateway's TLS listener (default `30081`) |

## 1. What runs where

```
phone ──https/wss──▶ tailscale serve  :HttpsPort   (tailnet only, TLS terminated by Tailscale)
                        ├─ /          ──▶ http://127.0.0.1:PwaPort           serve-web.mjs (Scheduled Task)
                        └─ /ws/mobile ──▶ https+insecure://127.0.0.1:GatewayPort/ws/mobile   gateway (inside DSH)
```

`/mgw/*` (the management API) is **not** mounted on the proxy, and the gateway refuses it when a
request arrives through one anyway.

## 2. Start order

1. **Build the PWA** (once per app change): `cd apps/mobile-companion && npm run build:web`. The deploy
   script refuses to continue without `dist/index.html` and `dist/sw.js`.
2. **Start DSH** with the profile that loads `@dsh-ext/mobile-gateway` and `@dsh-ext/devices`.
3. **Gateway listen target = Loopback.** Devices page → listen target "Loopback" (the TLS listener
   binds `127.0.0.1:GatewayPort`), then enable remote control. See section 6 for why this is not
   optional.
4. **Run the deploy script** (section 3). It installs the PWA server task and the serve mounts.
5. **Verify** (section 4).

After a reboot the PWA server comes back by itself (logon task). `tailscale serve --bg` configuration
persists in the Tailscale daemon. Only the gateway depends on DSH being started and logged in.

## 3. The deploy script — `tools/ops/deploy.ps1`

Windows PowerShell 5.1 compatible. **Dry-run is the default.**

```powershell
# Preview — reads state, changes nothing:
.\tools\ops\deploy.ps1 -TailnetHost <machine>.<tailnet>.ts.net

# Install (idempotent: running it twice converges, it does not stack handlers):
.\tools\ops\deploy.ps1 -TailnetHost <machine>.<tailnet>.ts.net -Apply

# Undo exactly what -Apply did:
.\tools\ops\deploy.ps1 -TailnetHost <machine>.<tailnet>.ts.net -Remove
```

Parameters: `-TailnetHost` · `-HttpsPort 30443` · `-PwaPort 18480` · `-GatewayPort 30081` · `-RepoRoot`
(default: this checkout) · `-NodePath` (default: first `node` on `PATH`).

What `-Apply` changes — and nothing else:

1. A per-user Scheduled Task **`DSH PWA server`**: at logon of the current user, run
   `node apps\mobile-companion\scripts\serve-web.mjs --port PwaPort --host 127.0.0.1 --dir dist`;
   restart on failure (1 min, 3 times); no time limit. Limited token, no elevation, no stored password.
2. `tailscale serve` handlers on **`HttpsPort` only**:
   `/ → http://127.0.0.1:PwaPort` and `/ws/mobile → https+insecure://127.0.0.1:GatewayPort/ws/mobile`.
   It never calls `tailscale serve reset` and never passes another port, so other serve entries (any
   other `--https=` port) are unreachable from the script.

If `HttpsPort` already carries a handler this script does not own, `-Apply` refuses and tells you to
pick another port instead of overwriting it. `-Remove` likewise deletes the port's handlers only when
they are exactly the two this script installs, and otherwise leaves them and says so.

`-Remove` deletes the task and runs `tailscale serve --https=HttpsPort off`. It does not touch the
gateway, the profile, the PWA build, or the `dist/` folder.

## 4. Checks

The script performs these itself under `-Apply` (read-only requests, no credential sent):

| Check | Expected | A different answer means |
|---|---|---|
| `GET https://<machine>.<tailnet>.ts.net:HttpsPort/` | `200` | PWA task not running, or the `/` mount is wrong |
| WebSocket upgrade on `/ws/mobile`, no credential | `401` | `403` = remote control is **off** in the gateway (turn it on in the Devices page); no answer = the serve→gateway hop failed, see section 6 |
| WebSocket upgrade on `/ws/mobile`, `Origin: https://evil.invalid` | `403` | the origin fence is not active (it runs before the remote-control switch, so this is `403` either way) |
| `GET …:HttpsPort/mgw/status` | **not** `200` | the management API is reachable through the proxy — stop and fix |

The order the gateway answers in matters when reading these: foreign `Origin` → `403`, then
remote-control-off → `403` (`remote/disabled`), then no/invalid credential → `401`. A `401` therefore
proves the gateway is up, the owner switch is on, and only the credential was refused — which is the
whole point of the check.

Manual spot checks:

```powershell
Get-NetTCPConnection -State Listen -LocalPort 30081 | Select LocalAddress,LocalPort   # 127.0.0.1 only
Get-NetTCPConnection -State Listen -LocalPort 18480 | Select LocalAddress,LocalPort   # 127.0.0.1 only
tailscale serve status                                                               # the two handlers on HttpsPort
Get-ScheduledTask -TaskName 'DSH PWA server' | Get-ScheduledTaskInfo                 # LastTaskResult 0
```

Repository gates (run before a push; CI runs them on every push — `.github/workflows/ci.yml`):

```powershell
node tools/verify-publish.mjs
node tools/scan-pii.mjs --all --quiet
node --test tools/scan-pii.test.mjs tools/ops/check-profile.test.mjs
```

## 5. Profile drift — `tools/ops/check-profile.mjs`

A DSH profile does not install plugins from a registry; it **links** to checkouts
(`"@dsh-ext/mobile-gateway": "link:<absolute path>"`). Three files must agree, and nothing else
keeps them agreeing:

1. `package.json` — the `link:` the owner asked for;
2. `pnpm-lock.yaml` — the target pnpm recorded at install time;
3. `node_modules/<name>` — the symlink/junction the loader actually follows.

After a checkout is moved, renamed or re-cloned, one of them can keep the old path. The symptom is
"the plugin is not in Settings" with no error. Check:

```powershell
node tools/ops/check-profile.mjs --profile <name>     # default profile root: %USERPROFILE%\.dsh\profiles
```

It prints one row per `link:` dependency (declared / locked / linked / status) and exits `0` (agree),
`1` (drift) or `2` (could not inspect: no lockfile, unreadable lockfile, several profiles and none
named). Exit `2` is "unknown", not "fine". It is **read-only**: it never installs, never rewrites the
lockfile, never repairs. Home-directory paths are printed as `~`.

Fixing drift: edit `package.json` to the correct path if needed, then re-run the profile install
(`pnpm install` in the profile directory) so pnpm rewrites the lockfile and re-links. Never hand-edit
`pnpm-lock.yaml`. Re-run the check until it exits `0`, then restart DSH.

## 6. Why the gateway must bind loopback behind `tailscale serve`

`tailscale serve` terminates TLS and then **dials a local target from this machine**. Two things follow.

1. **The target must be loopback.** On Windows a connection from this host to this host's *own tailnet
   address* is dropped when it originates from a physical NIC source address: the packet never
   completes the loop, and `tailscale serve` reports a gateway timeout (HTTP 502). The same host dialling
   `127.0.0.1` has no such problem. So the gateway listens on `127.0.0.1:GatewayPort`, and the serve
   mount targets that address. Binding the listener to the tailnet IP "so the phone can reach it" makes
   the proxied path fail and exposes a second, unproxied door.
2. **Loopback is also the security boundary.** The gateway's management API (`/mgw/*`) trusts a
   loopback peer as the owner at the keyboard. A reverse proxy makes every forwarded request look like
   loopback, so the gateway classifies requests by their forwarding headers and authority as well and
   refuses `/mgw/*` for anything that came through a proxy. That is a second line; the first is
   that the serve table mounts `/` and `/ws/mobile` only. Do not add a `/mgw` mount.

The TLS listener keeps its own certificate (the serve target is `https+insecure://…`, the *proxy* does
not validate it because the hop never leaves the machine); the phone pins the gateway certificate
fingerprint at pairing, independent of the tailnet certificate.

## 7. Rollback

| Situation | Action |
|---|---|
| Undo this deployment | `.\tools\ops\deploy.ps1 -TailnetHost <…> -Remove` |
| Take the phone surface offline immediately, keep the install | Devices page → turn **remote control** off (the listener stops). Or `tailscale serve --https=HttpsPort off`. |
| PWA server misbehaves | `Stop-ScheduledTask -TaskName 'DSH PWA server'`; fix; `Start-ScheduledTask …`. The gateway is unaffected. |
| Bad PWA build | Rebuild the previous revision (`npm run build:web`); the server reads `dist/` on every request, no restart needed. |
| Profile no longer loads the gateway | `node tools/ops/check-profile.mjs`, fix as in section 5. |

`tailscale serve reset` is **not** part of any rollback here: it removes every serve entry on the
machine, including ones this repo does not own.

## 8. What is deliberately not automated

- Editing the gateway's configuration (listen target, remote-control switch): done in the Devices page,
  by the owner. The script only checks and reports it.
- Building the PWA, starting DSH, or touching the profile.
- Anything on a port other than `HttpsPort`.
- Credentials: the script never reads, prints or stores a device token, pairing code or key.
