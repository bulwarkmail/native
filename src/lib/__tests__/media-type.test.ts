import { describe, it, expect } from 'vitest';
import { mediaTypeEssence } from '../media-type';

// Mirrors Stalwart 1.0's `essence_normalisation` test (types/src/media_type/mod.rs):
// 1.0 refuses a FileNode `type` that isn't a bare, valid media type.
describe('mediaTypeEssence', () => {
  it('drops parameters and lowercases', () => {
    expect(mediaTypeEssence('Text/Plain; charset=utf-8')).toBe('text/plain');
    expect(mediaTypeEssence('image/png')).toBe('image/png');
    expect(mediaTypeEssence(' text/html ')).toBe('text/html');
    expect(mediaTypeEssence('application/vnd.api+json')).toBe('application/vnd.api+json');
    expect(mediaTypeEssence('application/vnd.openxmlformats-officedocument.wordprocessingml.document'))
      .toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  });

  it('falls back to application/octet-stream for anything else', () => {
    for (const invalid of ['', 'text', 'text/', '/plain', 'te xt/plain', '-a/b', 'a/b/c', `a/${'b'.repeat(128)}`, 'd']) {
      expect(mediaTypeEssence(invalid), JSON.stringify(invalid)).toBe('application/octet-stream');
    }
    expect(mediaTypeEssence(null)).toBe('application/octet-stream');
    expect(mediaTypeEssence(undefined)).toBe('application/octet-stream');
  });

  it('keeps names of the longest length the server takes', () => {
    const longest = `a/${'b'.repeat(127)}`;
    expect(mediaTypeEssence(longest)).toBe(longest);
  });
});
