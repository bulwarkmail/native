import { describe, it, expect } from 'vitest';
import { decodeFileNodeName, getUniqueName, numberedFileName } from '../filenode-name';

describe('decodeFileNodeName (#869)', () => {
  it('decodes WebDAV-created percent-encoded names', () => {
    expect(decodeFileNodeName('Spares%20Catalog')).toBe('Spares Catalog');
    expect(decodeFileNodeName('%D8%AA%D9%82%D8%B1%D9%8A%D8%B1.pdf')).toBe('تقرير.pdf');
  });

  it('leaves names without a valid escape untouched', () => {
    expect(decodeFileNodeName('100% done.txt')).toBe('100% done.txt');
    expect(decodeFileNodeName('plain.txt')).toBe('plain.txt');
    expect(decodeFileNodeName('50%zz')).toBe('50%zz');
  });

  it('refuses decodes that would introduce a path separator or NUL', () => {
    expect(decodeFileNodeName('a%2Fb.txt')).toBe('a%2Fb.txt');
    expect(decodeFileNodeName('a%00b')).toBe('a%00b');
  });

  it('keeps the raw name when decoding throws on a malformed sequence', () => {
    expect(decodeFileNodeName('%20%E0%A4%A')).toBe('%20%E0%A4%A');
  });
});

describe('getUniqueName', () => {
  it('returns the name unchanged when free', () => {
    expect(getUniqueName('a.txt', new Set(['b.txt']))).toBe('a.txt');
  });

  it('appends a counter before the extension', () => {
    expect(getUniqueName('a.txt', new Set(['a.txt']))).toBe('a (1).txt');
    expect(getUniqueName('a.txt', new Set(['a.txt', 'a (1).txt']))).toBe('a (2).txt');
  });

  it('handles names without an extension and dotfiles', () => {
    expect(getUniqueName('README', new Set(['README']))).toBe('README (1)');
    expect(getUniqueName('.env', new Set(['.env']))).toBe('.env (1)');
  });
});

describe('numberedFileName', () => {
  it('puts the number before the extension', () => {
    expect(numberedFileName('report.pdf', 2)).toBe('report (2).pdf');
    expect(numberedFileName('archive.tar.gz', 3)).toBe('archive.tar (3).gz');
  });

  it('appends to names without an extension', () => {
    expect(numberedFileName('notes', 3)).toBe('notes (3)');
  });

  it('treats a leading dot as part of the name', () => {
    expect(numberedFileName('.env', 2)).toBe('.env (2)');
  });
});
