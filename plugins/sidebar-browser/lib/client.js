/**
 * Sidebar Browser — client half (spec 014).
 *
 * Runs in the DSH app window, next to the right sidebar. It long-polls the host half
 * for one command at a time and runs it against the sidebar Browser tab with the
 * `<webview>` element's own methods (`executeJavaScript`, `sendInputEvent`,
 * `insertText`, `loadURL`, `goBack`) and the sidebar service (`ctx.sidebarRight`).
 * That window transport is the only one: the CDP / `--remote-debugging-port` path is
 * gone (C5), so `capturePage()` is deliberately never called (on DSH Desktop
 * 0.2.0-rc.2 it crashes the window's renderer); screenshots are rendered in-page.
 *
 * C1: every request carries the per-host-start bridge secret read from the page global
 * `__DSH_SIDEBAR_BROWSER__`, which the host half injects as a startup row. Without it
 * the bridge stays closed, and the plugin says so instead of guessing.
 *
 * C7: on every poll this reports the DOM hooks it found, so the host half can refuse
 * with a visible reason when a DSH update moves them.
 *
 * M3: `pick` refuses to target a tab that sits on a local address (loopback, `localhost`,
 * or the DSH Host itself), mirroring `lib/url-guard.js` — the host half checks what it
 * sends, this half checks what it would drive.
 *
 * The shell fetches this file from /plugins/@dsh-ext/sidebar-browser/client.js and runs
 * it through `window.__ModuleLoader__`; it uses no other plugin module.
 */
window.__ModuleLoader__.load({
  id: '@dsh-ext/sidebar-browser',
  factory: () => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var PREFIX = '/dsh-sidebar-browser'
    var SECRET_HEADER = 'x-dsh-sidebar-browser-secret'
    var GLOBAL_KEY = '__DSH_SIDEBAR_BROWSER__'
    var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    var safe = (read, fallback) => { try { return read() } catch (error) { return fallback } }
    var visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 }

    /** The per-start secret the host injected into this page, or null. */
    function bridgeSecret () {
      var injected = globalThis[GLOBAL_KEY]
      return injected && typeof injected.secret === 'string' && injected.secret.length > 0 ? injected.secret : null
    }

    /**
     * The DOM hooks this plugin drives. Reported on every poll so a missing hook turns
     * into a precise refusal on the host side instead of a silent `no-guest`.
     */
    function domHooks () {
      var webview = document.querySelectorAll('webview[data-sidebar-browser-frame]')
      var iframe = document.querySelectorAll('iframe[data-sidebar-browser-frame]')
      return {
        frame: webview.length > 0 || iframe.length > 0,
        frameKind: webview.length > 0 ? 'webview' : (iframe.length > 0 ? 'iframe' : null),
        dockTab: document.querySelectorAll('[data-dockkit-tab]').length > 0,
        rightToggle: document.querySelector('[data-sidebar-right-toggle]') !== null,
      }
    }

    /** Sidebar Browser guests of this window; the shell tags them itself. */
    var guests = () => [...document.querySelectorAll('webview[data-sidebar-browser-frame], iframe[data-sidebar-browser-frame]')]
    var urlOf = (guest) => safe(() => guest.getURL(), '')
    var titleOf = (guest) => safe(() => guest.getTitle(), '')

    // --- URL guard (M3) ---------------------------------------------------------------
    // Mirrors lib/url-guard.js: the host half refuses what it sends, and this half refuses
    // what it would target, so a tab that already sits on a local address (opened by hand)
    // is never driven. Keep the two copies in step; url-guard.test.mjs runs one table of
    // URLs through both and requires the same answer.

    /** Ports a URL leaves implicit; `http://host` and `http://host:80` reach the same listener. */
    var DEFAULT_PORTS = { 'http:': 80, 'https:': 443 }

    /** Names that always mean this machine, including every `*.localhost` subdomain. */
    var LOCAL_NAME = /^(?:.*\.)?localhost$/

    /** Eight hexadecimal groups of an IPv6 address, or null when the text is not one. */
    function ipv6Groups (text) {
      if (typeof text !== 'string' || text.indexOf(':') === -1) return null
      var value = text
      var dotted = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value)
      if (dotted !== null) {
        var octets = [Number(dotted[1]), Number(dotted[2]), Number(dotted[3]), Number(dotted[4])]
        if (octets.some(function (octet) { return octet > 255 })) return null
        value = value.slice(0, dotted.index) + (((octets[0] << 8) | octets[1]).toString(16)) + ':' + (((octets[2] << 8) | octets[3]).toString(16))
      }
      var halves = value.split('::')
      if (halves.length > 2) return null
      var parts = function (half) { return half === '' ? [] : half.split(':') }
      var head = parts(halves[0])
      var tail = halves.length === 2 ? parts(halves[1]) : []
      if (halves.length === 1 && head.length !== 8) return null
      if (head.length + tail.length > 8) return null
      if (halves.length === 2 && head.length + tail.length === 8) return null
      var fill = halves.length === 2 ? 8 - head.length - tail.length : 0
      var all = head.concat(new Array(fill).fill('0'), tail)
      var groups = all.map(function (part) { return /^[0-9a-f]{1,4}$/i.test(part) ? parseInt(part, 16) : null })
      return groups.some(function (group) { return group === null }) ? null : groups
    }

    /** Dotted quad of an IPv4 address, or null; the URL parser already normalized exotic forms. */
    function ipv4Groups (text) {
      var parts = text.split('.')
      if (parts.length !== 4) return null
      var values = parts.map(function (part) { return /^\d{1,3}$/.test(part) ? Number(part) : Number.NaN })
      if (values.some(function (value) { return !(value <= 255) })) return null
      return values
    }

    /** Identity of a URL host: lowercase, no brackets, no zone, no trailing dot, canonical IP. */
    function hostIdentity (value) {
      var text = String(value || '').trim().toLowerCase()
      if (text.charAt(0) === '[' && text.charAt(text.length - 1) === ']') text = text.slice(1, -1)
      var zone = text.indexOf('%')
      if (zone !== -1) text = text.slice(0, zone)
      text = text.replace(/\.+$/, '')
      var v6 = ipv6Groups(text)
      if (v6 !== null) return { kind: 'v6', groups: v6, text: v6.map(function (group) { return group.toString(16) }).join(':') }
      var v4 = ipv4Groups(text)
      if (v4 !== null) return { kind: 'v4', groups: v4, text: v4.join('.') }
      return { kind: 'name', groups: null, text: text }
    }

    /** IPv4 address in the low 32 bits of a mapped or translated IPv6 address, or null. */
    function embeddedIpv4 (groups) {
      var mapped = groups.slice(0, 5).every(function (group) { return group === 0 }) && groups[5] === 0xffff
      var translated = groups.slice(0, 4).every(function (group) { return group === 0 }) && groups[4] === 0xffff && groups[5] === 0
      if (!mapped && !translated) return null
      return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff]
    }

    /** Why this address is this machine, or null. */
    function localAddressReason (identity) {
      if (identity.kind === 'name') return LOCAL_NAME.test(identity.text) ? 'it is localhost, which always means this machine' : null
      var groups = identity.groups
      if (identity.kind === 'v4') {
        if (groups.every(function (octet) { return octet === 0 })) return 'it is the unspecified address 0.0.0.0'
        if (groups[0] === 127) return 'it is a loopback address (127.0.0.0/8)'
        return null
      }
      var embedded = embeddedIpv4(groups)
      if (embedded !== null) {
        if (embedded.every(function (octet) { return octet === 0 })) return 'it is an IPv4-mapped unspecified address'
        if (embedded[0] === 127) return 'it is an IPv4-mapped loopback address'
        return null
      }
      if (groups[7] === 1 && groups.slice(0, 7).every(function (group) { return group === 0 })) return 'it is the loopback address ::1'
      if (groups.every(function (group) { return group === 0 })) return 'it is the unspecified address ::'
      return null
    }

    /** The port a URL actually connects to; an elided default port counts. */
    function effectivePort (url) {
      if (url.port !== '') return Number(url.port)
      return DEFAULT_PORTS[url.protocol] ?? null
    }

    /** This window's own DSH server authority, from the page it is served from. */
    function ownServerAuthority () {
      var at = safe(function () { return globalThis.location }, null)
      if (!at || (at.protocol !== 'http:' && at.protocol !== 'https:')) return null
      return { host: at.hostname, port: at.port === '' ? (DEFAULT_PORTS[at.protocol] ?? null) : Number(at.port) }
    }

    /** Why this URL must not be driven, or null when it is allowed (same rules as the host). */
    function pageUrlProblem (rawUrl, ownServer) {
      var url
      try {
        url = new URL(String(rawUrl))
      } catch (error) {
        return '"' + String(rawUrl) + '" is not an absolute URL'
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return 'only http and https pages can be driven, and this URL uses the "' + url.protocol.replace(/:$/, '') + '" scheme'
      }
      var identity = hostIdentity(url.hostname)
      var local = localAddressReason(identity)
      if (local !== null) return local
      if (ownServer) {
        var own = hostIdentity(ownServer.host)
        if (own.text === identity.text) {
          var ownPort = typeof ownServer.port === 'number' && isFinite(ownServer.port) ? ownServer.port : null
          if (ownPort === null || ownPort === effectivePort(url)) return 'it is the DSH Host\'s own listener'
        }
      }
      return null
    }

    /** Whether a guest's current URL is one the tools may drive (M3). */
    function guestUrlAllowed (rawUrl) {
      return pageUrlProblem(rawUrl, ownServerAuthority()) === null
    }

    /** The guest a command addresses: a URL/title fragment, else the visible tab. */
    function pick (want) {
      var every = guests()
      var all = every.filter((guest) => guestUrlAllowed(urlOf(guest)))
      if (all.length === 0) {
        // Say which case it is: the host half maps `no-guest` to its window message and
        // explains `no-usable-guest` itself. A tab on a local address must never look like
        // an unconnected window, and must never be targeted.
        var anyPage = every.some((guest) => /^https?:/i.test(urlOf(guest)))
        throw new Error(anyPage ? 'no-usable-guest' : 'no-guest')
      }
      if (want) {
        var needle = String(want).toLowerCase()
        var matches = (guest) => urlOf(guest).toLowerCase().includes(needle) || titleOf(guest).toLowerCase().includes(needle)
        var hit = all.find(matches)
        if (hit) return hit
        // The fragment names a refused tab: say so instead of acting on a different page.
        if (every.some(matches)) throw new Error('no-usable-guest')
      }
      return all.find(visible) ?? all[0]
    }

    /** Dock tabs as the shell draws them; hidden duplicates and the start page are skipped. */
    var dockTabs = () => [...document.querySelectorAll('[data-dockkit-tab]')]
      .filter((el) => visible(el) && !el.hasAttribute('data-dockkit-tab-quiet'))
      .map((el) => ({ id: el.getAttribute('data-dockkit-tab'), title: el.innerText.trim(), active: el.getAttribute('aria-selected') === 'true' }))

    /** `sendInputEvent` key names (Electron accelerator codes) for the keys the tools accept. */
    var KEYS = {
      Enter: 'Enter', Tab: 'Tab', Escape: 'Escape', Backspace: 'Backspace', Delete: 'Delete',
      ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
      Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', ' ': 'Space',
    }

    /**
     * Evaluate in the guest. A thrown error surfaces from `executeJavaScript` as one
     * generic message, so a failure is retried through `eval` to recover the real text;
     * a page whose CSP forbids `eval` keeps the generic one.
     */
    async function evaluate (guest, code) {
      try {
        return await guest.executeJavaScript(code)
      } catch (error) {
        var probe = '(async () => { try { await (0, eval)(' + JSON.stringify(code) + '); return null } catch (e) { return String(e && (e.stack || e.message) || e) } })()'
        var detail = await guest.executeJavaScript(probe).catch(() => null)
        // An EvalError here is the page's CSP refusing the probe, not the script's own failure.
        throw new Error(detail && !/^EvalError/.test(detail) ? detail : 'the script threw in the page; its message is not available because this page forbids eval')
      }
    }

    function operations (ctx) {
      var sidebar = () => {
        var service = ctx.get('sidebarRight')
        if (!service) throw new Error('the right sidebar service is not available in this window')
        return service
      }
      return {
        tabs: async () => guests()
          .filter((guest) => /^https?:/.test(urlOf(guest)))
          .map((guest) => ({ url: urlOf(guest), title: titleOf(guest), visible: visible(guest) })),

        eval: ({ code, tab }) => evaluate(pick(tab), code),

        navigate: async ({ url, tab }) => {
          // Resolves on load and rejects on a redirect or an aborted load; the caller
          // polls readyState, so neither outcome is awaited here.
          Promise.resolve(pick(tab).loadURL(url)).catch(() => {})
          return true
        },

        click: async ({ x, y, count, tab }) => {
          var guest = pick(tab)
          var base = { x: x, y: y, button: 'left', clickCount: count || 1 }
          await guest.sendInputEvent({ type: 'mouseMove', x: x, y: y })
          await guest.sendInputEvent({ type: 'mouseDown', ...base })
          await guest.sendInputEvent({ type: 'mouseUp', ...base })
          return true
        },

        insertText: async ({ text, tab }) => {
          await pick(tab).insertText(text)
          return true
        },

        key: async ({ key, tab }) => {
          var guest = pick(tab)
          var keyCode = KEYS[key] ?? (String(key).length === 1 ? key : undefined)
          if (keyCode === undefined) throw new Error('unsupported key: ' + key)
          await guest.sendInputEvent({ type: 'keyDown', keyCode: keyCode })
          await guest.sendInputEvent({ type: 'char', keyCode: keyCode })
          await guest.sendInputEvent({ type: 'keyUp', keyCode: keyCode })
          return true
        },

        history: async ({ action, tab }) => {
          var guest = pick(tab)
          if (action === 'reload') guest.reload()
          else if (action === 'back') { if (!guest.canGoBack()) return null; guest.goBack() }
          else if (action === 'forward') { if (!guest.canGoForward()) return null; guest.goForward() }
          else throw new Error('unsupported action: ' + action)
          await sleep(1200)
          return urlOf(guest)
        },

        open: async ({ url }) => {
          var known = new Map(guests().map((guest) => [guest, urlOf(guest)]))
          sidebar().openTab('browser', url ? { params: { url: url } } : {})
          if (!url) {
            await sleep(500)
            return { opened: null, tabs: dockTabs() }
          }
          for (var i = 0; i < 50; i++) {
            await sleep(200)
            var fresh = guests().find((guest) => /^https?:/.test(urlOf(guest)) && known.get(guest) !== urlOf(guest))
            if (fresh) return { opened: urlOf(fresh), tabs: dockTabs() }
          }
          throw new Error('the tab opened but no page appeared for ' + url + ' within 10 s')
        },

        close: async ({ tab, sidebar: collapse }) => {
          var service = sidebar()
          if (collapse) {
            if (!service.isExpanded()) return { collapsed: false }
            service.toggleExpanded()
            return { collapsed: true }
          }
          var tabs = dockTabs()
          var hit
          if (tab) {
            var needle = String(tab).toLowerCase()
            hit = tabs.find((entry) => entry.title.toLowerCase().includes(needle))
          } else {
            var active = safe(() => service.active(), undefined)
            hit = (active && tabs.find((entry) => entry.id === active.id)) || tabs.find((entry) => entry.active)
          }
          if (!hit) return { closed: null, tabs: tabs }
          service.close(hit.id)
          await sleep(400)
          return { closed: hit.title, tabs: dockTabs() }
        },
      }
    }

    /**
     * Serve commands from the host half until this plugin is unloaded.
     * @param ctx - the client plugin context.
     */
    function apply (ctx) {
      var stopped = false
      var controller
      var warned = false

      /** The page the tools would act on, for the host's origin allowlist. */
      function currentPage () {
        var all = guests().filter((guest) => /^https?:/.test(urlOf(guest)))
        var guest = all.find(visible) ?? all[0]
        return guest ? urlOf(guest) : null
      }

      async function post (path, body) {
        var secret = bridgeSecret()
        if (secret === null) {
          // C1: no secret for this page means the host half did not inject one. Staying
          // quiet would look like "the window is not connected", so say it once.
          if (!warned) {
            warned = true
            console.warn('dsh-sidebar-browser: this page has no bridge secret (' + GLOBAL_KEY + '). Is the host half loaded, and is this page the owner\'s? The bridge stays closed.')
          }
          throw new Error('no-bridge-secret')
        }
        controller = new AbortController()
        var headers = { 'content-type': 'application/json' }
        headers[SECRET_HEADER] = secret
        var response = await fetch(PREFIX + '/' + path, {
          method: 'POST',
          headers: headers,
          body: JSON.stringify(body),
          cache: 'no-store',
          signal: controller.signal,
        })
        if (!response.ok) throw new Error('bridge ' + path + ': HTTP ' + response.status)
        return response.json()
      }

      async function serve () {
        var run = operations(ctx)
        while (!stopped) {
          var command
          try {
            command = await post('poll', { hooks: domHooks(), page: currentPage() })
          } catch (error) {
            if (stopped) return
            await sleep(1500)
            continue
          }
          if (!command || command.idle || !command.id) continue
          var reply
          try {
            var operation = run[command.op]
            if (!operation) throw new Error('unknown operation: ' + command.op)
            var value = await operation(command.args || {})
            reply = { id: command.id, ok: true, value: value === undefined ? null : value }
          } catch (error) {
            reply = { id: command.id, ok: false, error: String((error && error.message) || error) }
          }
          try {
            await post('reply', reply)
          } catch (error) {
            // The value could not be serialised or the host went away; say so rather
            // than leaving the tool call to time out.
            await post('reply', { id: command.id, ok: false, error: 'could not return the result: ' + String((error && error.message) || error) }).catch(() => {})
          }
        }
      }

      ctx.effect(() => {
        serve()
        return () => {
          stopped = true
          if (controller) controller.abort()
        }
      }, 'dsh-sidebar-browser: window bridge')
    }

    exports.apply = apply
    // Test seam, like the host half's `__internals`: `pick` applies the URL guard above, and
    // url-guard.test.mjs pins that a tab on a local address is never targeted (M3).
    exports.__internals = { pick, guestUrlAllowed }
    return module.exports
  },
})
