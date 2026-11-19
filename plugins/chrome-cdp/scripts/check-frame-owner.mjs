/**
 * Dev-only proof for the page-side geometry (reviewer round 3, item 2). Not part of the
 * package (it is not under `lib/`, `test/` or any exported path): it runs the production
 * `snapshotExpression` and `elementRectExpression` in VM documents that model nested
 * same-process iframes, so the rect a click would start from can be printed without a browser.
 *
 * The owner offsets are no longer page-side: `toDispatchSpace` measures each frame owner with
 * `DOM.getFrameOwner` + `DOM.getBoxModel` on the page session, and `test/round3.test.mjs`
 * pins that against the fake Chrome. Run: node scripts/check-frame-owner.mjs
 */
import vm from 'node:vm'
import assert from 'node:assert/strict'
import { snapshotExpression, elementRectExpression } from '../lib/cdp.js'

/**
 * One document: a viewport and elements.
 * @param {object} spec - `{ viewport, elements }`.
 */
function documentOf ({ viewport = { w: 1000, h: 800 }, elements = [] } = {}) {
  const nodes = elements.map((element) => {
    const attributes = new Map(Object.entries(element.attrs ?? {}))
    const rect = { x: element.x ?? 0, y: element.y ?? 0, width: element.width ?? 40, height: element.height ?? 20, left: element.x ?? 0, top: element.y ?? 0 }
    return {
      tagName: (element.tag ?? 'button').toUpperCase(),
      innerText: element.text ?? '',
      value: '',
      title: '',
      style: element.style ?? 'block',
      getAttribute: (name) => (attributes.has(name) ? attributes.get(name) : null),
      setAttribute: (name, value) => { attributes.set(name, String(value)) },
      removeAttribute: (name) => { attributes.delete(name) },
      getBoundingClientRect: () => rect,
      scrollIntoView: () => {},
    }
  })
  const root = { getAttribute: () => null, setAttribute: () => {}, removeAttribute: () => {} }
  return {
    title: 'doc',
    url: 'https://host.example/',
    documentElement: root,
    fonts: { ready: { then: (done) => { Promise.resolve().then(done) } } },
    all: nodes,
    viewport,
  }
}

/**
 * Run one page-side expression in a document of this fixture.
 * @param {object} document - from `documentOf`.
 * @param {string} expression - the production script.
 */
async function run (document, expression) {
  const context = vm.createContext({
    document: {
      title: document.title,
      documentElement: document.documentElement,
      fonts: document.fonts,
      querySelectorAll: (selector) => {
        if (selector === '[data-chrome-cdp-index]') return document.all.filter((node) => node.getAttribute('data-chrome-cdp-index') !== null)
        return document.all
      },
      querySelector: (selector) => {
        const index = /\[data-chrome-cdp-index="(\d+)"\]/.exec(selector)
        if (index !== null) return document.all.find((node) => node.getAttribute('data-chrome-cdp-index') === index[1]) ?? null
        return null
      },
    },
    location: { href: document.url },
    window: { innerWidth: document.viewport.w, innerHeight: document.viewport.h, frames: {} },
    getComputedStyle: () => ({
      visibility: 'visible',
      display: 'block',
      opacity: '1',
      borderLeftWidth: '0px',
      borderTopWidth: '0px',
      paddingLeft: '0px',
      paddingTop: '0px',
    }),
    setTimeout, clearTimeout, Promise, Date, Math, JSON,
  })
  return vm.runInContext(expression, context, { filename: 'page.js' })
}

// The innermost document holds the button at (10, 12) in its own viewport; its rect is the
// element's centre, which is what the owner offsets are later added to.
const inner = documentOf({ elements: [{ tag: 'button', text: 'Deep', x: 10, y: 12 }] })
const read = await run(inner, snapshotExpression(0))
assert.equal(read.elements.length, 1, 'the innermost document numbers its button')
const number = read.elements[0].index
const rect = await run(inner, elementRectExpression(number))
assert.deepEqual({ x: Number(rect.x), y: Number(rect.y) }, { x: 30, y: 22 }, 'the rect is in the innermost frame viewport')

console.log(JSON.stringify({ rectInFrame: { x: Number(rect.x), y: Number(rect.y) } }))
