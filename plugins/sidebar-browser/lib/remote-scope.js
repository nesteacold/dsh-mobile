/**
 * C6 seam — is this session driven by a remote device, and is `browser:control` granted?
 *
 * Owner decision 2026-11-11 (spec 014): no hard blocks, permissions instead. A session
 * driven by a paired device may use the sidebar browser tools only when the
 * `browser:control` scope is granted; an undeterminable origin counts as remote.
 *
 * DSH 0.2.2-rc.1 exposes no signal on the tool-call path that says which client drove
 * the turn: the session header rejects any origin but `"subagent"`
 * (dsh-session/lib/index.js:1053), every human prompt enters as `source.kind: 'user'`
 * whatever client sent it, and `exec` carries an agent — not a Peer or principal.
 * So the answer is only knowable from whoever proxied the request: the gateway half.
 *
 * The contract the gateway side must satisfy (see README, "Remote sessions"):
 * register a host service under the ctx key `remoteSessionScope` with
 *
 *   describe(session) -> { driven: 'remote' | 'local', scopes?: string[] }
 *
 * returning `driven: 'local'` for a session the local owner started, `driven: 'remote'`
 * with the scopes granted to that device otherwise. Until such a service is mounted the
 * plugin fails closed: `grantedScopes` in its own Config is the local owner's explicit
 * statement that this Host's sessions are local (C6 says unknown counts as remote).
 *
 * Second reviewer pass M1: `grantedScopes` is a *local* statement only. A session the
 * gateway reports as `remote` is allowed solely by the gateway's own `scopes` — a local
 * owner grant must never widen what a paired device may do.
 *
 * @module @dsh-ext/sidebar-browser/remote-scope
 */

/** The permission a remote-driven session needs to use the browser tools. */
export const BROWSER_CONTROL_SCOPE = 'browser:control'

/** Service key the gateway half registers; absent means "no signal". */
export const REMOTE_SESSION_SERVICE = 'remoteSessionScope'

const NEEDS_SCOPE =
  'this session is driven by a remote device and the "browser:control" scope is not granted to it, so the sidebar browser tools are unavailable. '
  + 'Grant the scope on the device (plugins/devices permission UI) and retry.'

const UNKNOWN_ORIGIN =
  'the origin of this session cannot be determined, so it is treated as remote (spec 014 C6) and needs the "browser:control" scope. '
  + 'Local owner: add "browser:control" to grantedScopes in Settings -> Plugins -> @dsh-ext/sidebar-browser. '
  + 'Remote device: the gateway must grant the scope through the remoteSessionScope service (see the plugin README).'

/**
 * Decide whether the calling session may use the browser tools at all.
 * @param {object} deps - resolution inputs.
 * @param {(key: string) => unknown} [deps.get] - ctx.get, used to find the gateway service.
 * @param {object} [deps.agent] - exec.agent of the tool call (carries the session).
 * @param {string[]} [deps.grantedScopes] - Config.grantedScopes, the local owner's statement;
 *   it decides only when the origin is unknown (and is implied by a gateway `local` report).
 * @returns {{driven: 'local'|'remote'|'unknown', allowed: boolean, reason: string|null,
 *   basis: string, deviceId: string|null}} `deviceId` is the device the gateway named as
 *   this session's driver — the target the remote browser driver addresses (spec 016).
 */
export function remoteScopeOf ({ get, agent, grantedScopes = [] } = {}) {
  const granted = Array.isArray(grantedScopes) ? grantedScopes.filter((scope) => typeof scope === 'string') : []
  const localGrant = granted.includes(BROWSER_CONTROL_SCOPE)
  const service = typeof get === 'function' ? get(REMOTE_SESSION_SERVICE) : undefined
  const session = agent?.session

  if (service && typeof service.describe === 'function' && session !== undefined) {
    let described
    try {
      described = service.describe(session)
    } catch {
      // A throwing policy must not turn into permission.
      described = undefined
    }
    if (described && described.driven === 'local') {
      return { driven: 'local', allowed: true, reason: null, basis: 'remoteSessionScope.describe', deviceId: null }
    }
    if (described && described.driven === 'remote') {
      const scopes = Array.isArray(described.scopes) ? described.scopes : []
      // Only the gateway's own signal opens a remote-driven session (M1): Config.grantedScopes
      // is the local owner's statement about their unknown-origin sessions, not a device grant.
      const allowed = scopes.includes(BROWSER_CONTROL_SCOPE)
      return {
        driven: 'remote',
        allowed,
        reason: allowed ? null : NEEDS_SCOPE,
        basis: 'remoteSessionScope.describe',
        deviceId: typeof described.deviceId === 'string' && described.deviceId !== '' ? described.deviceId : null,
      }
    }
  }

  // No signal at all: spec 014 C6 says treat it as remote.
  return {
    driven: 'unknown',
    allowed: localGrant,
    reason: localGrant ? null : UNKNOWN_ORIGIN,
    basis: service ? 'remoteSessionScope.describe(unusable)' : 'no-signal',
    deviceId: null,
  }
}
