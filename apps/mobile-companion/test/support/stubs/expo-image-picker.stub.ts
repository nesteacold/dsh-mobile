// Test-only stub of `expo-image-picker` (spec 053). Node tests read pair-screen source or pure
// helpers; they never open a real system Photos library. Return a deterministic cancellation so a
// future component-level test cannot accidentally start a native picker in Node.
export async function launchImageLibraryAsync(): Promise<{ canceled: boolean; assets: unknown[] }> {
  return { canceled: true, assets: [] };
}
