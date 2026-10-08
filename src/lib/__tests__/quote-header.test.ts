import { describe, it, expect } from 'vitest';
import { buildQuoteHeader, formatQuoteDate, formatQuoteSender } from '../quote-header';

describe('quote header', () => {
  it('renders Name <email> escaped in the reply line', () => {
    const h = buildQuoteHeader({
      mode: 'reply',
      email: { from: { name: 'Alice', email: 'a@b.com' }, receivedAt: '2026-04-27T10:00:00Z' },
      timeFormat: '24h',
      unknownLabel: 'Unknown',
    });
    expect(h.wrapInBlockquote).toBe(true);
    expect(h.html).toMatch(/^<div>On .+, Alice &lt;a@b\.com&gt; wrote:<br><\/div>$/);
    expect(h.text).toMatch(/Alice <a@b\.com> wrote:\n$/);
  });

  it('uses localized labels', () => {
    const h = buildQuoteHeader({
      mode: 'forward',
      email: { from: { email: 'a@b.com' }, subject: 'S' },
      timeFormat: '24h',
      unknownLabel: 'Unbekannt',
      labels: {
        replyLine: 'Am {date} schrieb {from}:',
        forwardedSeparator: '---------- Weitergeleitete Nachricht ----------',
        fromLabel: 'Von',
        dateLabel: 'Datum',
        subjectLabel: 'Betreff',
      },
    });
    expect(h.wrapInBlockquote).toBe(false);
    expect(h.html).toContain('Weitergeleitete Nachricht');
    expect(h.html).toContain('Von: a@b.com<br>Datum: <br>Betreff: S');
  });

  it('collapses the date when unknown', () => {
    const h = buildQuoteHeader({ mode: 'reply', email: { from: { email: 'a@b.com' } }, timeFormat: '24h', unknownLabel: 'U' });
    expect(h.html).toBe('<div>a@b.com wrote:<br></div>');
    expect(formatQuoteSender(undefined, 'U')).toBe('U');
  });
});

describe('formatQuoteDate', () => {
  it('writes the time in the chosen zone in the language\'s pattern', () => {
    const iso = '2026-04-28T23:30:00Z';
    expect(formatQuoteDate(iso, '24h', 'en', { timeZone: 'UTC' })).toBe('Tue, Apr 28, 2026, 23:30');
    expect(formatQuoteDate(iso, '24h', 'en', { timeZone: 'Asia/Tokyo' })).toBe('Wed, Apr 29, 2026, 08:30');
    // Worded: the region does not reorder it.
    expect(formatQuoteDate(iso, '24h', 'en', { timeZone: 'UTC', dateLocale: 'en-GB' })).toBe('Tue, Apr 28, 2026, 23:30');
    expect(formatQuoteDate(iso, '24h', 'cs', { timeZone: 'UTC', dateLocale: 'en-GB' })).toMatch(/^út 28\. dubna 2026/);
    expect(formatQuoteDate(iso, '24h', 'fa', { timeZone: 'UTC', dateLocale: 'en-GB' })).toContain('آوریل');
  });

  it('puts the zone into the reply line', () => {
    const h = buildQuoteHeader({
      mode: 'reply',
      email: { from: { email: 'a@b.com' }, receivedAt: '2026-04-28T23:30:00Z' },
      timeFormat: '24h',
      unknownLabel: 'Unknown',
      region: { timeZone: 'Asia/Tokyo' },
    });
    expect(h.text).toContain('Wed, Apr 29, 2026, 08:30');
  });
});
