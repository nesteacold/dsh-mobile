# Spec 042: Runtime Performance & Resource Hardening (`devices` & `mobile-gateway`)

## Packages Touched
- `@dsh-ext/devices` (`plugins/devices/`)
- `@dsh-ext/mobile-gateway` (`plugins/mobile-gateway/`)
- Wire contract (`@dsh-ext/mobile-protocol`): **no wire changes** (v1 protocol unchanged).

## Motivation & Measured Evidence
Live telemetry on DSH Desktop (`0.2.2-rc.3`) with `@dsh-mobile/bundle` enabled showed:
1. **Renderer CPU & heap churn (`plugins/devices/lib/client.js`):**
   - `installHostTabPlacement` attaches `observer.observe(doc.body, { childList: true, subtree: true })` and runs `Array.from(entry.addedNodes)` / `Array.from(entry.removedNodes)` plus `clearTimeout`/`setTimeout` on **every DOM mutation anywhere in the page**, including continuous 60fps chat token streaming and tool-output rendering in the center conversation column.
   - `startPoll` runs every 4s unconditionally (even when `document.visibilityState === 'hidden'`), `hostsStore.refresh()` has no single-flight guard or fetch timeout, `hostsStore.refresh()` and `remoteUI.set()` allocate and publish new snapshot references every 4s even when nothing changed (forcing `useSyncExternalStore` consumers across the composer bar to re-render every 4s), and `installRemoteSurfaces` invokes `sync()` twice per poll (`hostsStore.subscribe(sync)` + `.then(sync)`).
   - `installRemoteFileAttach` registers `doc.addEventListener(chunk.PICK_EVENT ?? 'change', ...)` but removes hardcoded `'change'` on dispose.
2. **Host event-loop & disk churn (`plugins/devices/lib/session-cache.mjs` & `plugins/mobile-gateway/`):**
   - `session-cache.mjs` calls `fs.existsSync(file)` synchronously on every `append()` even when `sizes.get(key) > 0` already proves the live file exists.
   - `%TEMP%\mobile-gateway.log` reached **327.8 MB** in production because `plugins/mobile-gateway/lib/logging.mjs` has no size cap/rotation, and `lib/index.mjs` logs `projection forwarded: key=...` via `redactLine` + `console.log` + `appendFileSync` on every `subagentTiming`/projection frame **even when `clients.size === 0`**.
   - `pruneToolCalls` in `plugins/mobile-gateway/lib/index.mjs` scans all sessions/entries linearly (`oldestToolCall()`) inside a `while` loop ($O(N^2)$ worst-case).
   - `WebSocketMobileTransport` (`ws-mobile-transport.mjs`) and live session event broadcasts in `mobile-gateway/lib/index.mjs` do not enforce an outbound `bufferedAmount` ceiling on slow/wedged sockets.
   - `plugins/mobile-gateway/lib/client.js` runs its 3s status `setInterval` even when `document.visibilityState === 'hidden'`.

## Requirements

### Part A — `@dsh-ext/devices` (`plugins/devices/`)

1. **Zero-allocation & subtree-filtered `MutationObserver` (`lib/client.js` `installHostTabPlacement`):**
   - Replace `Array.from(entry.addedNodes ?? [])` / `Array.from(entry.removedNodes ?? [])` and `.filter(...)` in the `MutationObserver` callback with a zero-allocation loop helper that checks whether a `MutationRecord` is foreign (not solely inserting `node`).
   - Track `sidebarRoot` when `placed === true`: compute the lowest common ancestor of `header` (`doc.querySelector(HOST_TABS_HEADER)`) and `listArea` (`doc.querySelector('[data-sidebar-list-area]')`, falling back to `header.parentNode` when `listArea` is absent), provided that ancestor is neither `doc.body` nor `doc.documentElement`.
   - In the `MutationObserver` callback, while `placed && sidebarRoot && sidebarRoot.isConnected !== false && node.parentNode !== null && typeof sidebarRoot.contains === 'function'`, skip any record whose `entry.target` has `typeof entry.target.contains === 'function'` and is disjoint from `sidebarRoot` (`!sidebarRoot.contains(entry.target) && !entry.target.contains(sidebarRoot)`).
   - Lightweight/fake DOM test doubles without `.contains` continue through the existing path unchanged. All A1.3 invariants (`client-host-tabs.test.mjs`) must remain intact.

2. **Single-flight, timeout-bounded, deduplicated polling & stores (`lib/client.js`):**
   - **`request()` timeout:** When `AbortSignal?.timeout` is available and `options?.signal` is not already supplied by the caller, pass `signal: AbortSignal.timeout(15000)` to `fetch(...)` so a wedged endpoint cannot leak pending fetches forever.
   - **`createHostsStore.refresh()` single-flight & snapshot deduplication:**
     - Coalesce concurrent `refresh()` calls by returning the active in-flight promise until it settles.
     - Only call `publish(next)` (updating `snapshot` and notifying `listeners`) when `snapshot.loaded === false` OR the serialized value of `next` differs from the current `snapshot` (so unchanged 4s polls keep `Object.is(prev, next) === true` and cause zero React re-renders).
   - **`remoteUI.set(patch)` deduplication:**
     - If every own key `k` of `patch` satisfies `Object.is(snapshot[k], patch[k])`, return immediately without allocating `{ ...snapshot, ...patch }` or notifying listeners.
   - **Eliminate double `sync()` in `installRemoteSurfaces`:**
     - `hostsStore.subscribe(sync)` already triggers `sync()` whenever `hostsStore` publishes a state change; change `const refresh = () => { hostsStore.refresh().then(() => {}, () => {}) }` so `sync()` is not called a second time on every poll.
   - **Visibility gating in `startPoll(refresh)`:**
     - Preserve the single `window.setInterval(..., 4000)` / `window.clearInterval(...)` timer contract (tested by `test/client.test.mjs`).
     - Inside the interval tick, skip calling `refresh()` when `typeof document !== 'undefined' && document?.visibilityState === 'hidden'`.
     - When `document?.addEventListener` is a function, listen for `'visibilitychange'` to invoke `refresh()` when `document.visibilityState === 'visible'`, and remove that listener in the disposer returned by `startPoll`.
   - **Symmetric listener removal (`installRemoteFileAttach`):**
     - Capture `const pickEvent = chunk.PICK_EVENT ?? 'change'` when calling `doc.addEventListener(pickEvent, listener, true)` and pass that same `pickEvent` to `doc.removeEventListener(pickEvent, listener, true)` on dispose.

3. **Eliminate redundant `existsSync` in `lib/session-cache.mjs`:**
   - Keep `append()` synchronous (required by `test/session-cache.test.mjs`).
   - Check `let size = sizeOf(key, hostId, sessionId)` first; if `size > 0` and rotation does not happen (`size + bytes <= limit`), `existed` is already known to be `true` without calling `fs.existsSync(file)`. Only check `fs.existsSync(file)` when `size === 0` (initial file or right after rotation).

### Part B — `@dsh-ext/mobile-gateway` (`plugins/mobile-gateway/`)

1. **Bounded log rotation in `lib/logging.mjs`:**
   - Keep synchronous `appendFileSync(LOG_FILE, ...)` semantics and exact `LOG_FILE` export / stderr error format required by `test/logging.test.mjs`.
   - Enforce `MAX_LOG_BYTES = 10 * 1024 * 1024` (overridable via `DSH_MOBILE_GATEWAY_LOG_MAX_BYTES` env var for deterministic unit testing): lazily read initial file size via `statSync(LOG_FILE)` once, track appended byte length in memory, and when `currentBytes + entryBytes > maxBytes` (with `currentBytes > 0`), rotate `LOG_FILE` to `${LOG_FILE}.1` (`renameSync` with best-effort fallback) and reset `currentBytes = 0`. Total disk usage stays bounded to ≤ 20 MB.

2. **Suppress idle projection log spam (`lib/index.mjs`):**
   - At `controlTask` (`projection forwarded: key=...`), only call `log(...)` when `clients.size > 0` (and skip logging high-frequency `subagentTiming` frames unless `clients.size > 0` and non-timing or debug). Better yet: only log `projection forwarded` when `clients.size > 0` AND `frame.key !== 'subagentTiming'` (since `subagentTiming` fires continuously during subagent execution and accounted for 43% of the 328 MB log file).

3. **$O(1)$ FIFO eviction for `toolCallArguments` (`lib/index.mjs`):**
   - Maintain a flat insertion-ordered `Map` (`toolCallOrder`: `${sessionId}\0${callId}` -> `{ sessionId, callId, entry }`) alongside `toolCallArguments` so `oldestToolCall()` returns `toolCallOrder.values().next().value ?? null` in $O(1)$ instead of scanning nested Maps in $O(N)$. Keep `forgetToolCall`, `pruneToolCalls`, and `rememberToolCall` strictly in sync with `toolCallOrder`.

4. **WebSocket outbound backpressure guard (`lib/ws-mobile-transport.mjs` & `lib/index.mjs`):**
   - Expose `get bufferedAmount()` on `WebSocketMobileTransport` (`return this.socket.bufferedAmount ?? 0`).
   - Enforce a hard ceiling `MAX_WS_BUFFERED_BYTES = 16 * 1024 * 1024` in `WebSocketMobileTransport.send(wire)` (configurable via constructor option `maxBufferedBytes` for unit testing): if `this.readyState === 1` and `(this.socket.bufferedAmount ?? 0) > this.maxBufferedBytes`, close/terminate the slow socket (`try { this.socket.close(1009, 'outbound buffer exceeded') } catch {}` + `this.socket.terminate?.()`) instead of queueing unbounded memory in Node's heap.

5. **Visibility gating on client status poll (`lib/client.js:1492`):**
   - Skip the 3-second `refresh()` interval tick when `typeof document !== 'undefined' && document?.visibilityState === 'hidden'`, and refresh when `visibilitychange` transitions back to visible (with cleanup on unmount).

## Non-Goals & Constraints
- Do NOT touch DSH core, `packages/mobile-protocol`, or `apps/mobile-companion`.
- Do NOT touch or "fix" the pre-existing `plugins/mobile-gateway/test/allowlist.test.mjs` failure documented in `AGENTS.md`.
- Preserve all A1.1, A1.2, and A1.3 constitutional guarantees.
