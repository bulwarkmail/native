import { describe, expect, it } from 'vitest';
import { STALWART_VACATION_LIMITS, utf8Length, vacationOversize } from '../vacation-limits';

describe('vacationOversize', () => {
  const limits = STALWART_VACATION_LIMITS;

  it('flags a subject of 512 bytes and a body of 2048 bytes, not one byte less', () => {
    expect(vacationOversize({ subject: 'a'.repeat(511), textBody: 'b'.repeat(2047), htmlBody: null }, limits))
      .toEqual({ subject: false, body: false });
    expect(vacationOversize({ subject: 'a'.repeat(512), textBody: 'b'.repeat(2048), htmlBody: null }, limits))
      .toEqual({ subject: true, body: true });
  });

  it('counts bytes, not characters, and the HTML part with its formatting', () => {
    // 256 umlauts are 512 bytes.
    expect(vacationOversize({ subject: 'ä'.repeat(256), textBody: '', htmlBody: null }, limits).subject).toBe(true);
    expect(vacationOversize({ subject: '', textBody: 'short', htmlBody: `<p>${'x'.repeat(2045)}</p>` }, limits).body).toBe(true);
  });

  it('says nothing for a server without known limits', () => {
    expect(vacationOversize({ subject: 'a'.repeat(9000), textBody: '', htmlBody: null }, null))
      .toEqual({ subject: false, body: false });
  });

  it('measures UTF-8 like the server', () => {
    expect(utf8Length('aä€😀')).toBe(1 + 2 + 3 + 4);
  });
});
