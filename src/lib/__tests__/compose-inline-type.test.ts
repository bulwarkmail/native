import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { inlineImageType } from '../compose-inline-type';

describe('inlineImageType', () => {
  it('keeps a plain image type, without its parameters', () => {
    expect(inlineImageType('image/jpeg', null)).toBe('image/jpeg');
    expect(inlineImageType('Image/JPEG; name="a.jpg"', null)).toBe('image/jpeg');
    expect(inlineImageType('image/svg+xml', 'image/png')).toBe('image/svg+xml');
  });

  it('drops a hostile declared type for the sniffed one', () => {
    expect(inlineImageType('image/x"><meta http-equiv="refresh">', 'image/gif')).toBe('image/gif');
    expect(inlineImageType('image/png"onload="x', null)).toBe('image/png');
    expect(inlineImageType('image/', 'image/webp')).toBe('image/webp');
  });

  it('falls back to the sniffed type, then PNG, for a part that is not labelled an image', () => {
    expect(inlineImageType('application/octet-stream', 'image/jpeg')).toBe('image/jpeg');
    expect(inlineImageType(undefined, null)).toBe('image/png');
  });

  // The composer took the part's type as it came for the data URI, the
  // re-upload and the part sent with the reply.
  it('is what the composer uses for a hydrated inline image', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../screens/ComposeScreen.tsx'), 'utf8');
    expect(source).toMatch(/const mime = inlineImageType\(att\.type, sniffImageMime\(bytes\)\);/);
    expect(source).not.toMatch(/startsWith\('image\/'\) \? att\.type/);
  });
});
