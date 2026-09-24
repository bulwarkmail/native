// Scripts written by the webmail must survive a save on the phone: parsing
// them into rules and generating the script again has to give back the same
// rules and the same Sieve the webmail would write, or saving filters on the
// phone would silently change what the server does (switch the auto-reply
// off, drop folder ids, let spam into folders...). See
// fixtures/webmail/index.ts for where the scripts come from.
import { describe, it, expect } from 'vitest';
import { generateScript } from '../generator';
import { parseScript } from '../parser';
import { readWebmailFixture, readWebmailResave, WEBMAIL_FIXTURES } from './fixtures/webmail';

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
