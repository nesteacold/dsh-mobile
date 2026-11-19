// Spec 043 — test-only stub for the web-only `barcode-detector` package.
//
// The real package eagerly wires a ZXing WASM module (and a CDN locateFile); Node tests must never
// load it. This stub records the overrides the app's web module installs so a test can prove the
// WASM is mapped to the app's own origin before any detector is constructed.

export interface RecordedOverrides {
  locateFile?: (path: string, prefix: string) => string;
}

export const installedOverrides: RecordedOverrides[] = [];

export function setZXingModuleOverrides(overrides: RecordedOverrides): void {
  installedOverrides.push(overrides);
}

export function resetZXingOverrides(): void {
  installedOverrides.length = 0;
}
