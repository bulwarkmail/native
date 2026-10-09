import { describe, it, expect } from 'vitest';
import { linkHostLabel, isSafeExternalUrl } from '../open-url';

describe('linkHostLabel', () => {
  it('shows the host a link opens', () => {
    expect(linkHostLabel('https://meet.example/board?x=1')).toBe('meet.example');
    expect(linkHostLabel('mailto:a@b.example')).toBe('mailto:a@b.example');
  });

  it('keeps direction controls out of the host the confirm names', () => {
    // "evil" + U+202E + "moc.knab" would read as "evilbank.com" reversed.
    expect(linkHostLabel('https://evil‮moc.knab/x')).toBe('evilmoc.knab');
    expect(linkHostLabel('https://a​b.example')).toBe('ab.example');
  });
});

describe('isSafeExternalUrl', () => {
  it('refuses control characters', () => {
    expect(isSafeExternalUrl('https://a.example/\u0000')).toBe(false);
    expect(isSafeExternalUrl('https://a.example/\u007f')).toBe(false);
    expect(isSafeExternalUrl('https://a.example/ok')).toBe(true);
  });
});
