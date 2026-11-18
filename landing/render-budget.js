// Conservative hints choose the starting tier; sustained frame cost can only
// lower quality during this visit. No GPU fingerprinting, no user controls.
// Kept dependency-free so both the browser modules and Node tooling can import it.

export const RENDER_BUDGETS = Object.freeze([
  Object.freeze({ name: 'static', fps: 0, webgl: false, sourcePixels: 160000, sourceEdge: 720, outputPixels: 0, pixelRatio: 0, particles: 0, rays: 2, waves: 3, dispersion: 0 }),
  Object.freeze({ name: 'low', fps: 12, webgl: false, sourcePixels: 220000, sourceEdge: 900, outputPixels: 0, pixelRatio: 0, particles: 16, rays: 2, waves: 3, dispersion: 0 }),
  Object.freeze({ name: 'balanced', fps: 18, webgl: true, sourcePixels: 360000, sourceEdge: 1200, outputPixels: 480000, pixelRatio: 0.85, particles: 26, rays: 3, waves: 4, dispersion: 0 }),
  Object.freeze({ name: 'full', fps: 24, webgl: true, sourcePixels: 700000, sourceEdge: 1600, outputPixels: 1100000, pixelRatio: 1, particles: 56, rays: 4, waves: 5, dispersion: 0.025 }),
]);

// Starting tier from navigator hints and viewport shape. Low RAM/CPU (<=2),
// saveData, lack of core counts, and the static-tier override force a safe tier.
export function initialBudget({ cores, memory, saveData, compact, coarse, staticOnly, forcedColors, reducedMotion, reducedTransparency, fileProtocol } = {}) {
  if (staticOnly || fileProtocol || forcedColors || reducedTransparency) return 0;
  if (saveData) return 0;
  if (reducedMotion) return 1;
  if (cores > 0 && cores <= 2 || memory > 0 && memory <= 2) return 0;
  if (cores > 0 && cores <= 4 || memory > 0 && memory <= 4) return 1;
  if (compact || coarse || !cores) return 2;
  return 3;
}

// Caps both the pixel count and the longest edge before a canvas is allocated.
export function boundedSize(width, height, { pixels, edge, ratio = 1 }) {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const scale = Math.min(ratio, edge / Math.max(w, h), Math.sqrt(pixels / (w * h)));
  return { width: Math.max(1, Math.floor(w * scale)), height: Math.max(1, Math.floor(h * scale)), scale };
}

// A sustained slow-frame monitor: ignores single long frames, needs >=24
// samples over >=1.8s, and reports at most one downgrade per window.
export function createFrameMonitor() {
  let samples = 0;
  let slow = 0;
  let elapsed = 0;
  return {
    reset() { samples = 0; slow = 0; elapsed = 0; },
    record({ cost, gap, interval }) {
      samples += 1;
      elapsed += Math.min(gap, 250);
      // Frame gaps also catch asynchronous GPU saturation without gl.finish()
      // or pixel readback; a single long frame never triggers a downgrade.
      if (cost > Math.min(12, interval * 0.2) || gap > interval * 1.6) slow += 1;
      if (samples < 24 || elapsed < 1800) return false;
      const degrade = slow / samples >= 0.35;
      this.reset();
      return degrade;
    },
  };
}
