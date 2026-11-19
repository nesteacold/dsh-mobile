# 043 — Web/PWA pairing QR decode

Status: **proposed — reviewer pass required** (pairing/auth path).

Affects `apps/mobile-companion` web target only. No wire/contract change.

## Problem

Owner: “Nút Scan QR chỉ bật được Camera; khi quét vào QR thì không đọc hay nhận dạng QR để điền vào passcode.”

Measured from source (2026-11-18):

- `src/ui/pair-panel.tsx` gives `CameraView` `barcodeScannerSettings={{ barcodeTypes: ['qr'] }}`
  and `onBarcodeScanned={... => submit(scan.data)}`. The submit path already classifies an 8-digit
  code or a `/pair#a=…&c=…` link and fills the form (`submit`, `applyPairLink`).
- On native, `expo-camera` scans normally.
- On web, `expo-camera` `ExpoCamera.web.js` enables `useWebBarcodeScanner`. That scanner uses the
  browser-native `BarcodeDetector` when present; iOS Safari PWA does not expose it, so it imports
  `barcode-detector` (ZXing WASM).
- `barcode-detector` default `locateFile` fetches `zxing_reader.wasm` from
  `https://fastly.jsdelivr.net/npm/zxing-wasm@3.1.6/...`.
- PWA CSP is `default-src 'self'` / `script-src 'self'` / `connect-src 'self' wss://*.ts.net:*`.
  The CDN fetch is blocked, and `wasm-unsafe-eval` is absent. Expo Camera's web scanner catches the
  rejection with no `onError` wired from the panel, so the camera preview opens but nothing is read
  and no actionable message appears.

This is a web decoding/runtime defect, not a failure of pairing validation or Host approval.

## Goal

On a supported PWA, pointing the camera at the Host's pairing QR must decode it and run the existing
`submit()` path, which fills the passcode form. Keep native behaviour unchanged. Keep CSP narrow;
no third-party CDN at runtime.

## Design

1. **Self-host the decoder WASM**
   - Copy `node_modules/zxing-wasm/dist/reader/zxing_reader.wasm` into the app's `public/` directory
     under a version+content-stamped name, currently
     `/zxing_reader-3.1.6-5003fb4b.wasm` (SHA-256 `5003fb4b…`, measured 2026-11-18), so Expo exports
     it to the PWA origin root. A dependency upgrade that changes the binary MUST change this path.
   - Add `barcode-detector` as an explicit app dependency (already present transitively via
     `expo-camera`; no network install is needed).
   - In a web-only platform module, call `setZXingModuleOverrides({ locateFile })` **synchronously at
     module initialization**, before any `BarcodeDetector` is constructed. Use the same package entry
     instance Expo Camera uses. Map the requested WASM filename to the exact same-origin stamped path
     above. Native gets a no-op module with the same export. Do not rely on a child `useEffect` for
     this ordering.
   - Import/call this setup from `PairPanel` so it runs before `CameraView` mounts.
   - Update `public/sw.js` with an EXACT allowlist entry for that stamped WASM path (no generic
     `*.wasm` or `/pair` allowance) so it can join the precache/offline shell. When the binary/path
     changes, bump the worker cache name. The fixed stamped name keeps an old PWA from pairing its new
     JS with a stale WASM binary; network-first with cache fallback is acceptable for this asset.

2. **CSP — all emitters must match**
   - Add `'wasm-unsafe-eval'` to `script-src` in `scripts/build-web.mjs`, `scripts/serve-web.mjs`
     (dev server) and `plugins/mobile-gateway/lib/web-assets.mjs` (`ASSET_CSP` HTTP header). The
     header is authoritative in the PWA: a 2026-11-18 live capture showed the gateway still sending
     `script-src 'self'`, which overrode the meta tag and blocked WASM compile despite the app build
     being correct.
   - This permits compiling the same-origin WASM module without enabling general JS `eval`.
   - Do **not** add `jsdelivr` or any external origin to `connect-src`.

3. **Failure is visible**
   - If camera permission is granted but no QR is decoded within a bounded window (start with 12 s),
     show a short “Không đọc được mã QR; dùng ô nhập tay” / “Could not read the QR; paste the code”
     hint. Keep the manual input available. Do not clear the hint until a new scan attempt or a
     successful decode.
   - Preserve existing `scanLocked` single-submit behaviour and the existing classification of
     8-digit codes and `/pair#…` links.

4. **No contract change**
   - The decoded string still goes through `submit()` unchanged. The Host still approves pairing.
   - No new frame, scope or grant.

## Acceptance

- Behavioural tests:
  1. Web setup configures ZXing `locateFile` to the exact stamped same-origin WASM path at module
     initialization; native setup is a no-op.
  2. With native `BarcodeDetector` absent and all CDN requests blocked, the fallback decoder fetches
     the same-origin WASM path, receives real binary bytes, and decodes a QR fixture. A WASM 404 or
     compile failure produces the visible hint; manual paste still works.
  3. Decoded QR string flows into `submit()` exactly once; an 8-digit code fills the OTP form; a
     `/pair#a=…&c=…` link fills only the code (not the address). No decoded string, URL fragment or
     exception payload enters the hint, log or telemetry.
  4. Scan timeout produces the distinct visible hint and leaves manual paste usable. The timer is
     cancelled when the scanner closes/unmounts or a QR decodes; no late hint appears after success.
  5. Build output contains the stamped WASM path. All three CSP emitters (build meta, dev server,
     gateway `ASSET_CSP` header) contain `wasm-unsafe-eval` and no CDN origin. A served-header test
     asserts the gateway response CSP, not only the HTML meta. `sw.js` allowlists only that exact
     path. Test old PWA → new bundle upgrade and offline reload.
- Reviewer **APPROVE** required (pairing/auth + CSP change).
- Live PWA check: camera opens, a Host pairing QR is decoded, the passcode form is filled; manual
  paste still works.
