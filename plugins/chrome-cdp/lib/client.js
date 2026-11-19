/**
 * Chrome CDP — client half (spec 035 R10–R14).
 *
 * Runs in the DSH app window and registers a `chrome` tab type in the right sidebar: a tab
 * picker, an address bar with back / forward / reload, and a live view of one Chrome tab.
 *
 * The view is a `<canvas>` fed by the host half, not an embedded page (R11 forbids iframe
 * embedding of external sites). The host captures one JPEG of the tab per poll
 * (`Page.captureScreenshot` — the v1 relay; a few frames per second is the accepted
 * cadence) and this half paints it. Mouse, wheel and keyboard on the canvas are forwarded
 * through the host's `/api/dsh-chrome-cdp/input` route, which sends `Input.dispatchMouseEvent` /
 * `KeyEvent` / `insertText` to the same target — so what the owner clicks in the sidebar is
 * what an agent would have clicked by element number.
 *
 * Every request carries the per-start bridge secret from the page global
 * `__DSH_CHROME_CDP__`, which the host injects for the owner's page only (R12). When the
 * injection table was cached before this plugin applied, the client asks the host's
 * owner-authenticated `/api` route once instead; without either the view stays closed.
 *
 * R14: this is a local-window surface. CDP never leaves loopback, so a window that is not
 * served from a loopback origin (a remote viewer, a tunnel) gets an explanatory notice
 * instead of a view.
 *
 * The shell fetches this file from /plugins/@dsh-ext/chrome-cdp/client.js and runs it through
 * `window.__ModuleLoader__`; no DSH client package is imported — React comes from the module
 * table, exactly as a built bundle would get it.
 */
window.__ModuleLoader__.load({
  id: '@dsh-ext/chrome-cdp',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var React = require('react')
    var h = React.createElement
    var useEffect = React.useEffect
    var useRef = React.useRef
    var useState = React.useState

    /** Tab type identity; the keyed slot seats dispatch on this id (R10). */
    var TAB_ID = '@dsh-ext/chrome-cdp'
    var TAB_KIND = 'chrome'

    // Relative to document.baseURI, like the secret fallback: the relay lives on the owner-
    // authenticated /api registry, never on a separate exact webServer mount.
    var PREFIX = 'api/dsh-chrome-cdp'
    var SECRET_HEADER = 'x-dsh-chrome-cdp-secret'
    var GLOBAL_KEY = '__DSH_CHROME_CDP__'
    var LOCALE_NS = 'chromeCdp'
    var FRAME_MS = 350
    var LIST_MS = 3000
    /** Deadline of one bridge request; a capture or a list is never worth waiting longer. */
    var REQUEST_MS = 10000
    /** Throttle for forwarded pointer movement, so a fast pointer cannot flood the host. */
    var MOVE_MS = 33

    /**
     * The copy this half renders: keyed by what it passes to `t`, carrying the English text
     * it falls back to, so the view never shows a bare key when the namespace has no entry.
     * `locale/en.json` and `locale/vi.json` carry the plugin's own copy for the app's
     * plugin surfaces (R13).
     */
    /** The copy the view renders; `en` is also the baseline registered with the locale service. */
    var COPY = {
      'type.label': 'Chrome',
      'guide.title': 'Chrome',
      'guide.description': 'Show a Chrome tab and drive it over the DevTools protocol',
      'picker.label': 'Chrome tab',
      'picker.none': 'No Chrome tab detected',
      'toolbar.back': 'Back',
      'toolbar.forward': 'Forward',
      'toolbar.reload': 'Reload',
      'toolbar.go': 'Go',
      'toolbar.address': 'Address',
      'view.remote': 'This Chrome tab is only available in the local app window: CDP stays on loopback and is never exposed to a remote viewer.',
      'view.unreachable': 'Chrome CDP is not reachable. Start Chrome with --remote-debugging-port or fix the endpoint in the plugin config.',
      'view.noSecret': 'The host did not hand this window the bridge secret, so the view stays closed.',
      'view.loading': 'Loading the tab\u2026',
      'view.failed': 'The last request failed:',
    }

    /** The Vietnamese copy the same keys resolve to in a Vietnamese window (R13). */
    var COPY_VI = {
      'type.label': 'Chrome',
      'guide.title': 'Chrome',
      'guide.description': 'Xem một tab Chrome và điều khiển nó qua giao thức DevTools',
      'picker.label': 'Tab Chrome',
      'picker.none': 'Không thấy tab Chrome nào',
      'toolbar.back': 'Quay lại',
      'toolbar.forward': 'Tiến tới',
      'toolbar.reload': 'Tải lại',
      'toolbar.go': 'Mở',
      'toolbar.address': 'Địa chỉ',
      'view.remote': 'Tab Chrome này chỉ có trong cửa sổ ứng dụng cục bộ: CDP chỉ chạy trên loopback và không bao giờ mở cho người xem từ xa.',
      'view.unreachable': 'Không kết nối được Chrome CDP. Hãy chạy Chrome với --remote-debugging-port hoặc sửa endpoint trong cấu hình plugin.',
      'view.noSecret': 'Máy chủ chưa cấp khoá cầu nối cho cửa sổ này, nên khung xem đóng lại.',
      'view.loading': 'Đang tải tab\u2026',
      'view.failed': 'Yêu cầu vừa rồi thất bại:',
    }

    /**
     * Translate one key through the slot's `t`, falling back to this half's English.
     * @param t - the slot's translate function, or undefined.
     * @param key - key from COPY.
     */
    function copy (t, key) {
      if (typeof t === 'function') {
        try {
          var value = t(key)
          if (typeof value === 'string' && value !== '' && value !== key) return value
        } catch (error) {
          // A namespace the locale service does not know: the English text below stands.
        }
      }
      return COPY[key] === undefined ? key : COPY[key]
    }

    // --- bridge ---------------------------------------------------------------------

    /** The per-start secret the host injected into this page, or null (R12). */
    function bridgeSecret () {
      try {
        var injected = globalThis[GLOBAL_KEY]
        return injected && typeof injected.secret === 'string' && injected.secret.length > 0 ? injected.secret : null
      } catch (error) {
        return null
      }
    }

    /**
     * The fallback's one result and one attempt (R12). DSH Desktop caches its injection table
     * at Host ready, so a plugin applied later has no global in an already-open window. The
     * owner-authenticated route is asked once per window, in memory only: neither a success
     * nor a failure is retried on every bridge post, and the secret is never made global.
     */
    var fetchedSecret = null
    var secretRequest = null
    var SECRET_MS = REQUEST_MS

    function cachedSecret () {
      var injected = bridgeSecret()
      return injected !== null ? injected : fetchedSecret
    }

    function fetchBridgeSecret () {
      if (secretRequest !== null) return secretRequest
      var controller = typeof AbortController === 'function' ? new AbortController() : null
      var timer = controller === null ? undefined : setTimeout(function () { controller.abort() }, SECRET_MS)
      secretRequest = (async function () {
        try {
          var response = await fetch(new URL('api/dsh-chrome-cdp/bridge-secret', document.baseURI).href, {
            credentials: 'same-origin', cache: 'no-store',
            signal: controller === null ? undefined : controller.signal,
          })
          if (!response.ok) return null
          var answer = await response.json()
          if (!answer || typeof answer.secret !== 'string' || answer.secret.length === 0 || typeof answer.dsh !== 'string') return null
          fetchedSecret = answer.secret
          return fetchedSecret
        } catch (error) {
          return null
        } finally {
          if (timer !== undefined) clearTimeout(timer)
        }
      })()
      return secretRequest
    }

    /** The injected global is primary; the owner route is the fallback, never a right for a remote window (R14). */
    async function resolveBridgeSecret () {
      var injected = bridgeSecret()
      if (injected !== null) return injected
      if (fetchedSecret !== null) return fetchedSecret
      if (!isLocalWindow()) return null
      return fetchBridgeSecret()
    }

    /**
     * Ask the host half for one thing; a refusal is an Error carrying the host's sentence.
     * Every request has a deadline, so a host that never answers cannot leave a frame or the
     * tab list waiting on a promise that never settles.
     * @param {string} path - the route name under the bridge prefix.
     * @param {object} [body] - the JSON body.
     * @param {number} [timeoutMs] - the deadline; defaults to `REQUEST_MS`.
     */
    async function post (path, body, timeoutMs) {
      var secret = await resolveBridgeSecret()
      if (secret === null) throw new Error('no-bridge-secret')
      var headers = { 'content-type': 'application/json' }
      headers[SECRET_HEADER] = secret
      var controller = typeof AbortController === 'function' ? new AbortController() : null
      var timer = controller === null ? undefined : setTimeout(function () { controller.abort() }, timeoutMs || REQUEST_MS)
      try {
        var response = await fetch(new URL(PREFIX + '/' + path, document.baseURI).href, {
          method: 'POST', headers: headers, body: JSON.stringify(body || {}), cache: 'no-store',
          signal: controller === null ? undefined : controller.signal,
        })
        if (!response.ok) throw new Error('bridge ' + path + ': HTTP ' + response.status)
        var answer = await response.json()
        if (!answer || answer.ok !== true) throw new Error((answer && answer.error) || 'the host half refused the request')
        return answer.value
      } catch (error) {
        if (error && error.name === 'AbortError') throw new Error('bridge ' + path + ': no answer within ' + String(timeoutMs || REQUEST_MS) + ' ms')
        throw error
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    }

    /**
     * R14: CDP is a loopback surface, so the view only exists where the window itself is
     * loopback. A remote viewer or a tunnel gets the notice instead.
     */
    function isLocalWindow () {
      try {
        var at = globalThis.location
        if (!at) return true
        if (at.protocol !== 'http:' && at.protocol !== 'https:') return true
        var host = String(at.hostname || '').toLowerCase()
        return host === '127.0.0.1' || host === '::1' || host === 'localhost'
      } catch (error) {
        return false
      }
    }

    // --- styles ---------------------------------------------------------------------    // Shared token families only (`--dsw-alias-*`), so the tab follows the app theme (R13).
    // One stylesheet per window, owned by this registration.

    var STYLE_ID = 'dsh-ext-chrome-cdp-style'
    var CSS = [
      '.dcp-root{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:12px}',
      '.dcp-bar{display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l2)}',
      '.dcp-bar button{background:var(--dsw-alias-bg-layer-1);color:inherit;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:2px 7px;cursor:pointer;font:inherit}',
      '.dcp-bar button:disabled{opacity:.45;cursor:default}',
      '.dcp-addr{flex:1;min-width:0;background:var(--dsw-alias-bg-layer-1);color:inherit;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:3px 8px;font:inherit}',
      '.dcp-picker{max-width:38%;background:var(--dsw-alias-bg-layer-1);color:inherit;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:3px 4px;font:inherit}',
      '.dcp-view{flex:1;min-height:0;overflow:auto;display:flex;justify-content:center;align-items:flex-start;padding:6px}',
      '.dcp-canvas{max-width:100%;height:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;cursor:default;background:var(--dsw-alias-bg-layer-1)}',
      '.dcp-notice{margin:14px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);line-height:1.45}',
      '.dcp-error{margin:0 8px 6px;color:var(--dsw-alias-label-secondary)}',
    ].join('\n')

    /** Install the stylesheet once for this registration; returns its disposer. */
    function installStyles () {
      var existing = document.querySelector('style[data-plugin-css="' + STYLE_ID + '"]')
      if (existing) return function () {}
      var style = document.createElement('style')
      style.setAttribute('data-plugin-css', STYLE_ID)
      style.textContent = CSS
      document.head.appendChild(style)
      return function () { style.remove() }
    }

    // --- the view -------------------------------------------------------------------

    /**
     * Paint one base64 JPEG onto the canvas, at the size the capture actually has.
     * `createImageBitmap` is the path every DSH web carrier has; a carrier without it gets
     * the direct data-URL image path.
     */
    function paint (element, data) {
      var source = 'data:image/jpeg;base64,' + data
      var draw = function (image, width, height) {
        element.width = width
        element.height = height
        element.getContext('2d').drawImage(image, 0, 0)
      }
      if (typeof createImageBitmap === 'function' && typeof Blob === 'function') {
        var binary = atob(data)
        var bytes = new Uint8Array(binary.length)
        for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
        return createImageBitmap(new Blob([bytes], { type: 'image/jpeg' })).then(function (bitmap) {
          draw(bitmap, bitmap.width, bitmap.height)
          bitmap.close()
        })
      }
      return new Promise(function (resolve) {
        var image = new Image()
        image.onload = function () {
          draw(image, image.naturalWidth || element.width, image.naturalHeight || element.height)
          resolve()
        }
        image.onerror = function () { resolve() }
        image.src = source
      })
    }

    /**
     * The forwarding state of one mounted view, kept for the whole life of that instance.
     *
     * It lives in a `useRef` on purpose: a component re-render (a new tab list, a new frame, a
     * new error line) must not replace the queue, or a press accepted before the render would
     * be followed by a release from a different queue. It is one object per mounted view, so
     * two sidebar tabs never share a queue either.
     *
     * Every request is appended to `chain`, settled in order, and a request only starts after
     * every earlier one was accepted or refused. A cancel is enqueued like any other request —
     * never sent beside the chain — so it can never overtake a press that was already accepted.
     * Pointer movement is coalesced per target into one slot: at most one move in flight, a
     * newer position replaces the waiting one, and `MOVE_MS` bounds how often a move starts.
     *
     * `send` reaches the network through `post`, which is replaced by `attach` so a test can
     * supply its own bridge. `clear` drops a target's waiting move and timer, `reset` drops the
     * chain of a tab the view left (after its cancel was enqueued), and `cancel` is what a
     * leave or an unmount calls.
     */
    function createForwarder () {
      var forwarder = {
        chain: Promise.resolve(),
        pending: new Map(),
        timers: new Map(),
        modifiers: 0,
        current: null,
        transport: null,
      }

      /** The one request function this forwarder uses; a test may replace it. */
      forwarder.request = function (op, data, target) {
        return forwarder.transport(op, data, target)
      }

      /** Give the forwarder the network it forwards through. */
      forwarder.attach = function (transport) {
        forwarder.transport = transport
      }

      /** One request after every earlier one settled; a refusal never breaks the chain. */
      forwarder.send = function (op, data, target) {
        var id = target || forwarder.current
        forwarder.chain = forwarder.chain.then(function () { return forwarder.request(op, data, id) }).catch(function () {})
        return forwarder.chain
      }

      /** The selected tab: a change releases the old one and abandons its queue. */
      forwarder.select = function (target) {
        if (forwarder.current === target) return
        var previous = forwarder.current
        forwarder.current = target
        if (previous === null || previous === undefined) return
        forwarder.cancel(previous)
        forwarder.reset()
      }

      /** A pointer move, coalesced: one in flight, the newest position in the slot. */
      forwarder.move = function (data, target) {
        var id = target || forwarder.current
        if (!id) return
        forwarder.pending.set(id, data)
        if (forwarder.timers.has(id)) return
        forwarder.timers.set(id, setTimeout(function () {
          forwarder.timers.delete(id)
          var next = forwarder.pending.get(id)
          forwarder.pending.delete(id)
          if (next) forwarder.send('mouse', next, id)
        }, MOVE_MS))
      }

      /** Release what the view holds; queued behind every accepted gesture, never beside it. */
      forwarder.cancel = function (target) {
        var id = target || forwarder.current
        if (!id) return forwarder.chain
        forwarder.clear(id)
        return forwarder.send('cancel', { x: 0, y: 0 }, id)
      }

      /** The newest pointer position waiting in the slot for one target, or null. */
      forwarder.waiting = function (target) {
        return forwarder.pending.get(target || forwarder.current) ?? null
      }

      /** Drop one target's waiting move and its timer. */
      forwarder.clear = function (target) {
        var id = target || forwarder.current
        if (forwarder.timers.has(id)) { clearTimeout(forwarder.timers.get(id)); forwarder.timers.delete(id) }
        forwarder.pending.delete(id)
      }

      /** Abandon the chain of a tab the view left (its cancel was enqueued for it first). */
      forwarder.reset = function () {
        forwarder.chain = Promise.resolve()
      }
      return forwarder
    }

    /**
     * The Chrome tab body. Props come from the tab seat: `useTabInfo()` carries the live tab
     * record and `t` the `chromeCdp` copy (R13).
     * @param props - slot props.
     */
    function ChromeBody (props) {
      var t = props.t
      var info = props.useTabInfo ? props.useTabInfo() : undefined
      var tabId = info && info.tab ? info.tab.id : undefined

      var canvas = useRef(null)
      // The view's forwarding state outlives every render (finding 1: a queue rebuilt by a
      // re-render would split an accepted gesture).
      var heldRef = useRef(null)
      if (heldRef.current === null) heldRef.current = createForwarder()
      var forwarder = heldRef.current
      var [tabs, setTabs] = useState([])
      var [targetId, setTargetId] = useState(null)
      var [address, setAddress] = useState('')
      var [error, setError] = useState(null)

      var local = isLocalWindow()
      var [secret, setSecret] = useState(cachedSecret())

      // The injected global is primary; only a missing one asks the owner route, once. A
      // failed attempt leaves the secret null, so the notice below keeps the view closed.
      useEffect(function () {
        if (!local || secret !== null) return function () {}
        var stopped = false
        resolveBridgeSecret().then(function (value) {
          if (!stopped && value !== null) setSecret(value)
        }).catch(function () {})
        return function () { stopped = true }
      }, [local, secret])

      // The tab list: on mount, then every few seconds while the view is visible.
      useEffect(function () {
        if (!local || secret === null) return function () {}
        var stopped = false
        function list () {
          if (document.visibilityState === 'hidden') return
          post('tabs', {}).then(function (value) {
            if (stopped) return
            var next = Array.isArray(value && value.tabs) ? value.tabs : []
            setTabs(next)
            setTargetId(function (current) {
              if (current && next.some(function (tab) { return tab.id === current })) return current
              return next.length > 0 ? next[0].id : null
            })
            setError(null)
          }).catch(function (failure) {
            if (!stopped) setError(String(failure && failure.message ? failure.message : failure))
          })
        }
        list()
        var timer = setInterval(list, LIST_MS)
        return function () { stopped = true; clearInterval(timer) }
      }, [local, secret])

      // Frames for the selected tab, one at a time: a slow capture never queues a backlog,
      // and the next one is only scheduled after the previous settled.
      useEffect(function () {
        if (!local || secret === null || !targetId) return function () {}
        var stopped = false
        var timer
        function frame () {
          if (stopped) return
          if (document.visibilityState === 'hidden') {
            timer = setTimeout(frame, FRAME_MS)
            return
          }
          post('shot', { targetId: targetId }).then(function (value) {
            var element = canvas.current
            if (stopped || !element || !value || typeof value.data !== 'string') return
            return paint(element, value.data)
          }).then(function () {
            if (!stopped) { setError(null); timer = setTimeout(frame, FRAME_MS) }
          }).catch(function (failure) {
            if (stopped) return
            setError(String(failure && failure.message ? failure.message : failure))
            timer = setTimeout(frame, FRAME_MS * 4)
          })
        }
        frame()
        return function () { stopped = true; clearTimeout(timer) }
      }, [local, secret, targetId])

      // The selected tab's URL fills the address bar; the page can navigate itself.
      useEffect(function () {
        var selected = tabs.filter(function (tab) { return tab.id === targetId })[0]
        setAddress(selected && selected.url ? selected.url : '')
      }, [tabs, targetId])

      // Leaving the tab (or changing it) drops whatever this view still had queued for the old
      // one: its timers and its unsent work die with the tab they belonged to. The pointer is
      // released by the forwarder's own cleanup, which sees the same change.
      useEffect(function () {
        var pending = heldRef.current
        return function () { if (pending !== null) pending.clear() }
      }, [targetId])

      if (!local) {
        return h('div', { className: 'dcp-root', 'data-dsh-chrome-cdp': TAB_ID },
          h('div', { className: 'dcp-notice', role: 'note' }, copy(t, 'view.remote')))
      }
      if (secret === null) {
        return h('div', { className: 'dcp-root', 'data-dsh-chrome-cdp': TAB_ID },
          h('div', { className: 'dcp-notice', role: 'note' }, copy(t, 'view.noSecret')))
      }

      /**
       * One forwarded input event; a refusal becomes the error line. The request belongs to
       * the tab it was made for, so a target change cannot redirect work that was already
       * accepted.
       */
      function raw (op, data, target) {
        if (!target) return Promise.resolve()
        return post('input', { targetId: target, op: op, data: data }, REQUEST_MS).catch(function (failure) {
          setError(String(failure && failure.message ? failure.message : failure))
        })
      }

      // The view forwards through this bridge; a component test attaches its own.
      forwarder.attach(raw)
      forwarder.select(targetId)

      /** Release the page and drop the pending work when the view goes away. */
      useEffect(function () {
        return function () { forwarder.cancel(); forwarder.clear() }
      }, [forwarder])

      /** One navigation request from the toolbar or the address bar. */
      function navigate (action, url) {
        if (!targetId) return
        post('nav', { targetId: targetId, action: action, url: url }).catch(function (failure) {
          setError(String(failure && failure.message ? failure.message : failure))
        })
      }

      /** The pointer's position in the capture's own coordinate space. */
      function pointOf (event) {
        var element = canvas.current
        if (!element || !element.width || !element.height) return null
        var rect = element.getBoundingClientRect()
        if (rect.width === 0 || rect.height === 0) return null
        return {
          x: Math.round((event.clientX - rect.left) * element.width / rect.width),
          y: Math.round((event.clientY - rect.top) * element.height / rect.height),
        }
      }

      var button = function (buttonEvent) {
        return buttonEvent === 2 ? 'right' : buttonEvent === 1 ? 'middle' : 'left'
      }

      /**
       * CDP modifier bits for the keyboard modifiers the browser reported: Alt 1, Ctrl 2,
       * Meta 4, Shift 8. A release keeps the ones still held, so a Ctrl+drag stays a drag.
       */
      var modifiersOf = function (event) {
        var bits = 0
        if (event && event.altKey) bits |= 1
        if (event && event.ctrlKey) bits |= 2
        if (event && event.metaKey) bits |= 4
        if (event && event.shiftKey) bits |= 8
        return bits
      }

      return h('div', { className: 'dcp-root', 'data-dsh-chrome-cdp': TAB_ID, 'data-tab': tabId || '' },
        h('div', { className: 'dcp-bar' },
          h('button', { type: 'button', title: copy(t, 'toolbar.back'), 'aria-label': copy(t, 'toolbar.back'), onClick: function () { navigate('back') }, disabled: !targetId }, '\u2039'),
          h('button', { type: 'button', title: copy(t, 'toolbar.forward'), 'aria-label': copy(t, 'toolbar.forward'), onClick: function () { navigate('forward') }, disabled: !targetId }, '\u203A'),
          h('button', { type: 'button', title: copy(t, 'toolbar.reload'), 'aria-label': copy(t, 'toolbar.reload'), onClick: function () { navigate('reload') }, disabled: !targetId }, '\u21BB'),
          h('select', {
            className: 'dcp-picker',
            'aria-label': copy(t, 'picker.label'),
            value: targetId || '',
            onChange: function (event) { setTargetId(event.target.value || null) },
          },
          tabs.length === 0
            ? h('option', { value: '' }, copy(t, 'picker.none'))
            : tabs.map(function (tab) { return h('option', { key: tab.id, value: tab.id }, tab.title || tab.url || tab.id) })),
          h('input', {
            className: 'dcp-addr',
            'aria-label': copy(t, 'toolbar.address'),
            value: address,
            spellCheck: false,
            disabled: !targetId,
            onChange: function (event) { setAddress(event.target.value) },
            onKeyDown: function (event) {
              if (event.key !== 'Enter') return
              event.preventDefault()
              navigate('go', event.currentTarget.value)
            },
          }),
          h('button', { type: 'button', disabled: !targetId, onClick: function () { navigate('go', address) } }, copy(t, 'toolbar.go'))),
        error === null ? null : h('div', { className: 'dcp-error', role: 'status' }, copy(t, 'view.failed') + ' ' + error),
        h('div', { className: 'dcp-view' },
          h('canvas', {
            ref: canvas,
            className: 'dcp-canvas',
            tabIndex: 0,
            width: 640,
            height: 400,
            'aria-label': copy(t, 'picker.label'),
            onMouseMove: function (event) {
              var point = pointOf(event)
              if (point) {
                point.type = 'mouseMoved'
                point.buttons = Number.isInteger(event.buttons) ? event.buttons : 0
                // Modifiers a move reports are kept: a release that loses its own event still
                // carries the ones the owner was holding.
                forwarder.modifiers = modifiersOf(event)
                point.modifiers = forwarder.modifiers
                forwarder.move(point)
              }
            },
            onMouseDown: function (event) {
              var point = pointOf(event)
              if (!point) return
              event.currentTarget.focus()
              forwarder.modifiers = modifiersOf(event)
              forwarder.send('mouse', {
                type: 'mousePressed', x: point.x, y: point.y, clickCount: 1,
                button: button(event.button), buttons: Number.isInteger(event.buttons) ? event.buttons : undefined,
                modifiers: forwarder.modifiers,
              })
            },
            onMouseUp: function (event) {
              var point = pointOf(event)
              if (!point) return
              forwarder.modifiers = modifiersOf(event)
              forwarder.send('mouse', {
                type: 'mouseReleased', x: point.x, y: point.y, clickCount: 1,
                button: button(event.button), buttons: Number.isInteger(event.buttons) ? event.buttons : undefined,
                modifiers: forwarder.modifiers,
              })
            },
            onDoubleClick: function (event) {
              // The second click of a double click is already pressed and released above. The
              // press that event leaves is never pressed again (a press without a release is
              // exactly the stuck button): one more pair carries clickCount 2, which is what
              // the page reads as a double click.
              var point = pointOf(event)
              if (!point) return
              forwarder.modifiers = modifiersOf(event)
              var base = {
                x: point.x, y: point.y, button: button(event.button), clickCount: 2,
                buttons: Number.isInteger(event.buttons) ? event.buttons : undefined,
                modifiers: forwarder.modifiers,
              }
              forwarder.send('mouse', Object.assign({ type: 'mousePressed' }, base))
              forwarder.send('mouse', Object.assign({ type: 'mouseReleased' }, base, { buttons: 0 }))
            },
            onMouseLeave: function () { forwarder.cancel() },
            onWheel: function (event) {
              var point = pointOf(event)
              if (point) forwarder.send('mouse', { type: 'mouseWheel', x: point.x, y: point.y, deltaX: event.deltaX, deltaY: event.deltaY, modifiers: modifiersOf(event) })
            },
            onKeyDown: function (event) {
              // Keep the page's keys from moving focus out of the view or scrolling the app.
              event.preventDefault()
              forwarder.modifiers = modifiersOf(event)
              forwarder.send('key', { key: event.key, modifiers: forwarder.modifiers })
            },
          })),
      )
    }

    /** The tab chip: "Chrome", or the page title once one is known (the optional title seat, R10). */
    function ChromeTitle (props) {
      var t = props.t
      var info = props.useTabInfo ? props.useTabInfo() : undefined
      var navigation = info && info.tab ? info.tab.navigation : undefined
      var title = navigation && typeof navigation.title === 'string' ? navigation.title : ''
      return h('span', null, title || 'Chrome')
    }

    /** The static tab type and its guide entry (R10). */
    function definition (t) {
      return {
        id: TAB_ID,
        kind: TAB_KIND,
        multiple: true,
        priority: 'extension',
        title: function () { return copy(t, 'type.label') },
        guide: [{
          id: 'new',
          order: 40,
          title: function () { return copy(t, 'guide.title') },
          description: function () { return copy(t, 'guide.description') },
        }],
      }
    }

    var inject = ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs']

    /**
     * Client half: the tab type and the two keyed seats (body and title).
     * @param ctx - the client plugin context.
     */
    function apply (ctx) {
      var t = ctx.locale && typeof ctx.locale.bind === 'function' ? ctx.locale.bind(LOCALE_NS) : undefined

      // R13: the copy lives in this package's locale files; the two dictionaries below are the
      // same text the view renders, registered for this namespace so `t` resolves it here.
      if (ctx.locale && typeof ctx.locale.register === 'function') {
        ctx.effect(function () { return ctx.locale.register(LOCALE_NS, { en: COPY, vi: COPY_VI }) }, 'dsh-ext/chrome-cdp: copy')
      }

      ctx.effect(function () { return ctx.sidebarRightTabs.register(definition(t)) }, 'dsh-ext/chrome-cdp: tab type')

      ctx.effect(function () { return installStyles() }, 'dsh-ext/chrome-cdp: styles')

      ctx.effect(function () {
        return ctx.slots.inject('sidebar.right.pane.tab', function () {
          return ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID, locale: LOCALE_NS }, ChromeBody)
        })
      }, 'dsh-ext/chrome-cdp: body')

      ctx.effect(function () {
        return ctx.slots.inject('sidebar.right.pane.tab.title', function () {
          return ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: TAB_ID, locale: LOCALE_NS }, ChromeTitle)
        })
      }, 'dsh-ext/chrome-cdp: title')
    }

    exports.apply = apply
    exports.inject = inject
    // Test seam, like the host half's `__internals`: the pure pieces a spec can pin.
    exports.__internals = {
      isLocalWindow, bridgeSecret, cachedSecret, resolveBridgeSecret, post, copy, COPY, COPY_VI, definition, ChromeBody, ChromeTitle, createForwarder,
      TAB_ID, TAB_KIND, CSS, GLOBAL_KEY, SECRET_HEADER, PREFIX, LOCALE_NS, STYLE_ID, SECRET_MS,
    }
    return module.exports
  },
})
