/**
 * App only: strict UTF-8 decoding for pkpass.ts, which the webmail does with
 * `new TextDecoder('utf-8', { fatal: true })`. Hermes may lack TextDecoder or
 * its `fatal` option; then the bytes are decoded here, and a malformed
 * sequence throws as the fatal decoder would.
 */
export function decodeUtf8Strict(bytes: Uint8Array): string {
  const Decoder = (globalThis as { TextDecoder?: typeof TextDecoder }).TextDecoder;
  if (Decoder) {
    let decoder: TextDecoder | null = null;
    try {
      decoder = new Decoder('utf-8', { fatal: true });
    } catch {
      decoder = null;
    }
    if (decoder) return decoder.decode(bytes);
  }
  return decodeByHand(bytes);
}

/** UTF-8 to a string, throwing on overlong, surrogate, out-of-range or cut-off sequences. */
export function decodeByHand(bytes: Uint8Array): string {
  const parts: string[] = [];
  let chunk: number[] = [];
  const flush = () => {
    if (chunk.length > 0) parts.push(String.fromCodePoint(...chunk));
    chunk = [];
  };
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i];
    let cp: number;
    let need: number;
    let min: number;
    if (b0 < 0x80) { cp = b0; need = 0; min = 0; }
    else if (b0 >= 0xc2 && b0 <= 0xdf) { cp = b0 & 0x1f; need = 1; min = 0x80; }
    else if (b0 >= 0xe0 && b0 <= 0xef) { cp = b0 & 0x0f; need = 2; min = 0x800; }
    else if (b0 >= 0xf0 && b0 <= 0xf4) { cp = b0 & 0x07; need = 3; min = 0x10000; }
    else throw new TypeError('invalid UTF-8');
    // A missing continuation byte (the input ends mid-sequence) is undefined here.
    for (let k = 1; k <= need; k++) {
      const b = bytes[i + k];
      if (b === undefined || (b & 0xc0) !== 0x80) throw new TypeError('invalid UTF-8');
      cp = (cp << 6) | (b & 0x3f);
    }
    if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) throw new TypeError('invalid UTF-8');
    chunk.push(cp);
    if (chunk.length >= 4096) flush();
    i += need + 1;
  }
  flush();
  return parts.join('');
}
