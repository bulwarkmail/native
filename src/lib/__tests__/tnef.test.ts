import { describe, it, expect } from 'vitest';
import { parseTnef, isTnefAttachment } from '../tnef';

function u32(n: number): number[] {
  return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
}

function attr(level: number, id: number, data: number[]): number[] {
  return [level, ...u32(id), ...u32(data.length), ...data, 0, 0];
}

function bytes(s: string): number[] {
  return Array.from(new TextEncoder().encode(s));
}

// The MAPI block sits in an attachment-level attribute; attAttachRendData first
// so the parser has a current attachment to apply it to.
function tnefWithAttachmentProps(mapi: number[]): Uint8Array {
  return new Uint8Array([
    ...u32(0x223e9f78), 0x00, 0x00,
    ...attr(0x02, 0x00069002, [0]),
    ...attr(0x02, 0x00069005, mapi),
  ]);
}

describe('parseTnef', () => {
  it('rejects non-TNEF data', () => {
    expect(parseTnef(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toEqual({ body: null, htmlBody: null, attachments: [] });
    expect(parseTnef(new Uint8Array(2)).attachments).toEqual([]);
  });

  it('extracts the plain body and a simple attachment', () => {
    const data = new Uint8Array([
      ...u32(0x223e9f78), 0x00, 0x00,
      ...attr(0x01, 0x0002800c, bytes('Hello body')),
      ...attr(0x02, 0x00069002, [0, 0, 0, 0]),
      ...attr(0x02, 0x00018010, [...bytes('file.txt'), 0]),
      ...attr(0x02, 0x0006800f, bytes('payload')),
    ]);
    const res = parseTnef(data);
    expect(res.body).toBe('Hello body');
    expect(res.attachments).toHaveLength(1);
    expect(res.attachments[0].name).toBe('file.txt');
    expect(new TextDecoder().decode(res.attachments[0].data)).toBe('payload');
    expect(res.attachments[0].mimeType).toBe('application/octet-stream');
  });

  it('reads the HTML body and long filename from MAPI props', () => {
    // One PT_STRING8 property: type 0x001e, id 0x1013 (PR_BODY_HTML), count 1, value.
    const html = [...bytes('<p>hi</p>'), 0];
    const pad = (4 - (html.length % 4)) % 4;
    const mapi = [
      ...u32(1),
      0x1e, 0x00, 0x13, 0x10,
      ...u32(1),
      ...u32(html.length), ...html, ...new Array(pad).fill(0),
    ];
    const name = [...bytes('report.pdf'), 0];
    const npad = (4 - (name.length % 4)) % 4;
    const mime = [...bytes('application/pdf'), 0];
    const mpad = (4 - (mime.length % 4)) % 4;
    const attMapi = [
      ...u32(2),
      0x1e, 0x00, 0x07, 0x37, ...u32(1), ...u32(name.length), ...name, ...new Array(npad).fill(0),
      0x1e, 0x00, 0x0e, 0x37, ...u32(1), ...u32(mime.length), ...mime, ...new Array(mpad).fill(0),
    ];
    const data = new Uint8Array([
      ...u32(0x223e9f78), 0x00, 0x00,
      ...attr(0x01, 0x00069003, mapi),
      ...attr(0x02, 0x00069002, [0]),
      ...attr(0x02, 0x0006800f, bytes('%PDF')),
      ...attr(0x02, 0x00069005, attMapi),
    ]);
    const res = parseTnef(data);
    expect(res.htmlBody).toBe('<p>hi</p>');
    expect(res.attachments[0]).toMatchObject({ name: 'report.pdf', mimeType: 'application/pdf' });
  });
});

describe('parseTnef value-count bounds', () => {
  const expectFast = (mapi: number[]) => {
    const started = performance.now();
    expect(() => parseTnef(tnefWithAttachmentProps(mapi))).not.toThrow();
    expect(performance.now() - started).toBeLessThan(100);
  };

  it('stops on a truncated variable-length value instead of spinning on the count', () => {
    // 1 prop, PT_BINARY id 0x3701, count 0xFFFFFFFF, then a length larger than what is left.
    expectFast([...u32(1), 0x02, 0x01, 0x01, 0x37, ...u32(0xffffffff), ...u32(1000)]);
  });

  it('stops a multi-value fixed run that consumes nothing', () => {
    // PT_MV_LONG with count 0xFFFFFFFF and only 2 bytes left.
    expectFast([...u32(1), 0x03, 0x10, 0x00, 0x30, ...u32(0xffffffff), 0, 0]);
  });

  it.each([
    ['multi-valued STRING8', 0x101e],
    ['multi-valued unknown fixed type', 0x1099],
  ])('returns at once for a %s property claiming 0xFFFFFFFF values', (_label, propType) => {
    // Two bytes are too short to hold even one value.
    expectFast([...u32(1), propType & 0xff, propType >> 8, 0x01, 0x00, ...u32(0xffffffff), 0, 0]);
  });
});

describe('isTnefAttachment', () => {
  it('matches by name or type', () => {
    expect(isTnefAttachment('WINMAIL.DAT', 'application/octet-stream')).toBe(true);
    expect(isTnefAttachment('x.bin', 'application/ms-tnef')).toBe(true);
    expect(isTnefAttachment('x.bin', 'application/pdf')).toBe(false);
  });
});
