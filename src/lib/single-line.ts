/**
 * Fold a server string onto one line for display: every run of whitespace
 * (CR/LF, tabs, repeated spaces) becomes a single space and the ends are
 * trimmed. Message previews keep the body's paragraph breaks and a subject
 * can carry a stray CR/LF; on a line-clamped Text those left a dangling
 * "…" line and uneven row heights, and an unclamped subject wrapped over
 * several lines. A lone no-break space is kept so "12 %" doesn't split.
 */
export function singleLine(text: string | null | undefined): string {
  if (!text) return '';
  return text.replace(/\s+/g, (run) => (run === ' ' ? run : ' ')).trim();
}
