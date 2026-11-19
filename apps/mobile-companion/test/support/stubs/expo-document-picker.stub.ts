// Test-only stub of `expo-document-picker` (spec 041 added this import to the session screen).
// No picker is opened in Node tests; the screen is imported for its pure helpers only.
export async function getDocumentAsync(): Promise<{ canceled: boolean; assets: unknown[] }> {
  return { canceled: true, assets: [] };
}
