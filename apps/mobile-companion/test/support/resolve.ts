import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

// Expo's own runtime reads the Metro global `__DEV__` at module init (expo/build/async-require/setup.js).
// Node does not define it, so a test that imports `expo` directly dies before any test body runs.
// This --import hook is loaded FIRST, before any test module or stub, so defining it here fixes the
// loader without weakening assertions or stubbing Expo itself. Tests run in a non-development bundle.
(globalThis as Record<string, unknown>).__DEV__ = false;

// Node ESM wants explicit file extensions; Metro and tsc do not. For the *test* runner only,
// resolve extensionless relative specifiers by trying `x.ts`, `x.tsx`, ..., `x/index.ts`, ...
// Loaded automatically via `--import` in the `test` script (see package.json).
const EXTS = ['.ts', '.tsx', '.mts', '.js', '.mjs', '.cjs'];
// Metro platform suffixes and the test stub suffix are NOT real file extensions: `x.web` resolves
// to `x.web.ts`, `x.stub` to `x.stub.ts`. Keeps test imports extensionless (tsc-compatible).
const PSEUDO_EXT = /\.(web|native|stub)$/;

registerHooks({
  resolve(specifier, context, nextResolve) {
    const extensionless = path.extname(specifier) === '' || PSEUDO_EXT.test(specifier);
    if ((specifier.startsWith('.') || specifier.startsWith('/')) && extensionless) {
      const parent = context.parentURL ? fileURLToPath(context.parentURL) : path.join(process.cwd(), 'x.js');
      const base = path.resolve(path.dirname(parent), specifier);
      const candidates = [
        ...EXTS.map((ext) => base + ext),
        ...EXTS.map((ext) => path.join(base, 'index' + ext)),
      ];
      for (const candidate of candidates) {
        if (existsSync(candidate)) {
          return { url: pathToFileURL(candidate).href, shortCircuit: true };
        }
      }
    }
    return nextResolve(specifier, context);
  },
});
