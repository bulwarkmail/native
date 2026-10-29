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
  // A sender-chosen value count of 2^32 - 1 over a block with no room for a
  // single value used to spin the JS thread on reads that never advance.
  it('does not spin on a value count the block cannot hold', () => {
    const mapiVar = [
      ...u32(1),
      0x02, 0x01, 0x01, 0x00, // PT_BINARY, id 0x0001
      ...u32(0xffffffff),
      0x00, 0x00,
    ];
    const mapiFixed = [
      ...u32(1),
      0x99, 0x10, 0x01, 0x00, // multi-value of an unknown fixed type
      ...u32(0xffffffff),
      0x00, 0x00,
    ];
    for (const mapi of [mapiVar, mapiFixed]) {
      const data = new Uint8Array([
        ...u32(0x223e9f78), 0x00, 0x00,
        ...attr(0x01, 0x0002800c, bytes('Hello body')),
        ...attr(0x01, 0x00069003, mapi),
      ]);
      const started = Date.now();
      const res = parseTnef(data);
      expect(Date.now() - started).toBeLessThan(1000);
      expect(res.body).toBe('Hello body');
    }
  });
});

describe('isTnefAttachment', () => {
  it('matches by name or type', () => {
    expect(isTnefAttachment('WINMAIL.DAT', 'application/octet-stream')).toBe(true);
    expect(isTnefAttachment('x.bin', 'application/ms-tnef')).toBe(true);
    expect(isTnefAttachment('x.bin', 'application/pdf')).toBe(false);
  });
});
