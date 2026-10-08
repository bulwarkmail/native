import { describe, it, expect } from 'vitest';
import { STALWART_VACATION_LIMITS, utf8Length, vacationOversize } from '../vacation-limits';

const L = STALWART_VACATION_LIMITS;

describe('vacation limits', () => {
  it('uses Stalwart\'s limits', () => {
    expect(L).toEqual({ subject: 511, body: 2047 });
  });

  it('counts UTF-8 bytes, not characters', () => {
    expect(utf8Length('é')).toBe(2);
    expect(utf8Length('€')).toBe(3);
    expect(utf8Length('😀')).toBe(4);
  });

  it('counts multibyte text as bytes', () => {
    const ok = 'é'.repeat(255); // 510 bytes
    const over = 'é'.repeat(256); // 512 bytes
    expect(vacationOversize({ subject: ok, textBody: '', html: null }, L).subject).toBe(false);
    expect(vacationOversize({ subject: over, textBody: '', html: null }, L).subject).toBe(true);
    expect(vacationOversize({ subject: '', textBody: 'é'.repeat(1024), html: null }, L).body).toBe(true);
    expect(vacationOversize({ subject: '', textBody: 'é'.repeat(1023), html: null }, L).body).toBe(false);
  });

  it('counts the HTML body even when the text is short', () => {
    const html = `<p>${'a'.repeat(2100)}</p>`;
    expect(vacationOversize({ subject: '', textBody: 'hi', html }, L)).toEqual({ subject: false, body: true });
  });

  it('has no limits without Stalwart', () => {
    const big = 'x'.repeat(5000);
    expect(vacationOversize({ subject: big, textBody: big, html: big }, null)).toEqual({ subject: false, body: false });
  });
});
