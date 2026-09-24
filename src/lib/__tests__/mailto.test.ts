import { describe, it, expect } from 'vitest';
import { parseMailtoUrl } from '../mailto';

describe('parseMailtoUrl', () => {
  it('parses recipients, subject and body', () => {
    expect(parseMailtoUrl('mailto:a@b.co?subject=Hi%20there&body=Line%201%0ALine%202')).toEqual({
      to: ['a@b.co'],
      cc: [],
      bcc: [],
      subject: 'Hi there',
      body: 'Line 1\nLine 2',
    });
  });

  it('accepts multiple recipients, to= in the query and cc/bcc', () => {
    const parsed = parseMailtoUrl('mailto:a@b.co,c@d.co?to=e@f.co&cc=g@h.co&bcc=i@j.co');
    expect(parsed?.to).toEqual(['a@b.co', 'c@d.co', 'e@f.co']);
    expect(parsed?.cc).toEqual(['g@h.co']);
    expect(parsed?.bcc).toEqual(['i@j.co']);
  });

  it('drops invalid addresses and returns null when none remain', () => {
    expect(parseMailtoUrl('mailto:not-an-address')).toBeNull();
    expect(parseMailtoUrl('mailto:?subject=x')).toBeNull();
    expect(parseMailtoUrl('https://example.com')).toBeNull();
    expect(parseMailtoUrl('')).toBeNull();
  });

  it('is case-insensitive on the scheme', () => {
    expect(parseMailtoUrl('MAILTO:a@b.co')?.to).toEqual(['a@b.co']);
  });

  // RFC 6068 has no form-encoding: `+` is a literal plus, only %XX is decoded.
  it('keeps a + in an address literal', () => {
    expect(parseMailtoUrl('mailto:alice+news@partner.example')).toEqual({
      to: ['alice+news@partner.example'],
      cc: [],
      bcc: [],
      subject: undefined,
      body: undefined,
    });
    expect(parseMailtoUrl('mailto:alice%2Bnews@partner.example')?.to).toEqual(['alice+news@partner.example']);
  });

  it('keeps a + in the subject and body literal and decodes %20 as the space', () => {
    const parsed = parseMailtoUrl('mailto:a@b.co?subject=a+b&body=1+1%20%3D%202');
    expect(parsed?.subject).toBe('a+b');
    expect(parsed?.body).toBe('1+1 = 2');
    expect(parseMailtoUrl('mailto:a@b.co?subject=a%2Bb')?.subject).toBe('a+b');
  });

  it('keeps + addresses among several recipients and in to/cc/bcc', () => {
    const parsed = parseMailtoUrl(
      'mailto:alice+news@partner.example,bob@partner.example'
      + '?to=carol+x@partner.example&cc=dave+y@partner.example,erin%2Bz%40partner.example'
      + '&bcc=frank+w@partner.example',
    );
    expect(parsed?.to).toEqual(['alice+news@partner.example', 'bob@partner.example', 'carol+x@partner.example']);
    expect(parsed?.cc).toEqual(['dave+y@partner.example', 'erin+z@partner.example']);
    expect(parsed?.bcc).toEqual(['frank+w@partner.example']);
  });
});
