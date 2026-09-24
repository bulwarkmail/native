/**
 * Split plain text into runs, marking the http(s) URLs inside it.
 *
 * For text rendered as React Native <Text>, where an <a> is not an option:
 * the caller maps each segment to a <Text>, giving the ones carrying a `url`
 * an onPress. The URL terminates at whitespace or any of `<>"'`, so the
 * `<https://…>` form mail clients emit yields a bare URL rather than one with
 * a trailing bracket.
 *
 * Same rule as `plainTextToSafeHtml` in lib/email-html - the two must agree,
 * or the same message linkifies differently in the body and in the calendar.
 * The result is still only a hint: hand every URL to `openExternalUrl`, which
 * is what actually checks the scheme.
 */

export interface TextSegment {
  text: string;
  /** Set when this run is an http(s) URL. */
  url?: string;
}

const URL_RE = /(https?:\/\/[^\s<>"']+)/g;

export function splitTextLinks(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  URL_RE.lastIndex = 0;
  while ((match = URL_RE.exec(text)) !== null) {
    if (match.index > lastIndex) segments.push({ text: text.slice(lastIndex, match.index) });
    segments.push({ text: match[0], url: match[0] });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) segments.push({ text: text.slice(lastIndex) });
  return segments;
}

/** True when the text holds at least one http(s) URL. */
export function hasTextLink(text: string): boolean {
  URL_RE.lastIndex = 0;
  return URL_RE.test(text);
}
