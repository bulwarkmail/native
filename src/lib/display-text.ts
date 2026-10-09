// Direction controls let a sender reorder how their text is drawn ("Bank" +
// U+202E + "moc.live" reads as "Bank evil.com"), zero-width and other format
// characters (Unicode category Cf) hide inside a name, and line breaks let one
// line pass for another part of the screen.
//
// Cf listed by hand (Unicode 17): Hermes may lack `\p{Cf}`. Astral ones are
// written as surrogate pairs, so no `u` flag is needed either. The tests check
// the list against `\p{Cf}` of the engine running them.
const FORMAT_CHARACTERS = new RegExp(
  '[\\u00ad\\u0600-\\u0605\\u061c\\u06dd\\u070f\\u0890\\u0891\\u08e2\\u180e\\u200b-\\u200f'
  + '\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u206f\\ufeff\\ufff9-\\ufffb]'
  + '|\\ud804[\\udcbd\\udccd]'
  + '|\\ud80d[\\udc30-\\udc3f]'
  + '|\\ud82f[\\udca0-\\udca3]'
  + '|\\ud834[\\udd73-\\udd7a]'
  + '|\\udb40[\\udc01\\udc20-\\udc7f]',
  'g',
);
const CONTROLS_AND_BREAKS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;

/**
 * Sender-written text made safe to show inline: no direction controls or
 * other format characters, no line breaks or control characters, runs of
 * spaces collapsed, and at most `max` characters (code points, so an emoji's
 * surrogate pair is never cut in half).
 */
export function plainDisplayText(value: string | null | undefined, max = 200): string {
  if (!value) return '';
  const text = value
    .replace(FORMAT_CHARACTERS, '')
    .replace(CONTROLS_AND_BREAKS, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text;
}

// Every control but the line feed, and the Unicode line/paragraph separators.
const CONTROLS_BUT_LINE_FEED = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]+/g;

/**
 * Sender-written text made safe to store as plain text: no format or control
 * characters, line breaks kept (as \n). Null when it is longer than `max`
 * code points: text to be written is refused, never cut.
 */
export function plainStoredText(value: string | null | undefined, max: number): string | null {
  if (!value) return '';
  const text = value
    .replace(/\r\n?/g, '\n')
    .replace(FORMAT_CHARACTERS, '')
    .replace(CONTROLS_BUT_LINE_FEED, ' ')
    .trim();
  return Array.from(text).length > max ? null : text;
}
