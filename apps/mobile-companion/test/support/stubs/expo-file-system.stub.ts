// Test-only stub of `expo-file-system` (spec 041 added this import to the session screen).
// The Node tests never open or read a file; only the named `File` export needs to exist.
export class File {
  constructor(_uri: string) {}
  async arrayBuffer(): Promise<ArrayBuffer> {
    return new ArrayBuffer(0);
  }
}
