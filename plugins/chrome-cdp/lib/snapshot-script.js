/**
 * The page-side snippet R3 runs in one document: numbers its interactive elements and reports
 * title, URL, viewport and the numbered elements of that document alone.
 *
 * It never reads another frame. Frame traversal is the Host's: `ChromeCdp.snapshot` walks the
 * page's frame tree and linked OOPIF trees, evaluates this one expression in each document's
 * isolated world, and merges the answers into one page-wide numbering. A page script can
 * therefore neither see nor guess another document's numbers, and nothing here depends on a
 * helper object that only exists inside this plugin.
 *
 * `data-chrome-cdp-pass` names one numbering pass inside this document, so a read that finds
 * its numbers still fresh keeps them, exactly as a document-local index. Every helper is
 * captured before use, so a page that replaces one of them cannot turn a read into a hang.
 * @module @dsh-ext/chrome-cdp/snapshot-script
 */

/** One document's read; `reuse` is how long a numbering pass stays valid in it. */
function frameRead (reuse) {
  const Promise_ = Promise
  const setTimeout_ = setTimeout
  const done = () => ({ title: document.title, url: location.href, viewport: { w: window.innerWidth, h: window.innerHeight }, elements: [] })
  const read = (el, name) => { try { return el.getAttribute(name) } catch (error) { return null } }
  const write = (el, name, value) => { try { el.setAttribute(name, String(value)) } catch (error) {} }
  return (async () => {
    // The timer is the one promise that always settles: a page whose fonts never finish gets an
    // inventory without numbers after the wait, never a call that hangs (R3).
    const fonts = document.fonts && document.fonts.ready ? document.fonts.ready : null
    if (fonts !== null) {
      const late = await new Promise_((resolve) => {
        setTimeout_(() => resolve(true), 750)
        Promise_.resolve(fonts).then(() => resolve(false), () => resolve(false))
      })
      if (late) return done()
    }
    const root = document.documentElement
    const now = Date.now()
    const stamp = Number(read(root, 'data-chrome-cdp-at'))
    const elapsed = now - stamp
    // A pass is only a pass once it has an id stamped on the page: without one the numbers
    // belong to no pass and are renumbered, so a half-applied earlier call cannot be adopted.
    const passId = read(root, 'data-chrome-cdp-pass')
    const replay = reuse > 0 && Number.isFinite(elapsed) && elapsed >= 0 && elapsed < reuse && typeof passId === 'string' && passId !== ''
    // The pass id only has to tell passes apart within the window, so a clock plus the frame
    // count is enough; Math.random could repeat and let a removed element look kept.
    const pass = replay ? passId : 'p' + now.toString(36) + '.' + String(now) + '.' + String(document.querySelectorAll('*').length)
    const selector = 'a[href],button,input,textarea,select,[role=button],[role=link],[contenteditable=""],[contenteditable=true]'
    const previous = []
    if (!replay) for (const el of document.querySelectorAll('[data-chrome-cdp-index]')) {
      const value = read(el, 'data-chrome-cdp-index')
      if (value === null) continue
      previous.push([el, value])
      try { el.removeAttribute('data-chrome-cdp-index') } catch (error) {}
    }
    let highest = 0
    if (replay) for (const el of document.querySelectorAll('[data-chrome-cdp-index]')) {
      const used = Number(read(el, 'data-chrome-cdp-index'))
      if (Number.isFinite(used) && used > highest) highest = used
    }
    const out = done()
    try {
      for (const el of document.querySelectorAll(selector)) {
        let rect
        let style
        try { rect = el.getBoundingClientRect(); style = getComputedStyle(el) } catch (error) { continue }
        if (!rect || rect.width < 4 || rect.height < 4) continue
        if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') continue
        const kept = replay ? Number(read(el, 'data-chrome-cdp-index')) : NaN
        const number = Number.isInteger(kept) && kept > 0 ? kept : highest + 1
        if (number > highest) highest = number
        write(el, 'data-chrome-cdp-index', number)
        write(el, 'data-chrome-cdp-pass', pass)
        const tag = el.tagName ? el.tagName.toLowerCase() : 'element'
        const type = read(el, 'type')
        // A password field never contributes its value: the label falls back to the attributes
        // that describe the field, never to el.value (R8: no credential is ever read).
        const isPassword = String(type || '').toLowerCase() === 'password'
        const text = isPassword ? '' : String(el.value == null ? '' : el.value)
        const label = (el.innerText || text || read(el, 'aria-label') || read(el, 'placeholder') || el.title || '').trim().replace(/\s+/g, ' ').slice(0, 90)
        out.elements.push({
          index: number,
          tag,
          type: type || undefined,
          role: read(el, 'role') || undefined,
          label: label || undefined,
          href: tag === 'a' ? String(read(el, 'href') || '').slice(0, 120) : undefined,
        })
      }
    } catch (error) {
      for (const pair of previous) write(pair[0], 'data-chrome-cdp-index', pair[1])
      throw error
    }
    write(root, 'data-chrome-cdp-at', Date.now())
    write(root, 'data-chrome-cdp-pass', pass)
    return out
  })()
}

/**
 * The expression one document runs. Its element numbers are local to that document; the Host
 * merges them into one page-wide series.
 * @param {number|null} reuseMs - how long one numbering pass stays valid; `null` or `0` always
 *   numbers afresh. Clamped to whole non-negative milliseconds for the page.
 * @returns {string} one JavaScript expression, evaluated with `awaitPromise`.
 */
export function snapshotExpression (reuseMs) {
  const reuse = Number.isFinite(Number(reuseMs)) ? Math.max(0, Math.trunc(Number(reuseMs))) : 0
  return `(${frameRead})(${reuse})`
}

/**
 * The expression that resolves one numbered element to a viewport coordinate inside the frame
 * whose snapshot printed that number. Click and fill address elements this way, never by a
 * screen coordinate (R3).
 * @param {number} index - element number from a snapshot.
 */
export function elementRectExpression (index) {
  const n = Number(index)
  return `(() => {
  const el = document.querySelector('[data-chrome-cdp-index="${Number.isInteger(n) ? n : -1}"]')
  if (!el) return null
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
  const rect = el.getBoundingClientRect()
  if (rect.width < 1 || rect.height < 1) return null
  const type = el.getAttribute('type')
  // A password field reports its type and nothing about its value (R8): the caller refuses it,
  // and the description the action result prints comes from the attributes alone.
  const password = String(type || '').toLowerCase() === 'password'
  const text = password ? '' : String(el.innerText || el.value || el.getAttribute('aria-label') || '')
  return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2),
    tag: el.tagName.toLowerCase(), type: type === null ? undefined : type,
    text: text.trim().slice(0, 60) }
})()`
}
