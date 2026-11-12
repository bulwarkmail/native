// Dutch addresses the reader as "je", in one form throughout. The phone's
// own strings mixed "u/uw" (about a third of them) with "je/jouw".
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const NL = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'locales', 'rn', 'nl.json'), 'utf8')) as Record<string, unknown>;

function strings(obj: Record<string, unknown>, prefix = '', out: Array<[string, string]> = []): Array<[string, string]> {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') out.push([key, v]);
    else if (v && typeof v === 'object' && !Array.isArray(v)) strings(v as Record<string, unknown>, key, out);
  }
  return out;
}

// "u" after a number is the hour ("{count} u geleden"), not the pronoun.
const FORMAL = /(?<!\}\s)\b(u|uw)\b/i;

describe('Dutch phone strings', () => {
  it('say "je", not "u"', () => {
    expect(strings(NL).filter(([, text]) => FORMAL.test(text)).map(([key]) => key)).toEqual([]);
  });

  it('still read "u" after a number as hours', () => {
    expect(FORMAL.test('{count} u geleden')).toBe(false);
    expect(FORMAL.test('Weet u het zeker?')).toBe(true);
  });
});
