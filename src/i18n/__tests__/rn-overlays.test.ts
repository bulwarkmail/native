// The RN-only overlays of the other languages translate locales/rn/en.json.
// Every key they carry must exist in English, be a non-empty string and use
// the same ICU arguments, or t() would render a stale key or drop a value.
// A key a language has not translated yet is fine: it falls back to English.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('expo-localization', () => ({ getLocales: () => [] }));

import { SUPPORTED_LOCALES } from '../index';

const RN_DIR = join(__dirname, '..', '..', '..', 'locales', 'rn');

function flatten(obj: Record<string, unknown>, prefix = '', out = new Map<string, unknown>()): Map<string, unknown> {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v as Record<string, unknown>, key, out);
    else out.set(key, v);
  }
  return out;
}

function readOverlay(code: string): Map<string, unknown> {
  return flatten(JSON.parse(readFileSync(join(RN_DIR, `${code}.json`), 'utf8')) as Record<string, unknown>);
}

// Argument names a message uses: `{name}` and `{count, plural, …}`. The word
// in a plural branch (`one {item}`) is text, not an argument.
function argumentsOf(message: string): string[] {
  const names = new Set<string>();
  for (const m of message.matchAll(/(?<!\b(?:zero|one|two|few|many|other)\s*|=\d+\s*)\{\s*(\w+)\s*[,}]/g)) {
    names.add(m[1]);
  }
  return [...names].sort();
}

describe('RN overlay translations', () => {
  const en = readOverlay('en');

  it('finds the arguments of plain and plural messages', () => {
    expect(argumentsOf('Hello {name}')).toEqual(['name']);
    expect(argumentsOf('{count, plural, one {# item} other {# items}} in {folder}')).toEqual(['count', 'folder']);
    expect(argumentsOf('{count, plural, =0 {none} one {{count} day} other {{count} days}}')).toEqual(['count']);
  });

  for (const { code } of SUPPORTED_LOCALES) {
    if (code === 'en') continue;
    it(`${code} only translates English keys, keeping their arguments`, () => {
      const problems: string[] = [];
      for (const [key, value] of readOverlay(code)) {
        const english = en.get(key);
        if (typeof english !== 'string') {
          problems.push(`${key}: not in locales/rn/en.json`);
          continue;
        }
        if (typeof value !== 'string' || !value.trim()) {
          problems.push(`${key}: empty or not a string`);
          continue;
        }
        const want = argumentsOf(english).join(', ');
        const got = argumentsOf(value).join(', ');
        if (want !== got) problems.push(`${key}: arguments {${got}} instead of {${want}}`);
      }
      expect(problems).toEqual([]);
    });
  }
});
