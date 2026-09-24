import { describe, it, expect } from 'vitest';
import { splitTextLinks, hasTextLink } from '../linkify-text';

/**
 * A meeting invitation carries the join URL in its description, so that text
 * has to expose its URLs as something tappable. The split must agree with
 * `plainTextToSafeHtml` (lib/email-html), or the same message linkifies
 * differently in the mail body and in the calendar.
 */

describe('splitTextLinks', () => {
  it('marks the URL and keeps the text around it', () => {
    expect(splitTextLinks('Join: https://teams.example.com/meet/319560?p=CTYa9 Meeting ID: 319'))
      .toEqual([
        { text: 'Join: ' },
        { text: 'https://teams.example.com/meet/319560?p=CTYa9', url: 'https://teams.example.com/meet/319560?p=CTYa9' },
        { text: ' Meeting ID: 319' },
      ]);
  });

  it('stops at the closing bracket of the <https://...> form', () => {
    const segments = splitTextLinks('Need help? <https://aka.example/Join?omkt=fr-FR> | System');
    expect(segments.filter((s) => s.url).map((s) => s.url)).toEqual(['https://aka.example/Join?omkt=fr-FR']);
    expect(segments.map((s) => s.text).join('')).toBe('Need help? <https://aka.example/Join?omkt=fr-FR> | System');
  });

  it('finds every URL in a multi-line description', () => {
    const text = 'Microsoft Teams meeting\nJoin: https://teams.example.com/meet/1\n\nDial in: https://dialin.example/2';
    expect(splitTextLinks(text).filter((s) => s.url).map((s) => s.url))
      .toEqual(['https://teams.example.com/meet/1', 'https://dialin.example/2']);
  });

  it('leaves non-http schemes alone', () => {
    const text = 'try javascript:alert(1) or file:///etc/passwd or tel:+33123456789';
    expect(splitTextLinks(text)).toEqual([{ text }]);
    expect(hasTextLink(text)).toBe(false);
  });

  it('returns the text unchanged when there is no URL, and never loses characters', () => {
    expect(splitTextLinks('no links here')).toEqual([{ text: 'no links here' }]);
    expect(splitTextLinks('')).toEqual([]);
    const text = 'a https://x.example b https://y.example';
    expect(splitTextLinks(text).map((s) => s.text).join('')).toBe(text);
  });

  it('is not confused by repeated calls (no lastIndex leak)', () => {
    const text = 'https://x.example';
    expect(hasTextLink(text)).toBe(true);
    expect(hasTextLink(text)).toBe(true);
    expect(splitTextLinks(text)).toEqual([{ text, url: text }]);
    expect(splitTextLinks(text)).toEqual([{ text, url: text }]);
  });
});
