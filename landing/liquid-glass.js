(() => {
  const root = document.documentElement;
  // The CSS ocean-mesh fallback is the default: file://, no-JS and no-Canvas
  // visitors see a crisp static surface before any module is loaded.
  root.dataset.renderQuality = 'static';
  const updateVisibility = () => root.toggleAttribute('data-motion-paused', document.hidden);
  document.addEventListener('visibilitychange', updateVisibility);
  updateVisibility();

  // Dynamic modules need an http(s) origin; file:// stays CSS-only.
  if (location.protocol === 'file:' || !('ResizeObserver' in window) || !('IntersectionObserver' in window)) return;
  requestAnimationFrame(() => {
    import('./liquid-refraction.js').then(module => {
      module.createGlassRefraction();
    }).catch(() => {
      // A missing module, blocked WebGL or any other failure keeps the static
      // CSS ocean mesh; never leave a half-initialised canvas behind.
      root.removeAttribute('data-refraction');
      root.dataset.renderQuality = 'static';
    });
  });
})();
