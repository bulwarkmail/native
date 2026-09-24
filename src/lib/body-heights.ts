// How tall a message body turned out, so the next time it mounts (swiping
// back to it, opening it again, a card reopened) its WebView starts at that
// height instead of growing from a fixed strip.

const MAX_HEIGHTS = 200;
const heights = new Map<string, number>();

// The height only holds at the width it was measured at (rotation, split screen).
function keyOf(key: string, width: number): string {
  return `${key}|${Math.round(width)}`;
}

/** Remember the body's measured height at this width. */
export function rememberBodyHeight(key: string, width: number, height: number): void {
  if (!(height > 0)) return;
  const k = keyOf(key, width);
  heights.delete(k);
  heights.set(k, height);
  while (heights.size > MAX_HEIGHTS) heights.delete(heights.keys().next().value as string);
}

/** The body's height when it was last shown at this width, if known. */
export function lastBodyHeight(key: string, width: number): number | undefined {
  return heights.get(keyOf(key, width));
}

/** Forget every height (tests). */
export function clearBodyHeights(): void {
  heights.clear();
}

// The plain-text document: 14px text, line-height 1.6, 16px padding.
const TEXT_LINE_HEIGHT = 22.4;
const TEXT_CHAR_WIDTH = 7.5;
const TEXT_PADDING = 32 + 8;
const MIN_HEIGHT = 120;
const MAX_ESTIMATE = 4000;

/**
 * A first guess at a body's height before it has been measured, for bodies
 * that cannot simply take the space left on screen (conversation cards): an
 * HTML body gets most of a screen, plain text its wrapped line count.
 */
export function estimateBodyHeight(opts: {
  isHtml: boolean;
  text?: string | null;
  width: number;
  windowHeight: number;
}): number {
  if (opts.isHtml || !opts.text) return Math.max(MIN_HEIGHT, Math.round(opts.windowHeight * 0.6));
  const perLine = Math.max(20, Math.floor((opts.width - 32) / TEXT_CHAR_WIDTH));
  let lines = 0;
  for (const line of opts.text.split('\n')) lines += Math.max(1, Math.ceil(line.length / perLine));
  const estimate = Math.round(lines * TEXT_LINE_HEIGHT + TEXT_PADDING);
  return Math.min(MAX_ESTIMATE, Math.max(MIN_HEIGHT, estimate));
}
