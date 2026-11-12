// "Am I at the bottom?" for the transcript (spec 017 wave 1, ScrollToBottomButton).
//
// Pure so the threshold is unit-tested rather than tuned by eye: the button appears when the reader is
// far enough from the newest message that new content would otherwise arrive off-screen.

/** Distance from the bottom (in points) inside which the reader still counts as "at the bottom". */
export const SCROLL_BOTTOM_SLACK = 72;

export interface ScrollMetrics {
  /** Current scroll offset. */
  offsetY: number;
  /** Total scrollable content height. */
  contentHeight: number;
  /** Visible viewport height. */
  viewportHeight: number;
  /** Slack override (defaults to {@link SCROLL_BOTTOM_SLACK}). */
  slack?: number;
}

/**
 * True when the reader has scrolled far enough up that the newest content is out of view.
 *
 * The content is allowed to be shorter than the viewport (then everything is visible and the button
 * must never appear), and the arithmetic is clamped so an over-scroll bounce cannot produce a
 * negative distance.
 */
export function isAwayFromBottom(metrics: ScrollMetrics): boolean {
  const { offsetY, contentHeight, viewportHeight } = metrics;
  const slack = metrics.slack ?? SCROLL_BOTTOM_SLACK;
  const scrollable = contentHeight - viewportHeight;
  if (scrollable <= slack) return false;
  const distance = scrollable - Math.max(0, offsetY);
  return distance > slack;
}
