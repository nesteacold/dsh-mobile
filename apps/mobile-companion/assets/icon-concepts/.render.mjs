// Renders apps/mobile-companion/assets/icon-concepts/concept-*.svg to PNG using the ALREADY-RUNNING
// Chrome at 127.0.0.1:40222. It creates ONE temporary about:blank target, sizes it 1024x1024 at
// DPR 1, screenshots each concept inside that target, and closes that same target.
// It never attaches to, navigates, or closes a pre-existing tab: /json/list is only read to prove
// that (a) nothing else appeared and (b) the temp target is gone afterwards.
// Run:  node apps/mobile-companion/assets/icon-concepts/.render.mjs
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = 'http://127.0.0.1:40222/json';

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let nextId = 0;
    const pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
      const slot = msg.id && pending.get(msg.id);
      if (!slot) return;
      pending.delete(msg.id);
      if (msg.error) slot.rej(new Error(`${msg.method ?? ''} ${msg.error.message} ${JSON.stringify(msg.error.data ?? '')}`));
      else slot.res(msg.result);
    });
    ws.addEventListener('open', () => resolve({
      send(method, params = {}, sessionId) {
        const id = ++nextId;
        const payload = { id, method, params };
        if (sessionId) payload.sessionId = sessionId;
        ws.send(JSON.stringify(payload));
        return new Promise((res, rej) => pending.set(id, { res, rej }));
      },
      close: () => ws.close(),
    }), { once: true });
    ws.addEventListener('error', () => reject(new Error('browser websocket failed to open')), { once: true });
  });
}

const version = await (await fetch(`${BASE}/version`)).json();
const beforeIds = new Set((await (await fetch(`${BASE}/list`)).json()).map((t) => t.id));
const cdp = await connect(version.webSocketDebuggerUrl);
console.log(`browser: ${version.Browser}; pre-existing targets: ${beforeIds.size}`);

const { targetId: temp } = await cdp.send('Target.createTarget', { url: 'about:blank' });
let closed = false;
try {
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: temp, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Emulation.setDeviceMetricsOverride',
    { width: 1024, height: 1024, deviceScaleFactor: 1, mobile: false }, sessionId);
  await cdp.send('Page.navigate',
    { url: 'data:text/html,<!doctype%20html><title>dsh-icon-concepts</title><body%20style="margin:0;background:%2306172B">' },
    sessionId);
  const ready = await cdp.send('Runtime.evaluate',
    { expression: 'document.readyState', returnByValue: true }, sessionId);
  if (ready.result.value !== 'complete') throw new Error(`page not ready: ${ready.result.value}`);

  for (const name of ['concept-a', 'concept-b', 'concept-c']) {
    const svg = readFileSync(join(HERE, `${name}.svg`), 'utf8');
    const sha = createHash('sha256').update(svg).digest('hex');
    // Insert the SVG as the only child of a fixed 1024x1024 host, at exactly 1024 CSS px.
    const outcome = await cdp.send('Runtime.evaluate', {
      returnByValue: true,
      expression: `(() => {
        document.body.innerHTML = '';
        const host = document.createElement('div');
        host.id = 'dsh-icon-host';
        host.style.cssText = 'position:fixed;left:0;top:0;width:1024px;height:1024px;overflow:hidden';
        document.body.appendChild(host);
        host.innerHTML = ${JSON.stringify(svg)};
        const s = host.querySelector('svg');
        if (!s) return { ok: false, why: 'no svg element' };
        s.setAttribute('width', '1024');
        s.setAttribute('height', '1024');
        s.style.display = 'block';
        const r = s.getBoundingClientRect();
        return { ok: true, size: [r.width, r.height], children: s.children.length };
      })()`,
    }, sessionId);
    const info = outcome.result.value;
    if (!info.ok || info.size[0] !== 1024 || info.size[1] !== 1024) throw new Error(`${name}: ${JSON.stringify(info)}`);

    const shot = await cdp.send('Page.captureScreenshot',
      { format: 'png', fromSurface: true, captureBeyondViewport: false }, sessionId);
    const bytes = Buffer.from(shot.data, 'base64');
    // PNG IHDR is always at byte 16: big-endian width then height.
    const w = bytes.readUInt32BE(16);
    const h = bytes.readUInt32BE(20);
    if (w !== 1024 || h !== 1024) throw new Error(`${name}.png is ${w}x${h}, expected 1024x1024`);
    writeFileSync(join(HERE, `${name}.png`), bytes);
    console.log(`${name}.png  ${w}x${h}  ${bytes.length} bytes  svg-sha256=${sha.slice(0, 16)}`);
  }
} finally {
  // Read our session ourselves instead of relying on the browser's reply. Chrome collapses the tab
  // strip when a tab closes while a newer tab exists and can drop the socket mid-reply; a dropped
  // reply is indistinguishable from a dropped close, so only the target list is evidence.
  cdp.send('Target.closeTarget', { targetId: temp }).catch(() => {});
  const gone = await new Promise((resolve) => {
    const start = Date.now();
    const tick = async () => {
      try {
        const list = await (await fetch(`${BASE}/list`)).json();
        if (!list.some((t) => t.id === temp)) return resolve(true);
      } catch { /* browser briefly unreachable: retry */ }
      if (Date.now() - start > 15000) return resolve(false);
      setTimeout(tick, 200);
    };
    tick();
  });
  closed = gone;
  cdp.close();
}

const after = (await (await fetch(`${BASE}/list`)).json()).map((t) => t.id);
const added = after.filter((id) => !beforeIds.has(id));
const missing = [...beforeIds].filter((id) => !after.includes(id));
// Chrome reuses a closed target's id for the next external tab, so a leftover id is only proven ours
// when it is still an about:blank page. Anything else belongs to the user: report it, never close it.
if (added.length) {
  for (const s of (await (await fetch(`${BASE}/list`)).json()).filter((t) => added.includes(t.id))) {
    console.log(`unexpected new target ${s.id} ${s.type} ${s.url}`);
  }
}
console.log(`temp target closed: ${closed && !after.includes(temp)}; new targets left: ${JSON.stringify(added)}; pre-existing tabs missing: ${JSON.stringify(missing)}`);
if (added.length || missing.length) process.exitCode = 1;
