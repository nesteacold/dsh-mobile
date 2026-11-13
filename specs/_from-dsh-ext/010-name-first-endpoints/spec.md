# Feature 010 — Pair by name, not only by address

Status: Draft (lead, 2026-11-10). Owner request 2026-11-10: a fixed name should outlive a changing IP.
Touches: `plugins/devices` (outbound client + record schema), `plugins/mobile-gateway` (advertised
endpoints). Reuses the existing pairing payload; **no protocol version bump** (see FR-010).
Reviewer pass required: this is pairing/trust code.

## Why

Owner observation: the reference product (Qoder) connects to
`<host>.tailXXXXXX.ts.net:6306` — a stable name. Our pairing stores whatever string was paired, and
today that can only be a literal private IP, because both sides refuse any other name shape:

- gateway `lib/network-addresses.mjs:10` `isPrivateNetworkHostname()` accepts `localhost`,
  `*.local`, and literal private IPv4/IPv6 (loopback, 10/8, 100.64/10, 172.16/12, 192.168/16,
  169.254/16, fc00::/7, fe80::/10). A MagicDNS name (`*.ts.net`) is **not** private by that rule.
- devices `lib/remote-client.mjs:113` `isPrivateAddress()` is the same rule, used by
  `resolveDialUrl()` and `otpDialUrl()`, so a name is refused with 403 unless
  `allowPublicRemotes` is on.
- the gateway advertises `listenHost` (an IP) and the LAN listener URLs; a name is never offered.

Consequence: a saved remote pins an IP. When that IP changes (DHCP lease, Tailscale re-registration,
VPN reattach) the link is dead and the only cure is re-pairing on every device.

Measured (2026-11-10): the stored record is `new URL(url).host` (`plugins/devices/lib/index.mjs:652`,
`:680`); the dial calls `tls.connect({host})` and never persists the resolved address
(`remote-client.mjs`, `dialTarget`). So **nothing converts a name to an IP today** — the problem is
that a name is not allowed in the first place, and that the host never offers one.

## What

Hostname-first addressing, with the existing "nothing is exposed to the public internet by default"
rule intact:

1. **A name is acceptable only while it resolves to private addresses.** Acceptance is decided per
   dial, not once at pairing: resolve the name, and accept only if **every** returned address is a
   private address by the existing rule (plus loopback). Mixed public/private, a CNAME to a public
   address, or a resolution failure all refuse the dial. This keeps `allowPublicRemotes:false` mean
   what it says while making MagicDNS/VPN names usable.
2. **The host offers its name first.** When the gateway can determine its own stable name, it puts a
   `wss://<name>:<port>/ws/mobile` endpoint **first** in the advertised list (payload `endpoints`),
   with the LAN/Tailscale IPs after it as fallbacks. Derivation order: explicit owner setting
   (`options.endpoints`, already supported) → Tailscale MagicDNS name of the active interface →
   nothing. Never invent or guess a name.
3. **The client stores what it dialled and prefers what last worked.** The record keeps the endpoint
   list it received (`endpoints`) and a `preferredEndpoint` (the URL of the last successful dial).
   Dial order on connect/reconnect: `preferredEndpoint` → endpoints in advertised order. A successful
   dial updates `preferredEndpoint`; a refused one is remembered only for that attempt (no permanent
   blacklist beyond the supervisor's existing backoff).
4. **The UI says which address it is using.** The remote row shows the endpoint currently in use
   (name when a name is used) and, when a fallback address was used because the name failed, a muted
   note naming the fallback. No silent switching.
5. **Pairing by name also works for the OTP path.** `otpDialUrl()` applies the same resolver-based
   check, so `wss://<name>:<port>` is accepted when it resolves privately.
6. **No new trust surface.** The certificate pin stays the only trust anchor; a name that resolves
   somewhere unexpected fails the pin exactly like a wrong IP. The pin is still checked before the
   bearer token or OTP is written (unchanged ordering).

## Requirements

- **FR-001** A private-resolving DNS name is accepted as a pairing address and as a dial target;
  a name that resolves to any non-private address is refused with the existing 403 class.
- **FR-002** The check runs at dial time on the **current** resolution, not on a cached result.
- **FR-003** Resolution has a bounded timeout and never blocks the event loop; failure is a normal
  dial failure (supervisor backoff applies), not a crash or an unhandled rejection.
- **FR-004** The gateway advertises a stable name when it can determine one, first in `endpoints`.
- **FR-005** The remote record persists `endpoints` and `preferredEndpoint`; older records without them
  keep working unchanged (read-compat, written lazily on the next successful dial).
- **FR-006** Reconnection uses `preferredEndpoint` first, then advertised order, and stops at the
  first success; the whole attempt still obeys the existing backoff and the `pin-mismatch` terminal
  rule.
- **FR-007** The Devices page shows the endpoint in use and a note when a fallback was used.
- **FR-008** No name, address, token or header value is logged or committed; the endpoint shown in the
  UI is the same string the dial used.
- **FR-009** Tests: name accepted when all answers are private; refused when any answer is public;
  refused on resolution failure; name-first ordering; fallback to IP on name failure updates
  `preferredEndpoint`; `pin-mismatch` on a name stays terminal; old record shape still dials.
- **FR-010** The pairing payload keeps `version: 1`; only the existing optional `endpoints` array is
  used. A payload with no named endpoint is valid (today's behaviour).

## Out of scope

- Public exposure, tunnels, relay/ICE, mDNS discovery of hosts, service records.
- Automatic re-pairing when every endpoint is dead (the user re-pairs; the row says why).
- Rewriting an existing record's address in place (it keeps the endpoint list it was paired with).

## Open questions for implementation

- Tailscale name source: `tailscale status --json` (`Self.DNSName`, trailing dot stripped) versus the
  `TS_*` environment. Prefer the CLI when present, fall back to nothing — never guess.
- Whether `preferredEndpoint` should survive a `pin-mismatch` (proposal: yes; the pin is the failure,
  not the address, and the row already explains it).
