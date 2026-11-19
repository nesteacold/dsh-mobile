// Spec 043 — web (PWA) ZXing WASM configuration.
//
// Expo Camera's web scanner uses the browser-native `BarcodeDetector` when it exists. iOS Safari
// PWA does not expose one, so `expo-camera` dynamically imports `barcode-detector`, whose ZXing WASM
// defaults to a jsDelivr CDN URL. That fetch is blocked by our CSP and the module has no `onError`
// wired from the panel, so the camera preview opens but nothing is ever decoded.
//
// This module overrides the WASM location to the app's OWN origin (a version+hash-stamped path
// copied from node_modules into public/ at build time). The override is installed SYNCHRONOUSLY at
// module initialization — never from a useEffect — so expo-camera cannot construct a detector first.
// Both this file and its native sibling export the same names so Metro's platform resolution is seamless.

import { setZXingModuleOverrides } from 'barcode-detector';

/**
 * Same-origin, content-stamped path Expo copies from `public/` to the web export root.
 * The stamp is `<zxing-wasm version>-<first 8 SHA-256 hex of the binary>`; bumping the dependency
 * MUST change this name (and the SW allowlist/cache) so an old PWA never reuses a stale decoder.
 */
export const WEB_QR_WASM_PATH = '/zxing_reader-3.1.6-5003fb4b.wasm';

/**
 * The override object, kept pure and exported so a Node test can assert same-origin resolution
 * without loading the real WASM module.
 */
export function webQrModuleOverrides(): { locateFile: (path: string, prefix: string) => string } {
  return {
    // Emscripten passes the requested filename and its computed prefix. Only `.wasm` is remapped;
    // anything else keeps the library's own resolution (no behavioural change beyond the binary).
    locateFile: (path: string, prefix: string) =>
      path.endsWith('.wasm') ? WEB_QR_WASM_PATH : prefix + path,
  };
}

let configured = false;

/** Idempotent: re-mounts must not stack overrides or re-trigger WASM instantiation. */
export function configureWebQrDecoder(): void {
  if (configured) return;
  configured = true;
  // `setZXingModuleOverrides` is the documented pre-construction hook; expo-camera imports the same
  // `barcode-detector` module, so the shared overrides apply to the detector it lazily creates.
  setZXingModuleOverrides(webQrModuleOverrides());
}

// Install at module initialization, before any React render / useEffect and before expo-camera can
// import `barcode-detector` and construct its cached detector. The explicit PairPanel call is a
// belt-and-braces no-op after this; the guard keeps a single installation across hot reloads.
configureWebQrDecoder();
