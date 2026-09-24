// Scripts written by the webmail must survive a save on the phone: parsing
// them into rules and generating the script again has to give back the same
// rules and the same Sieve, or saving filters on the phone would silently
// change what the server does (switch the auto-reply off, drop folder ids,
// let spam into folders...).
//
// The fixtures in fixtures/webmail/ were written by the webmail's own
// generator (jmap-webmail lib/sieve/generator.ts at e33ab899), run on the
// rules in each file's metadata.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateScript } from '../generator';
import { parseScript } from '../parser';

interface WebmailFixture {
  file: string;
}

const FIXTURES: WebmailFixture[] = [
  { file: 'vacation-include.sieve' },
];

function readFixture(file: string): string {
  // Git may check the fixture out with CRLF line ends on Windows.
  return readFileSync(join(__dirname, 'fixtures', 'webmail', file), 'utf-8').replace(/\r\n/g, '\n');
}

function metadataRules(script: string): unknown[] {
  const match = script.match(/@metadata:begin\n(.*)\n@metadata:end/);
  return JSON.parse(match![1]).rules;
}

describe('scripts written by the webmail', () => {
  for (const { file } of FIXTURES) {
    describe(file, () => {
      const script = readFixture(file);
      const parsed = parseScript(script);

      it('parses into the rules the webmail stored', () => {
        expect(parsed.isOpaque).toBe(false);
        const bulwark = parsed.rules.filter((r) => !r.origin || r.origin === 'bulwark');
        expect(bulwark).toEqual(metadataRules(script));
      });

      it('saves back unchanged', () => {
        const regenerated = generateScript(parsed.rules, parsed.vacation, {
          externalRequires: parsed.externalRequires,
          includeVacation: parsed.includeVacation,
        });
        expect(regenerated).toBe(script);
      });
    });
  }
});
