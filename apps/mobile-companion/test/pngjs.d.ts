// Spec 043: pngjs 3.x ships no type declarations. Only the sync PNG decoder used by the
// QR fixture test is declared here; no runtime code imports it.
declare module 'pngjs' {
  export const PNG: {
    sync: {
      read(buffer: Buffer): { width: number; height: number; data: Buffer };
    };
  };
}
