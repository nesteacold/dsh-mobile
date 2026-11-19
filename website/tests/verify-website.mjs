#!/usr/bin/env node
/**
 * Static verification for the DSH Extensions landing page.
 *
 *   node website/tests/verify-website.mjs        (from dsh-mobile/)
 *   node tests/verify-website.mjs               (from website/)
 *
 * Checks local assets, zero external CDN/font links, forbidden third-party
 * strings, i18n key parity across vi/en, ARIA wiring and JS syntax.
 * No dependencies, no network access.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = resolve(HERE, '..');
const HTML_PATH = join(SITE, 'index.html');
const html = readFileSync(HTML_PATH, 'utf8');
const lang = await import(pathToFileURL(join(SITE, 'i18n.js')).href).then(() => globalThis.__DSH_I18N__ || globalThis.window?.DSH_I18N).catch(() => null);

// i18n.js is a classic script: evaluate it in a tiny DOM-free sandbox so its
// dictionaries can be compared with the markup without a browser dependency.
const i18nSource = readFileSync(join(SITE, 'i18n.js'), 'utf8');
const sandbox = { document: {
  readyState: 'complete',
  documentElement: { lang: 'vi', dataset: {}, setAttribute() {}, toggleAttribute() {} },
  querySelectorAll: () => [],
  getElementById: () => null,
  addEventListener() {},
}, window: { addEventListener() {}, dispatchEvent() {} }, CustomEvent: class {}, console };
new Function('window', 'document', 'CustomEvent', i18nSource)(sandbox.window, sandbox.document, sandbox.CustomEvent);
const dictionaries = sandbox.window.DSH_I18N.dictionaries;

const attr = (tag, name) => {
  // role=tab is common, so name must match the whole attribute name.
  const re = new RegExp(`(?:^|\\s)${name}="([^"]*)"`, 'i');
  const found = re.exec(tag);
  return found ? found[1] : null;
};
const tags = (name) => [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'gi'))].map(m => m[0]);

// Keys from all five supported i18n attributes on every element.
const i18nKeys = new Set();
for (const match of html.matchAll(/\bdata-i18n(?:-(?:aria|alt|placeholder|content))?="([^"]+)"/g)) i18nKeys.add(match[1]);

test('local href/src paths resolve on disk', () => {
  const found = [];
  for (const tag of [...tags('link'), ...tags('script'), ...tags('img')]) {
    for (const name of ['href', 'src']) {
      const value = attr(tag, name);
      if (!value || /^(?:https?:|data:|#|mailto:|tel:)/i.test(value) || value.startsWith('//')) continue;
      const path = resolve(SITE, decodeURIComponent(value.split(/[?#]/)[0]));
      assert.ok(existsSync(path), `broken local path: ${value} in ${tag}`);
      found.push(value);
    }
  }
  assert.ok(found.includes('styles.css'));
  assert.ok(found.includes('i18n.js'));
  assert.ok(found.includes('assets/screens/03-session-list.png'));
});

test('zero external http(s) script/stylesheet/font links', () => {
  for (const tag of tags('script')) {
    const src = attr(tag, 'src');
    assert.ok(!src || !/^https?:\/\//i.test(src), `external script: ${tag}`);
  }
  for (const tag of tags('link')) {
    const href = attr(tag, 'href');
    assert.ok(!href || !/^https?:\/\//i.test(href), `external stylesheet: ${tag}`);
  }
  assert.ok(!/@import\s+url\(|fonts\.googleapis|fonts\.gstatic|cdn\./i.test(html), 'external font/CDN reference found');
  // No analytics or telemetry endpoints in scripts.
  assert.ok(!/<script[^>]*>(?:(?!<\/script>)[\s\S])*(?:googletagmanager|analytics|plausible|umami|sentry)/i.test(html), 'telemetry found');
});

test('zero forbidden third-party Whaleness strings in any shipped file', () => {
  const forbidden = ['whaleness', 'whale-girl', 'orca', 'polyman', 'sketchfab', 'cloudflare', 'webrtc'];
  const shipped = [HTML_PATH];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      // Test code and planning docs are not shipped; every served asset is.
      if (entry.name === 'tests' || entry.name === 'node_modules') continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(?:html|css|js|mjs|json|svg|txt)$/i.test(entry.name)) shipped.push(path);
    }
  }
  walk(SITE);
  assert.ok(shipped.some((file) => file.endsWith(join('vendor', 'glasswork', 'refract.js'))), 'vendored assets must be scanned');
  for (const file of shipped) {
    const text = readFileSync(file, 'utf8').toLowerCase();
    for (const needle of forbidden) {
      assert.ok(!text.includes(needle), `forbidden string in ${file.slice(SITE.length + 1)}: ${needle}`);
    }
  }
});

test('setup snippets match documented commands and config', () => {
  const REPO = resolve(SITE, '..');
  const gatewayReadme = readFileSync(join(REPO, 'plugins', 'mobile-gateway', 'README.md'), 'utf8');
  const wikiReadme = readFileSync(join(REPO, '..', 'dsh-wiki', 'README.md'), 'utf8');
  const gatewaySnippet = sandbox.window.DSH_I18N.dictionaries.en['setup.content.1.code'];
  const wikiSnippet = sandbox.window.DSH_I18N.dictionaries.en['setup.content.4.code'];

  // Gateway: the config keys shown must be the plugin config keys documented in its README.
  for (const key of gatewaySnippet.split(/\r?\n/).map((line) => line.split(':')[0])) {
    assert.ok(gatewayReadme.includes(`${key}:`), `gateway snippet key not documented: ${key}`);
  }
  assert.ok(gatewaySnippet.includes('ws://127.0.0.1:3081/ws/mobile'), 'gateway snippet must show the documented loopback endpoint');
  assert.ok(!/remoteControl\.enabled|gateway\.listen|gateway\.tls/.test(gatewaySnippet), 'gateway snippet uses undocumented DSH config keys');

  // Repo Wiki: only commands that appear in dsh-wiki's README may be shown as runnable.
  for (const line of wikiSnippet.split(/\r?\n/)) {
    const command = line.trim().replace(/^#.*/, '');
    if (!command) continue;
    assert.ok(wikiReadme.includes(command), `wiki snippet command not documented: ${command}`);
  }
  assert.ok(!/dsh wiki /.test(wikiSnippet), 'no documented `dsh wiki` CLI exists');

  // Both languages and the no-JS HTML fallback must show the same verified commands.
  // Comments may be translated, but a command line may not differ between locales.
  const commands = (text) => text.split(/\r?\n/).filter((line) => line.trim() && !line.trim().startsWith('#')).join('\n');
  for (const lang of ['vi', 'en']) {
    const dictionary = sandbox.window.DSH_I18N.dictionaries[lang];
    assert.equal(commands(dictionary['setup.content.1.code']), commands(gatewaySnippet), `gateway commands differ in ${lang}`);
    assert.equal(commands(dictionary['setup.content.4.code']), commands(wikiSnippet), `wiki commands differ in ${lang}`);
  }
  // Only step 1 has a static fallback snippet in index.html; later steps are
  // populated from the dictionaries by main.js.
  assert.ok(html.includes(commands(gatewaySnippet).replace(/&/g, '&amp;').replace(/</g, '&lt;')), 'HTML fallback missing gateway snippet');
  assert.match(html, /<code id="setup-code">/);
});

test('every data-i18n key exists in both vi and en; dictionaries match 100%', () => {
  const vi = dictionaries.vi;
  const en = dictionaries.en;
  assert.ok(vi && en, 'dictionaries missing');
  const missingVi = [...i18nKeys].filter(key => !(key in vi));
  const missingEn = [...i18nKeys].filter(key => !(key in en));
  assert.deepEqual(missingVi, [], `keys missing from vi: ${missingVi.join(', ')}`);
  assert.deepEqual(missingEn, [], `keys missing from en: ${missingEn.join(', ')}`);
  const viKeys = Object.keys(vi).sort();
  const enKeys = Object.keys(en).sort();
  assert.deepEqual(viKeys, enKeys, 'vi/en dictionary key sets differ');
  for (const key of viKeys) {
    assert.ok(typeof vi[key] === 'string' && vi[key].length > 0, `empty vi value: ${key}`);
    assert.ok(typeof en[key] === 'string' && en[key].length > 0, `empty en value: ${key}`);
  }
});

test('ARIA wiring: tabs, panels, dialog, skip link, image alt text', () => {
  assert.match(html, /<a class="skip-link"[^>]*href="#main"/, 'skip link missing');
  assert.ok(/<main[^>]*id="main"/.test(html), '#main target missing');
  const tablist = tags('[role]'); // structural check below uses raw HTML
  assert.ok(/role="tablist"/.test(html), 'tablist missing');
  assert.ok(/role="dialog"|<dialog\b/.test(html), 'dialog missing');
  assert.match(html, /<dialog[^>]*id="lightbox-dialog"/, 'lightbox dialog missing');
  assert.ok(/aria-labelledby="lightbox-title"/.test(html), 'dialog label missing');
  assert.ok(/data-i18n-aria="lightbox.close"/.test(html), 'dialog close label missing');

  const tabs = [...html.matchAll(/<button\b[^>]*role="tab"[^>]*>/g)].map(m => m[0]);
  assert.ok(tabs.length >= 4, `expected at least 4 tabs (4 experience views + 5 setup steps), got ${tabs.length}`);
  const experienceTabs = [...html.matchAll(/<button\b[^>]*role="tab"[^>]*id="tab-[^"]+"[^>]*>/g)].map(m => m[0]);
  assert.equal(experienceTabs.length, 4, `expected exactly 4 experience tabs, got ${experienceTabs.length}`);
  for (const tab of tabs) {
    const id = attr(tab, 'id');
    const controls = attr(tab, 'aria-controls');
    assert.ok(id, 'tab without id');
    assert.ok(controls, `tab ${id} missing aria-controls`);
    assert.ok(new RegExp(`<[^>]*\\bid="${controls}"[^>]*\\brole="tabpanel"`).test(html)
      || new RegExp(`role="tabpanel"[^>]*\\bid="${controls}"`).test(html),
    `tab ${id} points to missing tabpanel ${controls}`);
    // Each tab must be referenced by at least one panel (setup tabs share one
    // panel; the active tab's id is set by main.js on step change).
    assert.ok(id.startsWith('step-tab-') || new RegExp(`aria-labelledby="${id}"`).test(html), `tabpanel for ${id} missing aria-labelledby`);
  }
  const panels = [...html.matchAll(/<div\b[^>]*\brole="tabpanel"\b[^>]*>/g)].map(m => m[0]);
  for (const panel of panels) {
    assert.ok(attr(panel, 'id'), 'tabpanel without id');
    assert.ok(attr(panel, 'aria-labelledby'), 'tabpanel without aria-labelledby');
  }
  for (const image of tags('img')) {
    const alt = attr(image, 'alt');
    assert.ok(alt !== null, `image missing alt: ${image}`);
    if (alt === '') assert.ok(/\bclass="[^"]*(?:brand-mark|product-icon|ide-row)/.test(image) || attr(image, 'aria-hidden') === 'true'
      || /src="assets\/(?:orbit-icon|wiki-logo|vscode-icon)\.svg"/.test(image), `decorative image needs context: ${image}`);
  }
  for (const button of [...html.matchAll(/<button\b[^>]*\bclass="faq-q"\b[^>]*>/g)].map(m => m[0])) {
    assert.ok(attr(button, 'aria-expanded') !== null, 'FAQ button missing aria-expanded');
    assert.ok(attr(button, 'aria-controls'), 'FAQ button missing aria-controls');
  }
  assert.ok(/id="menu-toggle"[^>]*aria-expanded="false"[^>]*aria-controls="mobile-nav"/.test(html), 'mobile menu toggle wiring missing');
});

test('dark-only document and required engine assets are linked', () => {
  assert.match(html, /<html lang="vi">/);
  assert.match(html, /<meta name="color-scheme" content="dark">/);
  assert.match(html, /<meta name="theme-color" content="#06172B">/);
  for (const file of ['vendor/glasswork/glass.css', 'styles.css', 'liquid-glass.css']) {
    assert.ok(new RegExp(`<link[^>]*href="${file.replace('.', '\\.')}"`).test(html), `stylesheet not linked: ${file}`);
  }
  for (const file of ['i18n.js', 'main.js', 'liquid-glass.js']) {
    assert.ok(new RegExp(`<script[^>]*defer[^>]*src="${file.replace('.', '\\.')}"`).test(html), `script not deferred: ${file}`);
  }
  assert.ok(existsSync(join(SITE, 'vendor/glasswork/LICENSE')), 'glasswork MIT license missing');
});

test('every [data-glass-lens] element carries class "glass" and total count <= 8', () => {
  const lensTags = [...html.matchAll(/<[^>]*\bdata-glass-lens\b[^>]*>/gi)].map((m) => m[0]);
  assert.ok(lensTags.length > 0 && lensTags.length <= 8, `expected 1..8 [data-glass-lens] elements, got ${lensTags.length}`);
  for (const tag of lensTags) {
    const cls = attr(tag, 'class') || '';
    assert.ok(/\bglass\b/.test(cls), `[data-glass-lens] element missing class "glass": ${tag}`);
  }
});

test('clickable GitHub links exist and target="_blank" links carry rel="noopener noreferrer"', () => {
  assert.ok(html.includes('href="https://github.com/nesteacold/dsh-mobile"'), 'missing dsh-mobile GitHub link');
  assert.ok(html.includes('href="https://github.com/nesteacold/dsh-wiki"'), 'missing dsh-wiki GitHub link');
  const blankTags = tags('a').filter((tag) => attr(tag, 'target') === '_blank');
  assert.ok(blankTags.length >= 8, `expected >= 8 external target="_blank" links, got ${blankTags.length}`);
  for (const tag of blankTags) {
    const rel = (attr(tag, 'rel') || '').split(/\s+/);
    assert.ok(rel.includes('noopener') && rel.includes('noreferrer'), `target="_blank" link missing rel="noopener noreferrer": ${tag}`);
  }
});

test('Tailscale remote-access section exists with safe external links and fully translated keys', () => {
  assert.match(html, /<section[^>]*\bid="tailscale"/, '#tailscale section missing');
  assert.match(html, /<section[^>]*\bid="tailscale"[\s\S]*?aria-labelledby="tailscale-title"/, 'tailscale section label missing');
  assert.ok(html.indexOf('id="setup"') < html.indexOf('id="tailscale"'), 'tailscale section must follow #setup');
  assert.equal((html.match(/href="#tailscale"/g) || []).length, 2, 'expected #tailscale in both desktop and mobile nav');
  assert.ok(html.indexOf('id="tailscale"') < html.indexOf('id="faq"'), 'tailscale section must precede #faq');
  const anchors = tags('a').filter((tag) => /href="https:\/\/tailscale\.com\//.test(tag));
  assert.ok(anchors.length >= 2, `expected Tailscale download + CLI links, got ${anchors.length}`);
  for (const tag of anchors) {
    assert.equal(attr(tag, 'target'), '_blank', `Tailscale link missing target="_blank": ${tag}`);
    const rel = (attr(tag, 'rel') || '').split(/\s+/);
    assert.ok(rel.includes('noopener') && rel.includes('noreferrer'), `Tailscale link missing rel="noopener noreferrer": ${tag}`);
  }
  const requiredKeys = ['nav.tailscale', 'tailscale.eyebrow', 'tailscale.title', 'tailscale.intro',
    'tailscale.step.1.title', 'tailscale.step.1.desc', 'tailscale.step.2.title', 'tailscale.step.2.desc',
    'tailscale.step.3.title', 'tailscale.step.3.desc', 'tailscale.step.4.title', 'tailscale.step.4.desc',
    'tailscale.link.download', 'tailscale.link.cli', 'tailscale.note'];
  for (const key of requiredKeys) {
    assert.ok(i18nKeys.has(key), `missing data-i18n key in markup: ${key}`);
    assert.ok(typeof dictionaries.vi[key] === 'string' && dictionaries.vi[key].length, `missing vi string: ${key}`);
    assert.ok(typeof dictionaries.en[key] === 'string' && dictionaries.en[key].length, `missing en string: ${key}`);
  }
  assert.deepEqual(Object.keys(dictionaries.vi).sort(), Object.keys(dictionaries.en).sort(), 'vi/en dictionary key sets differ');
  assert.ok(!html.includes('公网'), 'literal-translation artifact in tailscale intro');
});

test('zero literal-translation or hallucinated strings in index.html and i18n.js', () => {
  const bad = [
    'Mọi khách hàng',
    'chọn tham gia',
    'Knowledge Cards nguyên tử',
    'chuyển tab để xem từng bề mặt',
    'hosts.add(',
    'approvals:write',
    'pwa-state',
    'Passkey Lock',
  ];
  for (const needle of bad) {
    assert.ok(!html.toLowerCase().includes(needle.toLowerCase()), `bad copy in index.html: ${needle}`);
    assert.ok(!i18nSource.toLowerCase().includes(needle.toLowerCase()), `bad copy in i18n.js: ${needle}`);
  }
});

test('node --check passes on all JavaScript files', () => {
  const files = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(?:js|mjs)$/.test(entry.name)) files.push(path);
    }
  }
  walk(SITE);
  assert.ok(files.length >= 8, `expected all JS files, found ${files.length}`);
  // This workspace has an empty package.json at its root; Node refuses to
  // parse any file beneath it. Copy each JS file into an isolated temp dir
  // with a valid package.json before running `node --check` on the copy.
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-website-check-'));
  try {
    writeFileSync(join(scratch, 'package.json'), '{}\n');
    for (const file of files) {
      const copy = join(scratch, basename(file));
      copyFileSync(file, copy);
      const output = execFileSync(process.execPath, ['--check', copy], { cwd: scratch, encoding: 'utf8' });
      assert.equal(output.trim(), '', `node --check failed: ${file}`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
