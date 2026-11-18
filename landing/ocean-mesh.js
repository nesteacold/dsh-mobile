import { RENDER_BUDGETS, boundedSize } from './render-budget.js';

// Procedural deep-ocean backdrop: a navy gradient, soft radial caustics, a
// 42px hairline technical grid and sparse lit dots on the Spec 040 lattice.
// No external images, textures or network requests of any kind.
const GRID = 42;
const LIT = (row, col) => (row * 11 + col * 7) % 13 === 0;

export function createOceanMesh(canvas, initial = RENDER_BUDGETS[1]) {
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) return null;

  let budget = initial;
  let width = 1;
  let height = 1;
  let scale = 1;
  let closed = false;
  let ready = false;

  // Cached caustic sprite: one radial gradient, drawn at a few positions.
  const glow = document.createElement('canvas');
  glow.width = glow.height = 128;
  const glowContext = glow.getContext('2d');
  if (!glowContext) return null;
  const halo = glowContext.createRadialGradient(64, 64, 0, 64, 64, 64);
  halo.addColorStop(0, 'rgba(94,234,212,0.16)');
  halo.addColorStop(0.28, 'rgba(94,234,212,0.07)');
  halo.addColorStop(0.6, 'rgba(46,107,230,0.035)');
  halo.addColorStop(1, 'rgba(46,107,230,0)');
  glowContext.fillStyle = halo;
  glowContext.fillRect(0, 0, 128, 128);

  const refresh = (next = budget) => {
    if (closed) return;
    budget = next;
    const nextWidth = Math.max(1, window.innerWidth);
    const nextHeight = Math.max(1, window.innerHeight);
    if (width === nextWidth && height === nextHeight && ready) return;
    width = nextWidth;
    height = nextHeight;
    const size = boundedSize(width, height, {
      pixels: budget.sourcePixels,
      edge: budget.sourceEdge,
    });
    canvas.width = size.width;
    canvas.height = size.height;
    scale = size.scale;
    ready = true;
  };

  const draw = (milliseconds = 0) => {
    if (closed || !ready) return;
    const time = milliseconds / 1000;
    // Sub-pixel drift only: reduced-motion callers simply pass 0.
    const driftX = Math.sin(time * 0.045) * 5;
    const driftY = Math.cos(time * 0.035) * 4;

    context.setTransform(scale, 0, 0, scale, 0, 0);

    const base = context.createLinearGradient(0, 0, width * 0.25, height);
    base.addColorStop(0, '#06172B');
    base.addColorStop(0.55, '#051328');
    base.addColorStop(1, '#030d1c');
    context.fillStyle = base;
    context.fillRect(0, 0, width, height);

    // Soft caustics: a handful of wide, very faint radial washes.
    context.globalCompositeOperation = 'screen';
    const caustics = [
      [0.18, 0.12, 1.25],
      [0.82, 0.3, 1.05],
      [0.42, 0.78, 1.4],
      [0.94, 0.92, 0.9],
    ];
    caustics.forEach(([cx, cy, size], index) => {
      const x = width * cx + Math.sin(time * 0.05 + index * 1.7) * 14;
      const y = height * cy + Math.cos(time * 0.04 + index) * 10;
      const radius = Math.max(width, height) * 0.34 * size;
      context.drawImage(glow, x - radius, y - radius, radius * 2, radius * 2);
    });

    // Technical grid: 42px hairlines, aligned to the drift but kept subtle.
    context.globalCompositeOperation = 'source-over';
    context.lineWidth = 1;
    context.strokeStyle = 'rgba(94,154,205,0.07)';
    context.beginPath();
    const offsetX = ((driftX % GRID) + GRID) % GRID;
    const offsetY = ((driftY % GRID) + GRID) % GRID;
    for (let x = offsetX; x <= width + GRID; x += GRID) {
      context.moveTo(Math.round(x) + 0.5, 0);
      context.lineTo(Math.round(x) + 0.5, height);
    }
    for (let y = offsetY; y <= height + GRID; y += GRID) {
      context.moveTo(0, Math.round(y) + 0.5);
      context.lineTo(width, Math.round(y) + 0.5);
    }
    context.stroke();

    // Sparse lit nodes on the same 42px lattice: (row*11 + col*7) % 13 === 0.
    context.fillStyle = 'rgba(161,221,255,0.5)';
    const rows = Math.ceil(height / GRID) + 1;
    const cols = Math.ceil(width / GRID) + 1;
    const startRow = Math.floor(offsetY / GRID);
    const startCol = Math.floor(offsetX / GRID);
    for (let row = startRow; row < startRow + rows; row += 1) {
      for (let col = startCol; col < startCol + cols; col += 1) {
        if (!LIT(row, col)) continue;
        const x = col * GRID + offsetX;
        const y = row * GRID + offsetY;
        const twinkle = 0.45 + 0.3 * Math.sin(time * 0.5 + row + col);
        context.globalAlpha = twinkle;
        context.beginPath();
        context.arc(x, y, 1.35, 0, Math.PI * 2);
        context.fill();
      }
    }
    context.globalAlpha = 1;
  };

  refresh();
  draw(0);

  return {
    draw,
    refresh,
    get ready() { return ready; },
    dispose() {
      if (closed) return;
      closed = true;
      ready = false;
      glow.width = glow.height = 1;
      canvas.width = canvas.height = 1;
    },
  };
}
