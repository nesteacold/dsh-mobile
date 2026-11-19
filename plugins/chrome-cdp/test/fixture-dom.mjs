/**
 * A minimal DOM model for the real snapshot script, so the fake Chrome can run the production
 * page-side code in a VM instead of answering with a canned object.
 *
 * One model per fake: a document per frame, each and the iframe element it sits in being the
 * same object. The snapshot script and the element lookup therefore read the element they act
 * on across frames too, and a test may state what a frame's document CONTAINS instead of which
 * context id its read happens to get (ids are counted per fake, so a test that also opens and
 * closes a tab cannot know one in advance).
 */
import vm from 'node:vm'

/** The tag-agnostic selectors the snapshot script matches, and what each one needs. */
const SELECTOR_PARTS = [
  ['a[href]', (node) => node.tagName === 'A' && node.getAttribute('href') !== null],
  ['button', (node) => node.tagName === 'BUTTON'],
  ['input', (node) => node.tagName === 'INPUT'],
  ['textarea', (node) => node.tagName === 'TEXTAREA'],
  ['select', (node) => node.tagName === 'SELECT'],
  ['[role=button]', (node) => node.getAttribute('role') === 'button' || node.getAttribute('role') === 'link'],
  ['[role=link]', (node) => node.getAttribute('role') === 'button' || node.getAttribute('role') === 'link'],
  ['[contenteditable=""]', (node) => node.getAttribute('contenteditable') === '' || node.getAttribute('contenteditable') === 'true'],
  ['[contenteditable=true]', (node) => node.getAttribute('contenteditable') === '' || node.getAttribute('contenteditable') === 'true'],
]

/**
 * One element with the attributes, box and text the script reads.
 * @param {object} [spec] - `{ tag, text, attrs, value, box }`.
 * @param {string} [spec.tag] - its tag name.
 * @param {string} [spec.text] - its text, as the page's own DOM would give it.
 * @param {object} [spec.attrs] - its attributes.
 * @param {string} [spec.value] - its `value`, which only an input or textarea has.
 * @param {{left: number, top: number, width: number, height: number}} [spec.box] - its border
 *   box in its own viewport (default 100x24 at 0,0).
 */
export function element ({ tag = 'div', text = '', attrs = {}, value, box } = {}) {
  const attributes = new Map(Object.entries(attrs))
  const rect = box ?? { left: 0, top: 0, width: 100, height: 24 }
  return {
    tagName: tag.toUpperCase(),
    innerText: text,
    value: value === undefined ? '' : value,
    title: attributes.get('title') ?? '',
    getAttribute: (name) => (attributes.has(name) ? attributes.get(name) : null),
    setAttribute: (name, next) => { attributes.set(name, String(next)) },
    removeAttribute: (name) => { attributes.delete(name) },
    getBoundingClientRect: () => ({ width: rect.width, height: rect.height, x: rect.left, y: rect.top, left: rect.left, top: rect.top }),
    scrollIntoView: () => {},
  }
}

/**
 * The script-facing view of one document: its own elements and its `<html>`, which carries the
 * reuse stamp. A document lists only what it contains; a test that wants the top document's
 * queries to reach a child frame gives the child's document the same `all` list.
 * @param {object[]} [nodes] - the page's elements, as `element()` builds them.
 * @param {string} [url] - the document's URL.
 * @param {{w: number, h: number}} [viewport] - its own viewport, which its owner maps.
 * @param {object} [fonts] - its `document.fonts`; by default they resolve at once.
 */
function viewOf ({ nodes = [], url = 'https://example.com/', viewport = { w: 800, h: 600 }, fonts } = {}) {
  const all = [...nodes]
  return {
    title: url,
    documentElement: element({ tag: 'html', box: { left: 0, top: 0, width: viewport.w, height: viewport.h } }),
    fonts: fonts ?? { ready: { then: (done) => { Promise.resolve().then(done) } } },
    all,
    url,
    viewport,
  }
}

/**
 * One document, from its elements (or a whole view of them).
 * @param {object[]|object} nodes - `element()` specs, or a view to use or copy.
 * @param {string} [url] - the document's URL.
 * @param {{w: number, h: number}} [viewport] - its own viewport.
 */
export function documentOf (nodes, url = 'https://example.com/', viewport) {
  if (!Array.isArray(nodes)) return { ...nodes, url: url ?? nodes.url }
  return viewOf({ nodes, url, viewport })
}

/**
 * A minimal document the page-side scripts can read: `nodes`, a `<html>` carrying the reuse
 * stamp, stub fonts, and a `resource` for the document a click is sent to.
 * @param {string} url - the document's URL.
 * @param {object[]} [nodes] - its elements, as `element()` builds them.
 * @param {object} [options] - `{ viewport, resource }`; `resource` is what a click receives.
 */
export function pageDocument (url, nodes = [], options = {}) {
  return { ...viewOf({ nodes, url, viewport: options.viewport }), resource: options.resource ?? {} }
}

/** Alias kept for callers that name a frame's document by frame; the document shape is identical. */
export const frameDocument = pageDocument

/** The view one frame's page-side scripts read, if this document can answer as one. */
const viewable = (candidate) => (candidate !== null && typeof candidate === 'object' && Array.isArray(candidate.all) ? candidate : null)

/**
 * Run one page-side expression read in this document; the world is fresh per call, as an
 * isolated world is for a new document.
 * @param {object} document - from `documentOf`, `pageDocument` or `frameDocument`; when it has no
 *   `all` list, the expression is answered by the plain object itself.
 * @param {string} expression - the script the Host sent.
 */
export async function runInDocument (document, expression) {
  const view = viewable(document)
  if (view === null) return document
  const context = vm.createContext({
    document: {
      title: view.title,
      documentElement: view.documentElement,
      fonts: view.fonts,
      // Chrome lists only what the selector matches: the interactive selector the snapshot
      // numbers, and the numbered-attribute walk the lookups read.
      querySelectorAll: (selector) => {
        if (selector === '[data-chrome-cdp-index]') return view.all.filter((node) => node.getAttribute('data-chrome-cdp-index') !== null)
        if (selector === '*') return [view.documentElement]
        return view.all.filter((node) => SELECTOR_PARTS.some(([, matches]) => matches(node)))
      },
      querySelector: (selector) => {
        const wanted = /\[data-chrome-cdp-index="(\d+)"\]/.exec(selector)
        if (wanted === null) return null
        return view.all.find((node) => node.getAttribute('data-chrome-cdp-index') === wanted[1]) ?? null
      },
    },
    location: { href: view.url },
    // A frame's document always has a window; the element lookup reads its size from it.
    window: { innerWidth: view.viewport?.w ?? 800, innerHeight: view.viewport?.h ?? 600 },
    getComputedStyle: () => ({ visibility: 'visible', display: 'block', opacity: '1' }),
    setTimeout, clearTimeout, Promise, Date, Math,
  })
  return vm.runInContext(expression, context, { filename: 'snapshot.js' })
}
