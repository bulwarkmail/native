/**
 * Unicode directional formatting characters: the explicit embeddings,
 * overrides and isolates (U+202A-202E, U+2066-2069) and the LRM/RLM marks.
 * In a sender-controlled name they reorder what the reader sees, so
 * `report<U+202E>fdp.exe` shows as `reportexe.pdf` (webmail lib/bidi.ts).
 */
const BIDI_CONTROLS = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

/** `text` without directional formatting characters, for display. */
export function stripBidiControls(text: string): string {
  return text.replace(BIDI_CONTROLS, '');
}
