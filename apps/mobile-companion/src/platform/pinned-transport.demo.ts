// Spec 032 — store-screenshot mode: loopback-only fake-gateway transport for the demo build.
//
// WHY THIS EXISTS: a demo fixture gateway on the Mac (`e2e/harness/gateway.mjs`) listens on
// `127.0.0.1` when it is driven by the capture script (`--bind 127.0.0.1`), and the iOS simulator
// shares the Mac's network stack. The controller in demo mode may only use the NATIVE pinned
// transport (`PinnedTransport` → `modules/pinned-ws`), whose TLS delegate compares the leaf
// certificate's SHA-256 with the pairing's `certSha256` INSIDE the handshake — before the HTTP
// upgrade and its `Authorization` / `X-DSH-Device-ID` headers are written. Mounted ONLY by the
// `unlocked-demo` gate mode, this adapter:
//
//   * accepts nothing but `wss://127.0.0.1:<port>` (spelled exactly; no `localhost`, no other
//     host, no credentials, no query, no fragment) and refuses a pairing that carries no pin,
//     both BEFORE a single byte moves;
//   * hands every accepted dial to the real `PinnedTransport`, with the pairing's own `certSha256`.
//     There is no other socket: no plain `WebSocket`, no "trust anything" fallback, and no
//     out-of-band pin file. (An earlier version compared the pairing pin with `demo-pair.txt` and
//     then dialled an UNPINNED `WebSocket`; that was not peer authentication and it is gone.)
//
// NO LOOPBACK ALLOWANCE ANY MORE (spec 032 review #2): an earlier revision passed a
// `loopbackAllowance` option so the native delegate answered non-server-trust challenges with
// "default handling" on the simulator. That option is GONE from every layer: from this factory, from
// `PinnedTransport` (`CreatePinnedTransportOptions` has no such key) and from the native modules
// (iOS compiled the branch out; Android rejected it). The demo socket therefore runs the SHIPPED
// pin-only trust path byte for byte: only a `NSURLAuthenticationMethodServerTrust` challenge whose
// leaf SHA-256 equals the pairing pin AND whose validity window covers now is accepted, and every
// other method is cancelled exactly like a normal build. If an OS/ATS policy still refuses the
// self-signed loopback leaf on a capture Mac, the honest outcome is a refused socket, never a
// relaxed handshake.
//
// WHAT IT DOES NOT DO: it never falls back to an unpinned socket, and a normal build never
// constructs it (the controller it belongs to refuses every non-demo pairing too).

import { CoreError, type Transport, type TransportConnectOptions, type TransportListener } from '../core';
import type { PinnedWsAdapter } from '../../modules/pinned-ws';
import type { PinnedTransport, CreatePinnedTransportOptions } from './pinned-transport';

/** The exact host a demo socket may name (not `localhost`, not `::1`). */
const DEMO_HOSTNAME = '127.0.0.1';

/**
 * True only for `wss://127.0.0.1:<port>` spelled exactly: no `localhost`, `::1` or any other
 * host, no credentials, no path, no query and no fragment. Refused before any I/O.
 *
 * Declared HERE (not imported from `pinned-transport.ts`) on purpose: a SUBSET import of the
 * platform transport cannot ride on the `*.web.ts` alias the app uses on web/test, so a value
 * helper imported from the native module would be `undefined` in a web bundle.
 */
export function isDemoUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === 'wss:'
    && parsed.hostname === DEMO_HOSTNAME
    && parsed.port !== ''
    && parsed.username === ''
    && parsed.password === ''
    && (parsed.pathname === '' || parsed.pathname === '/')
    && parsed.search === ''
    && parsed.hash === '';
}

/**
 * True when the URL addresses the loopback interface. Informational only: no consumer relaxes any
 * trust rule for a loopback target (see the header — the demo socket runs the shipped trust path).
 */
export function isLoopbackUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'wss:'
      && (parsed.hostname === DEMO_HOSTNAME || parsed.hostname === 'localhost' || parsed.hostname === '[::1]');
  } catch {
    return false;
  }
}

/**
 * The native transport implementation for one demo socket: a NAMESPACE import of the platform
 * module, so the `*.web.ts` sibling supplies the same members in a web/test bundle and the
 * class reference is read at CALL time (never a captured value the re-export could miss).
 */
async function nativeTransportClass(): Promise<typeof PinnedTransport> {
  const module = (await import('./pinned-transport')) as {
    PinnedTransport?: typeof PinnedTransport;
    default?: unknown;
  };
  const transport = module.PinnedTransport ?? module.default;
  if (typeof transport !== 'function') {
    throw new Error('The pinned transport is not in this build');
  }
  return transport as typeof PinnedTransport;
}

/** Options of the demo transport: the supervisor's diagnostics, plus the build's own facts. */
export interface DemoTargetOptions extends CreatePinnedTransportOptions {
  /**
   * The controller's transport factory passes its trace/listener hooks here. The native module is
   * injected ONLY by tests (`test/screenshot-mode.test.ts`); app code leaves it undefined.
   */
  module?: PinnedWsAdapter | null;
  /**
   * The compile-time iOS simulator fact, read by `app/_layout.tsx` through
   * `nativePinnedWsConstants` and handed to this factory. It is NOT a trust switch: the demo socket
   * accepts exactly what a shipped build accepts. It exists so the capture path keeps the fact
   * visible, and so a diagnostic can show which build a refused socket came from. Absent here,
   * `null` or `false` all mean "not proven a simulator" — and nothing in this transport changes
   * either way.
   */
  isSimulator?: boolean | null;
}

/** One demo dial: the native transport class for this socket, or the refusal already reported. */
type DemoDial =
  | { readonly native: Promise<typeof PinnedTransport> }
  | { readonly refusal: CoreError };

/**
 * Supervises one socket: every `connect`/`send`/`close` goes to the transport it handed out, and
 * each connect gets a fresh `PinnedTransport` (the native transport is one connection per instance).
 * Nothing reaches the wire before the URL and pin were accepted here.
 */
class DemoTransport implements Transport {
  private readonly options: DemoTargetOptions;
  private readonly listeners = new Set<TransportListener>();
  private active: { readonly transport: PinnedTransport; readonly unsubscribe: () => void } | null = null;
  private state: 'idle' | 'connecting' | 'open' | 'closed' = 'idle';
  /** Bumped by a local close, so an in-flight dial can never open a socket afterwards. */
  private generation = 0;

  constructor(options: DemoTargetOptions) {
    this.options = options;
  }

  connect(url: string, options: TransportConnectOptions): void {
    this.generation += 1;
    const generation = this.generation;
    this.dropActive();
    const dial = this.accept(url, options);
    if ('refusal' in dial) {
      this.refuse(dial.refusal);
      return;
    }
    this.state = 'connecting';
    void dial.native.then(
      (NativeTransport) => {
        if (generation !== this.generation) return;
        const transport = new NativeTransport({
          ...(this.options.module === undefined ? {} : { module: this.options.module }),
          ...(this.options.trace === undefined ? {} : { trace: this.options.trace }),
          ...(this.options.onListenerFailure === undefined ? {} : { onListenerFailure: this.options.onListenerFailure }),
        });
        const unsubscribe = transport.on((event) => {
          if (generation !== this.generation) return;
          if (event.type === 'open') this.state = 'open';
          if (event.type === 'close' || event.type === 'error') {
            // A refusal before `open` is terminal for this socket, like the native transport.
            if (event.type === 'close' || this.state !== 'open') this.state = 'closed';
          }
          this.emit(event);
        });
        this.active = { transport, unsubscribe };
        transport.connect(url, options);
      },
      (error: unknown) => {
        if (generation !== this.generation) return;
        this.refuse(new CoreError({
          code: 'client/pinned-transport-unavailable',
          message: error instanceof Error ? error.message : 'The pinned transport is not in this build',
        }));
      },
    );
  }

  send(data: string): boolean {
    const active = this.active;
    if (this.state !== 'open' || active === null) return false;
    return active.transport.send(data);
  }

  close(code?: number, reason?: string): void {
    this.generation += 1;
    const active = this.active;
    this.active = null;
    this.state = 'closed';
    active?.transport.close(code, reason);
  }

  on(listener: TransportListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * The acceptance rule, evaluated before any I/O: the exact loopback spelling first
   * (`client/insecure-url`), then the contract §3.1 pin shape (`client/pin-mismatch`) — the pin
   * VALUE is checked by the native handshake, never here.
   */
  private accept(url: string, options: TransportConnectOptions): DemoDial {
    if (!isDemoUrl(url)) {
      return {
        refusal: new CoreError({ code: 'client/insecure-url', message: 'The demo transport dials wss://127.0.0.1 only' }),
      };
    }
    const pin = String(options.certSha256 ?? '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(pin)) {
      return {
        refusal: new CoreError({ code: 'client/pin-mismatch', message: 'The pairing carries no leaf pin; nothing was sent' }),
      };
    }
    return { native: nativeTransportClass() };
  }

  private dropActive(): void {
    const active = this.active;
    this.active = null;
    if (active === null) return;
    active.unsubscribe();
    active.transport.close(1000, 'demo-superseded');
  }

  /** Report a refusal the way a failed socket would (error, then one close), asynchronously. */
  private refuse(refusal: CoreError): void {
    this.state = 'closed';
    const details = refusal.details;
    queueMicrotask(() => {
      this.emit({ type: 'error', code: refusal.code, message: refusal.message, ...(details === undefined ? {} : { details }) });
      this.emit({ type: 'close', code: 1006, reason: 'connect-failed', wasClean: false });
    });
  }

  private emit(event: Parameters<TransportListener>[0]): void {
    for (const listener of [...this.listeners]) listener(event);
  }
}

/** The demo transport factory with the same signature as `createPinnedTransport`. */
export const createDemoTransport = (options: DemoTargetOptions = {}): Transport => new DemoTransport(options);
