// Mail in charsets other than UTF-8 and windows-1252, parsed on the device,
// showed U+FFFD for every letter outside ASCII (#98 follow-up): the app's
// TextDecoder (Expo's polyfill) knows only UTF-8 and the stand-in covered
// windows-1252 alone. Its own file: postal-mime keeps the decoders it made,
// so the stand-in must be in place before postal-mime first loads.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { decodeSingleByte, installWindows1252Decoder, singleByteEncoding } from '../single-byte-text-decoder';
import { SINGLE_BYTE_TABLES } from '../single-byte-tables';

const NodeTextDecoder = globalThis.TextDecoder;

/** Like expo/src/winter/TextDecoder.ts: a RangeError for any label but UTF-8. */
class Utf8OnlyTextDecoder extends NodeTextDecoder {
  constructor(label = 'utf-8', options?: TextDecoderOptions) {
    if (!['utf-8', 'utf8', 'unicode-1-1-utf-8'].includes(String(label).trim().toLowerCase())) {
      throw new RangeError(`Unknown encoding: ${label}`);
    }
    super('utf-8', options);
  }
}

beforeAll(() => {
  const target = { TextDecoder: Utf8OnlyTextDecoder as typeof TextDecoder };
  installWindows1252Decoder(target);
  vi.stubGlobal('TextDecoder', target.TextDecoder);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

const bytes = (...b: number[]) => new Uint8Array(b);

describe('single-byte charsets on a UTF-8-only TextDecoder', () => {
  it('decodes Central European, Cyrillic, Greek, Turkish, Hebrew, Arabic, Baltic, Vietnamese and Thai text', () => {
    const D = globalThis.TextDecoder;
    expect(new D('iso-8859-2').decode(bytes(0x50, 0xf8, 0xed, 0x6c, 0x69, 0xb9, 0x20, 0xbe, 0x6c, 0x75, 0xbb, 0x6f, 0x75, 0xe8, 0x6b, 0xfd))).toBe('Příliš žluťoučký');
    expect(new D('windows-1250').decode(bytes(0x8a, 0x9a, 0x8e, 0x9e))).toBe('ŠšŽž');
    expect(new D('KOI8-R').decode(bytes(0xf0, 0xd2, 0xc9, 0xd7, 0xc5, 0xd4))).toBe('Привет');
    expect(new D('koi8-u').decode(bytes(0xa4, 0xa6, 0xa7, 0xae))).toBe('єіїў');
    expect(new D('windows-1251').decode(bytes(0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2))).toBe('Привет');
    expect(new D('iso-8859-5').decode(bytes(0xbf, 0xe0, 0xd8))).toBe('При');
    expect(new D('iso-8859-7').decode(bytes(0xc1, 0xe8, 0xde, 0xed, 0xe1))).toBe('Αθήνα');
    expect(new D('iso-8859-9').decode(bytes(0xd0, 0xdd, 0xde, 0xf0, 0xfd, 0xfe))).toBe('ĞİŞğış');
    expect(new D('windows-1255').decode(bytes(0xf9, 0xec, 0xe5, 0xed))).toBe('שלום');
    expect(new D('windows-1256').decode(bytes(0xe3, 0xd1, 0xcd, 0xc8, 0xc7))).toBe('مرحبا');
    expect(new D('windows-1257').decode(bytes(0xe0, 0xe8, 0xeb))).toBe('ąčė');
    expect(new D('windows-1258').decode(bytes(0x56, 0x69, 0xea, 0xf2, 0x74))).toBe(`Viê${String.fromCharCode(0x323)}t`);
    expect(new D('tis-620').decode(bytes(0xca, 0xc7, 0xd1, 0xca, 0xb4, 0xd5))).toBe('สวัสดี');
    expect(new D('iso-8859-15').decode(bytes(0xa4))).toBe('€');
    expect(new D('iso-8859-16').decode(bytes(0xaa, 0xba))).toBe('Șș');
    expect(new D('latin2').encoding).toBe('iso-8859-2');
    expect(new D('ISO-8859-1').encoding).toBe('windows-1252');
    // UTF-8 still goes to the runtime; multi-byte charsets are still refused.
    expect(new D().decode(new TextEncoder().encode('Grüße'))).toBe('Grüße');
    expect(() => new D('shift_jis')).toThrow(RangeError);
  });

  it('decodes every byte of every table as a browser does', () => {
    const patched: Record<string, number[]> = { 'koi8-u': [0xae, 0xbe], 'windows-1255': [0xca], 'windows-874': [0xdb, 0xdc, 0xdd, 0xde, 0xfc, 0xfd, 0xfe, 0xff] };
    for (const [name, table] of Object.entries(SINGLE_BYTE_TABLES)) {
      expect(table.high).toHaveLength(128);
      for (const label of table.labels) expect(singleByteEncoding(label.toUpperCase())).toBe(name);
      let reference: TextDecoder;
      try {
        reference = new NodeTextDecoder(name);
      } catch {
        continue; // iso-8859-16: Node's ICU lacks it
      }
      for (let b = 0; b < 256; b++) {
        if (patched[name]?.includes(b)) continue;
        expect(decodeSingleByte(bytes(b), name), `${name} 0x${b.toString(16)}`).toBe(reference.decode(bytes(b)));
      }
    }
  });

  it('shows a koi8-r and an iso-8859-2 part of a message parsed on the device', async () => {
    const { default: PostalMime } = await import('postal-mime');
    const raw = [
      'From: a@example.org',
      'To: b@example.org',
      'Subject: =?koi8-r?B?8NLJ18XU?=',
      'Content-Type: multipart/alternative; boundary=b1',
      '',
      '--b1',
      'Content-Type: text/plain; charset=koi8-r',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      '=F0=D2=C9=D7=C5=D4',
      '--b1',
      'Content-Type: text/html; charset=iso-8859-2',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      '<p>P=F8=EDli=B9 =BEluou=E8k=FD</p>',
      '--b1--',
      '',
    ].join('\r\n');
    const parsed = await PostalMime.parse(raw);
    expect(parsed.subject).toBe('Привет');
    expect(parsed.text?.trim()).toBe('Привет');
    expect(parsed.html).toContain('Příliš žluoučký');
  });
});
