// Registers the app-shell service worker. Loaded as an EXTERNAL script (not inline) so the page
// can run under a strict `script-src 'self'` CSP with no 'unsafe-inline'.
//
// Only registered on a secure origin (https / localhost) and never in a dev server: a stale shell
// worker during development is a debugging trap, not a feature.
(function registerShellWorker() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  var secure = window.isSecureContext === true;
  if (!secure) return;
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(function () {
      // Offline support is an enhancement: a failed registration must never block the app.
    });
  });
})();
