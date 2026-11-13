/**
 * M3 — which pages the browser tools may load or drive.
 *
 * The sidebar Browser is an Electron guest inside the DSH app window, so every URL it
 * loads is fetched from this machine's network position: loopback services, `localhost`
 * and the DSH Host's own listener are one navigation away from the model. Every
 * navigate/open target is therefore checked here, on the host side, before a command is
 * queued — and `lib/client.js` runs the same check when it picks the tab it will drive,
 * so a tab that already sits on such a URL (opened by hand) is never targeted either.
 *
 * Only absolute `http:`/`https:` URLs are allowed: `data:`, `file:` and `javascript:` are
 * not pages the tools can report on, and `file:` reads this machine.
 *
 * @module @dsh-ext/sidebar-browser/url-guard
 */

/** Ports a URL leaves implicit; `http://host` and `http://host:80` reach the same listener. */
const DEFAULT_PORTS = { 'http:': 80, 'https:': 443 }

/** Names that always mean this machine, including every `*.localhost` subdomain. */
const LOCAL_NAME = /^(?:.*\.)?localhost$/

/**
 * Eight hexadecimal groups of an IPv6 address, or null when the text is not one.
 * A URL serializes IPv6 canonically (`[::1]`), but this also accepts an embedded dotted
 * quad and the bare literal a bind address carries.
 * @param {string} text - address without brackets.
 * @returns {number[]|null}
 */
function ipv6Groups (text) {
  if (typeof text !== 'string' || !text.includes(':')) return null
  let value = text
  const dotted = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value)
  if (dotted !== null) {
    const [a, b, c, d] = dotted.slice(1).map(Number)
    if ([a, b, c, d].some((octet) => octet > 255)) return null
    value = `${value.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const halves = value.split('::')
  if (halves.length > 2) return null
  const parts = (half) => (half === '' ? [] : half.split(':'))
  const head = parts(halves[0])
  const tail = halves.length === 2 ? parts(halves[1]) : []
  // '::' stands for at least one zero group, so the halves may not fill the address alone.
  if (halves.length === 1 && head.length !== 8) return null
  if (head.length + tail.length > 8) return null
  if (halves.length === 2 && head.length + tail.length === 8) return null
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0
  const all = [...head, ...new Array(fill).fill('0'), ...tail]
  const groups = all.map((part) => (/^[0-9a-f]{1,4}$/i.test(part) ? parseInt(part, 16) : null))
  return groups.some((group) => group === null) ? null : groups
}

/**
 * Dotted quad of an IPv4 address, or null. The URL parser has already rewritten the
 * decimal, hexadecimal and octal forms (`2130706433`, `0x7f000001`) to this shape.
 * @param {string} text - host text.
 * @returns {number[]|null}
 */
function ipv4Groups (text) {
  const parts = text.split('.')
  if (parts.length !== 4) return null
  const values = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN))
  if (values.some((value) => !(value <= 255))) return null
  return values
}

/**
 * Identity of a URL host for comparison: lowercase, no IPv6 brackets, no zone id, no
 * trailing root dot, and IPv4/IPv6 in one canonical text.
 * @param {string} value - URL hostname (`[::1]`, `LOCALHOST.`, …) or a bind address.
 * @returns {{kind: 'name'|'v4'|'v6', groups: number[]|null, text: string}}
 */
function hostIdentity (value) {
  let text = String(value ?? '').trim().toLowerCase()
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1)
  // A zone id names a local interface, never the address.
  const zone = text.indexOf('%')
  if (zone !== -1) text = text.slice(0, zone)
  text = text.replace(/\.+$/, '')
  const v6 = ipv6Groups(text)
  if (v6 !== null) return { kind: 'v6', groups: v6, text: v6.map((group) => group.toString(16)).join(':') }
  const v4 = ipv4Groups(text)
  if (v4 !== null) return { kind: 'v4', groups: v4, text: v4.join('.') }
  return { kind: 'name', groups: null, text }
}

/**
 * IPv4 address carried in the low 32 bits of a mapped (`::ffff:a.b.c.d`) or translated
 * (`::ffff:0:a.b.c.d`) IPv6 address, or null for any other address.
 * @param {number[]} groups - eight IPv6 groups.
 * @returns {number[]|null}
 */
function embeddedIpv4 (groups) {
  const mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff
  const translated = groups.slice(0, 4).every((group) => group === 0) && groups[4] === 0xffff && groups[5] === 0
  if (!mapped && !translated) return null
  return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff]
}

/**
 * Why this address is this machine, or null when it is not.
 * @param {{kind: string, groups: number[]|null, text: string}} identity - from hostIdentity().
 * @returns {string|null}
 */
function localAddressReason (identity) {
  if (identity.kind === 'name') {
    return LOCAL_NAME.test(identity.text) ? 'it is localhost, which always means this machine' : null
  }
  const groups = identity.groups
  if (identity.kind === 'v4') {
    if (groups.every((octet) => octet === 0)) return 'it is the unspecified address 0.0.0.0'
    if (groups[0] === 127) return 'it is a loopback address (127.0.0.0/8)'
    return null
  }
  const embedded = embeddedIpv4(groups)
  if (embedded !== null) {
    if (embedded.every((octet) => octet === 0)) return 'it is an IPv4-mapped unspecified address'
    if (embedded[0] === 127) return 'it is an IPv4-mapped loopback address'
    return null
  }
  if (groups[7] === 1 && groups.slice(0, 7).every((group) => group === 0)) return 'it is the loopback address ::1'
  if (groups.every((group) => group === 0)) return 'it is the unspecified address ::'
  return null
}

/** The port the URL actually connects to; an elided default port counts. */
function effectivePort (url) {
  if (url.port !== '') return Number(url.port)
  return DEFAULT_PORTS[url.protocol] ?? null
}

/**
 * Why this URL must not be loaded or driven, or null when it is allowed.
 * @param {string} rawUrl - absolute URL the tools would load.
 * @param {null|{host: string, port?: number|null}} [ownServer] - this DSH Host's own
 *   listener (`webServer.host` / `webServer.port`); a null port means it is not bound
 *   yet, so its host is refused on every port.
 * @returns {string|null}
 */
export function pageUrlProblem (rawUrl, ownServer = null) {
  let url
  try {
    url = new URL(String(rawUrl))
  } catch {
    return `"${String(rawUrl)}" is not an absolute URL`
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return `only http and https pages can be driven, and this URL uses the "${url.protocol.replace(/:$/, '')}" scheme`
  }
  const identity = hostIdentity(url.hostname)
  const local = localAddressReason(identity)
  if (local !== null) {
    return `the sidebar browser will not load ${url.href}: ${local}, so the model would reach a service on this machine. `
      + 'Loopback, localhost, 0.0.0.0 and the DSH Host itself are refused; use a public address instead.'
  }
  if (ownServer !== null && ownServer !== undefined) {
    const own = hostIdentity(ownServer.host)
    if (own.text === identity.text) {
      const ownPort = Number.isInteger(ownServer.port) ? ownServer.port : null
      if (ownPort === null || ownPort === effectivePort(url)) {
        return `the sidebar browser will not load ${url.href}: it is the DSH Host's own listener`
          + `${ownPort === null ? '' : ` (${String(ownServer.host)}:${ownPort})`}, and a page there could act with this window's session. `
          + 'Open the DSH UI yourself; the tools only drive other sites.'
      }
    }
  }
  return null
}
