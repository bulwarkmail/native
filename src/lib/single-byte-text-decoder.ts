// Single-byte text in mail parsed on the device (#98). The app's TextDecoder
// is Expo's polyfill (expo/src/winter/TextDecoder.ts), which knows only
// UTF-8. postal-mime decodes a part by asking for a decoder of its charset
// and falls back to UTF-8 when the runtime refuses it, which turns every
// letter outside ASCII into U+FFFD. This adds windows-1252 (the WHATWG label
// for iso-8859-1, us-ascii and windows-1252) and the other common
// single-byte encodings (iso-8859-2 to -16, windows-874 and -1250 to -1258,
// koi8-r, koi8-u) to whatever TextDecoder the runtime has. Multi-byte
// encodings (Shift_JIS, GBK, Big5, EUC-KR) still fall back to UTF-8.

import { SINGLE_BYTE_TABLES } from './single-byte-tables';

// WHATWG Encoding Standard labels of windows-1252.
const WINDOWS_1252_LABELS = [
  'ansi_x3.4-1968', 'ascii', 'cp1252', 'cp819', 'csisolatin1', 'ibm819', 'iso-8859-1', 'iso-ir-100',
  'iso8859-1', 'iso88591', 'iso_8859-1', 'iso_8859-1:1987', 'l1', 'latin1', 'us-ascii', 'windows-1252', 'x-cp1252',
];

// Code points of bytes 0x80-0x9f; every other byte is its own code point.
const HIGH = [
  0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178,
];

const WINDOWS_1252_HIGH = Array.from({ length: 128 }, (_, i) => String.fromCharCode(i < 32 ? HIGH[i] : 0x80 + i)).join('');

/** Encoding name by label, and the characters of bytes 0x80-0xff by encoding name. */
const ENCODING_BY_LABEL = new Map<string, string>();
const HIGH_BY_ENCODING = new Map<string, string>();
for (const label of WINDOWS_1252_LABELS) ENCODING_BY_LABEL.set(label, 'windows-1252');
HIGH_BY_ENCODING.set('windows-1252', WINDOWS_1252_HIGH);
for (const [name, table] of Object.entries(SINGLE_BYTE_TABLES)) {
  for (const label of table.labels) ENCODING_BY_LABEL.set(label, name);
  HIGH_BY_ENCODING.set(name, table.high);
}

/** The single-byte encoding a label names, or null for any other (UTF-8, multi-byte, unknown). */
export function singleByteEncoding(label: string): string | null {
  return ENCODING_BY_LABEL.get(String(label).trim().toLowerCase()) ?? null;
}

/** `bytes` decoded as the single-byte `encoding` (a name singleByteEncoding returned). */
export function decodeSingleByte(bytes: Uint8Array, encoding: string): string {
  const high = HIGH_BY_ENCODING.get(encoding);
  if (!high) throw new RangeError(`Unknown encoding: ${encoding}`);
  const codes = new Array<number>(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    codes[i] = b < 0x80 ? b : high.charCodeAt(b - 0x80);
  }
  let out = '';
  for (let i = 0; i < codes.length; i += 0x2000) out += String.fromCharCode(...codes.slice(i, i + 0x2000));
  return out;
}

export function decodeWindows1252(bytes: Uint8Array): string {
  return decodeSingleByte(bytes, 'windows-1252');
}

function toBytes(input: AllowSharedBufferSource | undefined): Uint8Array {
  if (input === undefined) return new Uint8Array(0);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  return new Uint8Array(input);
}

/** A TextDecoder class that also decodes windows-1252 and the other single-byte encodings. */
export function withSingleByteDecoders(Base: typeof TextDecoder): typeof TextDecoder {
  return class extends Base {
    private readonly singleByte: string | null;

    constructor(label = 'utf-8', options?: TextDecoderOptions) {
      const singleByte = singleByteEncoding(label);
      super(singleByte ? 'utf-8' : label, options);
      this.singleByte = singleByte;
    }

    get encoding(): string {
      return this.singleByte ?? super.encoding;
    }

    decode(input?: AllowSharedBufferSource, options?: TextDecodeOptions): string {
      return this.singleByte ? decodeSingleByte(toBytes(input), this.singleByte) : super.decode(input, options);
    }
  };
}

/** @deprecated name kept for callers: see withSingleByteDecoders. */
export const withWindows1252 = withSingleByteDecoders;

// One byte of each kind the runtime must get right to be left alone.
const PROBES: [string, number[], string][] = [
  ['windows-1252', [0x80, 0x92], '€’'],
  ['iso-8859-2', [0xb1], 'ą'],
  ['koi8-r', [0xc1], 'а'],
  ['windows-1251', [0xc0], 'А'],
];

function decodesAll(Current: typeof TextDecoder): boolean {
  try {
    // Some decoders take a label but decode it as plain ISO-8859-1 (Node 20
    // gives U+0092 for 0x92): only a real decoder of each counts.
    return PROBES.every(([label, bytes, text]) => new Current(label).decode(new Uint8Array(bytes)) === text);
  } catch {
    return false;
  }
}

/**
 * Give the global TextDecoder the single-byte encodings when the runtime
 * lacks them. Called before postal-mime parses, after Expo has installed its
 * decoder (an earlier install would be replaced by Expo's).
 */
export function installWindows1252Decoder(target: { TextDecoder?: typeof TextDecoder } = globalThis): void {
  const Current = target.TextDecoder;
  if (!Current || decodesAll(Current)) return;
  target.TextDecoder = withSingleByteDecoders(Current);
}
