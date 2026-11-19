// Hermetic test fixtures: a loopback endpoint that is definitely nobody's Chrome, and the
// synthetic page text the password tests search for.

/** A discard port: nothing listens on 9, so a host that forgets an endpoint reaches no Chrome. */
export const SYNTHETIC_ENDPOINT = 'http://127.0.0.1:9'

/** The exact password value a snapshot must never read or return. */
export const SYNTHETIC_PASSWORD = 'SYNTHETIC-PASSWORD-4f6c1e-NEVER-PRINTED'

/** A fake Chrome that only answers at its own ephemeral loopback port. */
export { startFakeChrome, TINY_JPEG } from './fake-chrome.mjs'
