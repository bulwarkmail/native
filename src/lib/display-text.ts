// Direction controls let a sender reorder how their text is drawn ("Bank" +
// U+202E + "moc.live" reads as "Bank evil.com"), and line breaks let one line
// pass for another part of the screen.
const BIDI_CONTROLS = /[\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/g;
const CONTROLS_AND_BREAKS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;

/**
 * Sender-written text made safe to show inline: no direction controls, no
 * line breaks or other control characters, runs of spaces collapsed, and at
 * most `max` characters.
 */
export function plainDisplayText(value: string | null | undefined, max = 200): string {
  if (!value) return '';
  const text = value
    .replace(BIDI_CONTROLS, '')
    .replace(CONTROLS_AND_BREAKS, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
