import { describe, it, expect } from 'vitest';
import { buildQuoteHeader, formatQuoteSender } from '../quote-header';

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

  // Webmail 1.21: the forward header lists To and Cc, as Gmail and Outlook do.
  it('lists To and Cc in a forward header', () => {
    const h = buildQuoteHeader({
      mode: 'forward',
      email: {
        from: { email: 'a@b.com' },
        subject: 'S',
        to: [{ name: 'Bob', email: 'bob@x.com' }, { email: 'carol@x.com' }],
        cc: [{ name: 'dave@x.com', email: 'dave@x.com' }],
      },
      timeFormat: '24h',
      unknownLabel: 'U',
    });
    expect(h.html).toContain('Subject: S<br>To: Bob &lt;bob@x.com&gt;, carol@x.com<br>Cc: dave@x.com<br><br></div>');
    expect(h.text).toContain('Subject: S\nTo: Bob <bob@x.com>, carol@x.com\nCc: dave@x.com\n');
  });

  it('leaves out an empty Cc line and a reply keeps its one line', () => {
    const email = { from: { email: 'a@b.com' }, subject: 'S', to: [{ email: 'bob@x.com' }], cc: [] };
    const fwd = buildQuoteHeader({ mode: 'forward', email, timeFormat: '24h', unknownLabel: 'U' });
    expect(fwd.text).toContain('To: bob@x.com\n');
    expect(fwd.text).not.toContain('Cc:');
    const reply = buildQuoteHeader({ mode: 'reply', email, timeFormat: '24h', unknownLabel: 'U' });
    expect(reply.text).not.toContain('To:');
  });

  it('collapses the date when unknown', () => {
    const h = buildQuoteHeader({ mode: 'reply', email: { from: { email: 'a@b.com' } }, timeFormat: '24h', unknownLabel: 'U' });
    expect(h.html).toBe('<div>a@b.com wrote:<br></div>');
    expect(formatQuoteSender(undefined, 'U')).toBe('U');
  });
});
