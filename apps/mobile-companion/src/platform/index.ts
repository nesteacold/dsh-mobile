// Platform adapters for the app (A020–A025). Everything here may import expo/react-native;
// `src/core` must not (enforced by `npm run check:core`).

export * from './secure-store';
export * from './install-id';
export * from './biometrics';
export * from './notifications';
export * from './pinned-transport';
export * from './random';
export * from './unlock-copy';
// Spec 021: the pairing's `web:unlock` grant (a no-op pair on native, the real store on web).
export * from './web-grant';
// Spec 020: the page origin for the same-origin gateway address (`null` on native).
export * from './web-location';
