// Latin-1 text in mail parsed on the device (#98). The app's TextDecoder is
// Expo's polyfill (expo/src/winter/TextDecoder.ts), which knows only UTF-8.
// postal-mime decodes iso-8859-1, us-ascii and windows-1252 parts by asking
// for a 'windows-1252' decoder (the WHATWG label for all three) and falls
// back to UTF-8 when the runtime refuses it, which turns every accented
// letter into U+FFFD. This adds windows-1252 to whatever TextDecoder the
// runtime has.

// WHATWG Encoding Standard labels of windows-1252.
const WINDOWS_1252_LABELS = new Set([
  'ansi_x3.4-1968', 'ascii', 'cp1252', 'cp819', 'csisolatin1', 'ibm819', 'iso-8859-1', 'iso-ir-100',
  'iso8859-1', 'iso88591', 'iso_8859-1', 'iso_8859-1:1987', 'l1', 'latin1', 'us-ascii', 'windows-1252', 'x-cp1252',
]);

// Code points of bytes 0x80-0x9f; every other byte is its own code point.
const HIGH = [
  0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178,
];

export function decodeWindows1252(bytes: Uint8Array): string {
  const codes = new Array<number>(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    codes[i] = b >= 0x80 && b <= 0x9f ? HIGH[b - 0x80] : b;
  }
  let out = '';
  for (let i = 0; i < codes.length; i += 0x2000) out += String.fromCharCode(...codes.slice(i, i + 0x2000));
  return out;
}

function toBytes(input: AllowSharedBufferSource | undefined): Uint8Array {
  if (input === undefined) return new Uint8Array(0);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  return new Uint8Array(input);
}

/** A TextDecoder class that also decodes windows-1252 and its aliases. */
export function withWindows1252(Base: typeof TextDecoder): typeof TextDecoder {
  return class extends Base {
    private readonly singleByte: boolean;

    constructor(label = 'utf-8', options?: TextDecoderOptions) {
      const singleByte = WINDOWS_1252_LABELS.has(String(label).trim().toLowerCase());
      super(singleByte ? 'utf-8' : label, options);
      this.singleByte = singleByte;
    }

    get encoding(): string {
      return this.singleByte ? 'windows-1252' : super.encoding;
    }

    decode(input?: AllowSharedBufferSource, options?: TextDecodeOptions): string {
      return this.singleByte ? decodeWindows1252(toBytes(input)) : super.decode(input, options);
    }
  };
}

/**
 * Give the global TextDecoder windows-1252 when the runtime lacks it. Called
 * before postal-mime parses, after Expo has installed its decoder (an
 * earlier install would be replaced by Expo's).
 */
export function installWindows1252Decoder(target: { TextDecoder?: typeof TextDecoder } = globalThis): void {
  const Current = target.TextDecoder;
  if (!Current) return;
  try {
    // Some decoders take the label but decode it as plain ISO-8859-1 (Node 20
    // gives U+0092 for 0x92): only a real windows-1252 decoder is kept.
    if (new Current('windows-1252').decode(new Uint8Array([0x80, 0x92])) === '€’') return;
  } catch {
    // UTF-8 only: wrap it below
  }
  target.TextDecoder = withWindows1252(Current);
}
