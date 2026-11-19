// Phase 2 render: one temporary about:blank target on the ALREADY-RUNNING Chrome (127.0.0.1:40222).
//   1. captures glyph-c.svg as a WHITE glyph on transparent black, plus the spark alone for .master.py,
//   2. captures feature-graphic.svg as 1024x500                       (opaque, no alpha).
// The white-on-black capture is decoded by .build.py into a coverage mask (alpha = max(r,g,b)) and then
// tinted, which keeps the anti-aliasing exact without PIL having to understand SVG. Never attaches to,
// navigates, or closes a pre-existing tab; it closes only the target it created.
import { writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = 'http://127.0.0.1:40222/json';

const connect = (wsUrl) => new Promise((resolve, reject) => {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(String(ev.data));
    const slot = msg.id && pending.get(msg.id);
    if (!slot) return;
    pending.delete(msg.id);
    msg.error ? slot.rej(new Error(`${msg.method ?? ''} ${msg.error.message}`)) : slot.res(msg.result);
  });
  ws.addEventListener('open', () => resolve({
    send(method, params = {}, sessionId) {
      const n = ++id;
      ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
      return new Promise((res, rej) => pending.set(n, { res, rej }));
    },
    close: () => ws.close(),
  }), { once: true });
  ws.addEventListener('error', () => reject(new Error('browser websocket failed')), { once: true });
});

const version = await (await fetch(`${BASE}/version`)).json();
const before = new Set((await (await fetch(`${BASE}/list`)).json()).map((t) => t.id));
const cdp = await connect(version.webSocketDebuggerUrl);
console.log(`browser: ${version.Browser}`);

const { targetId: temp } = await cdp.send('Target.createTarget', { url: 'about:blank' });
try {
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: temp, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 1024, deviceScaleFactor: 1, mobile: false }, sessionId);
  await cdp.send('Page.navigate', { url: 'data:text/html,<!doctype%20html><title>dsh-final</title>' }, sessionId);

  // Same drawing path that produced the concept PNGs: the SVG is injected as a fragment span.innerHTML
  // parses without "sanitising" (it does not handle SVG) and a fixed-size host frames it.
  async function paint(svg, width, height) {
    const out = await cdp.send('Runtime.evaluate', {
      returnByValue: true,
      expression: `(() => {
        document.body.innerHTML = '';
        document.body.style.margin = '0';
        const host = document.createElement('div');
        host.style.cssText = ${JSON.stringify(`position:fixed;left:0;top:0;width:${width}px;height:${height}px;overflow:hidden`)};
        document.body.appendChild(host);
        host.innerHTML = ${JSON.stringify(svg)};
        const s = host.querySelector('svg');
        if (!s) return [0, 0, 0];
        s.setAttribute('width', String(${width}));
        s.setAttribute('height', String(${height}));
        s.style.display = 'block';
        const r = s.getBoundingClientRect();
        return [1, r.width, r.height];
      })()`,
    }, sessionId);
    const [ok, w, h] = out.result.value ?? [];
    if (!ok || w !== width || h !== height) throw new Error(`painted ${w}x${h}, expected ${width}x${height}`);
  }

  async function capture(name) {
    const bytes = Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true }, sessionId)).data, 'base64');
    writeFileSync(join(HERE, name), bytes);
    console.log(`${name} ${bytes.length} B`);
    return bytes;
  }

  // 1. White glyph on transparent black: #fff stays #fff, transparency stays black at 0 alpha.
  await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } }, sessionId);
  await paint(readFileSync(join(HERE, 'glyph-c.svg'), 'utf8'), 1024, 1024);
  await capture('glyph-c-1024.png');
  await cdp.send('Emulation.setDefaultBackgroundColorOverride', {}, sessionId);

  // 1b. Feature-graphic source, drawn as HTML by THIS page: a 448x448 inline <img> of concept-glyph.png on
  // the banner's navy, wordmark to its right. (A raster glyph is what keeps the star crisp; rendering the
  // same glyph as nested data-URI <img> inside a data-URI <svg> did not paint in this browser.)
  const dataUri = "data:image/png;base64," + readFileSync(join(HERE, "concept-glyph.png")).toString("base64");
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 500, deviceScaleFactor: 2, mobile: false }, sessionId);
  const html = await cdp.send('Runtime.evaluate', {
    returnByValue: true,
    expression: `(async () => {
      document.body.innerHTML = '';
      document.body.style.cssText = 'margin:0;width:1024px;height:500px;background:#06172B;overflow:hidden;position:relative';
      const img = document.createElement('img');
      img.style.cssText = 'position:absolute;left:16px;top:26px;width:448px;height:448px';
      document.body.appendChild(img);
      img.src = ${JSON.stringify(dataUri)};
      await img.decode();
      const world = document.createElement('div');
      world.style.cssText = 'position:absolute;left:496px;top:0;height:500px;display:flex;align-items:center;' +
        "font-family:Inter,'Segoe UI',system-ui,-apple-system,'Helvetica Neue',Arial,sans-serif;" +
        'font-size:86px;font-weight:600;letter-spacing:-1px;color:#FFFFFF';
      world.textContent = ${JSON.stringify('DSH Orbit')};
      document.body.appendChild(world);
      return [img.naturalWidth, img.getBoundingClientRect().width, world.getBoundingClientRect().width];
    })()`,
    awaitPromise: true,
  }, sessionId);
  const [natural, width, textWidth] = html.result.value ?? [];
  if (natural !== 1024 || width !== 448 || textWidth > 1024 - 496 - 16) {
    throw new Error(`feature composition invalid: ${JSON.stringify(html.result.value)}`);
  }
  const hi = Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true }, sessionId)).data, 'base64');
  if (hi.readUInt32BE(16) !== 2048 || hi.readUInt32BE(20) !== 1000) throw new Error(`feature capture is ${hi.readUInt32BE(16)}x${hi.readUInt32BE(20)}`);
  writeFileSync(join(HERE, "final-feature-2x.png"), hi);
  console.log(`final-feature-2x.png ${hi.readUInt32BE(16)}x${hi.readUInt32BE(20)} ${hi.length} B (wordmark ${textWidth.toFixed(0)} px)`);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 500, deviceScaleFactor: 1, mobile: false }, sessionId);
  await paint(readFileSync(join(HERE, 'feature-graphic.svg'), 'utf8'), 1024, 500);
  const featurePng = await capture('final-feature-1024x500.png');
  if (featurePng.readUInt32BE(16) !== 1024 || featurePng.readUInt32BE(20) !== 500) throw new Error('feature graphic is not 1024x500');
} finally {
  cdp.send('Target.closeTarget', { targetId: temp }).catch(() => {});
  const gone = await new Promise((resolve) => {
    const start = Date.now();
    const tick = async () => {
      try {
        const list = await (await fetch(`${BASE}/list`)).json();
        if (!list.some((t) => t.id === temp)) return resolve(true);
      } catch { /* retry */ }
      if (Date.now() - start > 15000) return resolve(false);
      setTimeout(tick, 200);
    };
    tick();
  });
  cdp.close();
  console.log(`temp target closed: ${gone}`);
}

const after = (await (await fetch(`${BASE}/list`)).json());
const missing = [...before].filter((id) => !after.some((t) => t.id === id));
console.log(`pre-existing targets missing: ${JSON.stringify(missing)}`);
if (missing.length) process.exitCode = 1;
