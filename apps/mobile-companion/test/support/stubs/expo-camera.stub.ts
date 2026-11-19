// Test-only stub of `expo-camera`.
export function CameraView(): null {
  return null;
}
export function useCameraPermissions(): [unknown, () => Promise<unknown>] {
  return [{ granted: false, canAskAgain: true }, async () => undefined];
}
// Spec 053: local QR decode from a picked image is invoked by the pair panel, never in Node tests.
export async function scanFromURLAsync(): Promise<Array<{ type: string; data: string }>> {
  return [];
}
