import { describe, it, expect } from 'vitest';
import { pickEmailBody, selectRenderableHtml, plainTextBody, hasTruncatedDisplayedBody } from '../email-body';

describe('pickEmailBody', () => {
  it('does not treat the same part as a text alternative (HTML-only, native #46)', () => {
    const email = {
      htmlBody: [{ partId: '1', type: 'text/html' }],
      textBody: [{ partId: '1', type: 'text/html' }],
      bodyValues: { '1': { value: '<html><head><style>p{}</style></head><body><div>Hi</div></body></html>' } },
    };
    const picked = pickEmailBody(email);
    expect(picked.html).toContain('<div>Hi</div>');
    expect(picked.text).toBeNull();
    // Without a distinct text alternative the HTML is rendered even when it
    // fails the "meaningful" heuristic.
    expect(selectRenderableHtml(picked)).toContain('<div>Hi</div>');
    expect(plainTextBody({ ...email, preview: 'Hi' })).toBe('Hi');
  });

  it('renders text-only messages as text even when listed under htmlBody', () => {
    const email = {
      htmlBody: [{ partId: '1', type: 'text/plain' }],
      textBody: [{ partId: '1', type: 'text/plain' }],
      bodyValues: { '1': { value: 'plain <b>not html</b>' } },
    };
    const picked = pickEmailBody(email);
    expect(picked.html).toBeNull();
    expect(picked.text).toBe('plain <b>not html</b>');
    expect(selectRenderableHtml(picked)).toBeNull();
  });

  it('keeps both alternatives for multipart/alternative', () => {
    const email = {
      htmlBody: [{ partId: '2', type: 'text/html' }],
      textBody: [{ partId: '1', type: 'text/plain' }],
      bodyValues: { '1': { value: 'plain' }, '2': { value: '<p><b>rich</b></p>' } },
    };
    const picked = pickEmailBody(email);
    expect(picked.html).toBe('<p><b>rich</b></p>');
    expect(picked.text).toBe('plain');
    expect(selectRenderableHtml(picked)).toBe('<p><b>rich</b></p>');
    expect(plainTextBody(email)).toBe('plain');
  });

  it('prefers the text alternative when the HTML is a minimal wrapper', () => {
    const picked = pickEmailBody({
      htmlBody: [{ partId: '2', type: 'text/html' }],
      textBody: [{ partId: '1', type: 'text/plain' }],
      bodyValues: { '1': { value: 'line1\nline2' }, '2': { value: '<div>line1 line2</div>' } },
    });
    expect(selectRenderableHtml(picked)).toBeNull();
  });
});

describe('hasTruncatedDisplayedBody', () => {
  const parts = {
    htmlBody: [{ partId: '1', type: 'text/html' }],
    textBody: [{ partId: '2', type: 'text/plain' }],
  };

  it('flags a truncated HTML or text body part (#884)', () => {
    expect(hasTruncatedDisplayedBody({
      ...parts,
      bodyValues: { '1': { value: '<h1>Report</h1>', isTruncated: true }, '2': { value: 'Report' } },
    })).toBe(true);
    expect(hasTruncatedDisplayedBody({
      ...parts,
      bodyValues: { '1': { value: '<h1>Report</h1>' }, '2': { value: 'Rep', isTruncated: true } },
    })).toBe(true);
  });

  it('ignores truncated attachment parts and complete bodies', () => {
    expect(hasTruncatedDisplayedBody({
      ...parts,
      bodyValues: { '1': { value: 'x' }, '2': { value: 'x' }, '3': { value: 'a,b', isTruncated: true } },
    })).toBe(false);
    expect(hasTruncatedDisplayedBody({ ...parts })).toBe(false);
  });
});
