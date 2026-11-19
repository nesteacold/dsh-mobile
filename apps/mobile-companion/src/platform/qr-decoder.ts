// Spec 043 — native half of the QR decoder setup.
//
// expo-camera uses the platform BarcodeDetector on iOS/Android (no WASM, no CDN), so there is
// nothing to configure. This module mirrors the web sibling's exports so `PairPanel` can call the
// setup unconditionally; Metro resolves this file on native and `qr-decoder.web.ts` on web.

export const WEB_QR_WASM_PATH = '/zxing_reader-3.1.6-5003fb4b.wasm';

export function configureWebQrDecoder(): void {
  // Intentionally empty: native QR decoding is unchanged by spec 043.
}

/** Native never overrides the ZXing WASM location; kept for export parity with the web module. */
export function webQrModuleOverrides(): { locateFile: (path: string, prefix: string) => string } | null {
  return null;
}
