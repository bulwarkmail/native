// Scripts written by the webmail must survive a save on the phone: parsing
// them into rules and generating the script again has to give back the same
// rules and the same Sieve the webmail would write, or saving filters on the
// phone would silently change what the server does (switch the auto-reply
// off, drop folder ids, let spam into folders...). See
// fixtures/webmail/index.ts for where the scripts come from.
import { describe, it, expect } from 'vitest';
import { generateScript } from '../generator';
import { parseScript } from '../parser';
import { readWebmailFixture, readWebmailResave, STALWART_EXTENSIONS, WEBMAIL_FIXTURES } from './fixtures/webmail';

function metadataRules(script: string): unknown[] {
  const match = script.match(/@metadata:begin\n(.*)\n@metadata:end/);
  return JSON.parse(match![1]).rules;
}

// Blank lines carry no meaning in Sieve.
function withoutBlankLines(script: string): string {
  return script.split('\n').filter((line) => line.trim() !== '').join('\n');
}

describe('scripts written by the webmail', () => {
  for (const { file, extensions } of WEBMAIL_FIXTURES) {
    describe(file, () => {
      const script = readWebmailFixture(file);
      const parsed = parseScript(script);
      const regenerated = generateScript(parsed.rules, parsed.vacation, {
        externalRequires: parsed.externalRequires,
        includeVacation: parsed.includeVacation,
        vacationForward: parsed.vacationForward,
        vacationAudience: parsed.vacationAudience,
        extensions,
      });

      it('parses into the rules the webmail stored', () => {
        expect(parsed.isOpaque).toBe(false);
        const bulwark = parsed.rules.filter((r) => !r.origin || r.origin === 'bulwark');
        expect(bulwark).toEqual(metadataRules(script));
      });

      it('saves back what the webmail would save', () => {
        expect(regenerated).toBe(readWebmailResave(file));
      });

      it('saves back the same script', () => {
        expect(withoutBlankLines(regenerated)).toBe(withoutBlankLines(script));
        expect(parseScript(regenerated).rules).toEqual(parsed.rules.map((r) =>
          r.rawBlock ? { ...r, rawBlock: expect.any(String) } : r));
      });
    });
  }
});

describe('a version 2 script written by webmail 1.13.0', () => {
  const file = 'v2-period-forward-audience.sieve';
  const script = readWebmailFixture(file);
  const parsed = parseScript(script);

  it('reads the forwarding and the reply audience back', () => {
    expect(parsed.isOpaque).toBe(false);
    expect(parsed.includeVacation).toBe(true);
    expect(parsed.vacationForward).toEqual({
      enabled: true,
      to: 'colleague@example.com',
      keepCopy: true,
      activeFrom: '2026-10-05T06:00:00.000Z',
      activeUntil: '2026-10-16T16:00:00.000Z',
    });
    expect(parsed.vacationAudience).toEqual({ only: 'internal', domains: ['example.com', 'example.org'] });
    // The forwarding block is Bulwark's, not someone else's rule.
    expect(parsed.rules.every((r) => (r.origin ?? 'bulwark') === 'bulwark')).toBe(true);
  });

  it('keeps every rule period', () => {
    const periods = parsed.rules.map((r) => [r.id, r.activeFrom, r.activeUntil]);
    expect(periods).toEqual([
      ['trip', '2026-10-05T06:00:00.000Z', '2026-10-16T16:00:00.000Z'],
      ['news', '2026-11-01T00:00:00.000Z', undefined],
      ['later', undefined, '2026-12-31T23:00:00.000Z'],
      ['boss', undefined, undefined],
    ]);
  });

  it('comes back byte for byte after a parse and a generate', () => {
    expect(generateScript(parsed.rules, parsed.vacation, {
      externalRequires: parsed.externalRequires,
      includeVacation: parsed.includeVacation,
      vacationForward: parsed.vacationForward,
      vacationAudience: parsed.vacationAudience,
      extensions: STALWART_EXTENSIONS,
    })).toBe(script);
  });

  it('is left alone when a period, the forwarding or the audience cannot be read', () => {
    for (const [from, to] of [
      ['"activeFrom":"2026-11-01T00:00:00.000Z"', '"activeFrom":"2026-11-01T00:00"'],
      ['"activeUntil":"2026-12-31T23:00:00.000Z"', '"activeUntil":null'],
      ['"to":"colleague@example.com"', '"to":"colleague"'],
      ['"only":"internal"', '"only":"everyone"'],
    ]) {
      expect(script).toContain(from);
      expect(parseScript(script.replace(from, to)).isOpaque).toBe(true);
    }
  });
});
