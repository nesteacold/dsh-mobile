// Reply/quote helpers (spec 017 wave 1, ported from Clarklevis's ComposerReplyPreview.kt).
//
// Pure on purpose: the transcript builds the quote, the composer shows it, and the prompt carries it.
// Everything that decides WHAT the quote says lives here so it can be unit-tested without a renderer
// (this repo has none), and so the three call sites cannot drift apart.

/** How much of the original message a quote keeps — one line, like the reference. */
export const QUOTE_MAX_CHARS = 160;

/** The composer's preview frame: at most two lines, so it never eats the input. */
export const QUOTE_PREVIEW_MAX_CHARS = 120;

/**
 * One-line excerpt of a message, for the quote header and the composer frame.
 *
 * Markdown is flattened (a quote is a citation, not a rendering): list markers, heading hashes,
 * emphasis markers and code fences are stripped, runs of whitespace collapse to one space, and the
 * result is cut on a word boundary with an ellipsis.
 */
export function quoteExcerpt(text: string, maxChars: number = QUOTE_PREVIEW_MAX_CHARS): string {
  const flattened = text
    .replace(/```[a-zA-Z0-9_-]*\n?/g, ' ')   // fences (and their language tag)
    .replace(/^#{1,6}\s+/gm, '')             // heading hashes
    .replace(/^\s*[-*+]\s+/gm, '')           // bullet markers
    .replace(/^\s*\d+[.)]\s+/gm, '')         // ordered markers
    .replace(/[*_`>]/g, '')                  // emphasis / code / quote markers
    .replace(/\s+/g, ' ')
    .trim();
  if (flattened.length <= maxChars) return flattened;
  const cut = flattened.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  const body = lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${body.trimEnd()}…`;
}

/**
 * The blockquote a reply sends to the Host: every line of the excerpt prefixed with `> `, then a
 * blank line, then the user's own text. A quote with no excerpt degrades to the plain reply, so a
 * long-press on an empty row can never send a dangling `>`.
 */
export function buildQuotePrompt(excerpt: string, reply: string): string {
  const quoted = quoteExcerpt(excerpt, QUOTE_MAX_CHARS);
  const body = reply.trim();
  if (quoted === '') return body;
  return `> ${quoted}\n\n${body}`;
}

/** What the composer's quote frame shows: the same excerpt, without the marker noise. */
export function quotePreview(excerpt: string): string {
  return quoteExcerpt(excerpt, QUOTE_PREVIEW_MAX_CHARS);
}
