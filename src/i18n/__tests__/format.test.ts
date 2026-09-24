import { describe, it, expect, vi } from 'vitest';
import { builtinPluralCategory, formatMessage, pluralCategory } from '../format';

describe('formatMessage', () => {
  it('substitutes simple arguments', () => {
    expect(formatMessage('Hello {name}!', { name: 'Ada' }, 'en')).toBe('Hello Ada!');
    expect(formatMessage('{a} and {b}', { a: 1, b: 'two' }, 'en')).toBe('1 and two');
  });

  it('leaves unknown placeholders untouched so legacy .replace() callers still work', () => {
    expect(formatMessage('Failed to upload {filename}', {}, 'en')).toBe('Failed to upload {filename}');
    expect(formatMessage('Failed to upload {filename}', undefined, 'en')).toBe('Failed to upload {filename}');
    expect(formatMessage('{a} {b}', { a: 'x' }, 'en')).toBe('x {b}');
  });

  it('formats ICU plurals with # substitution', () => {
    const msg = '{count, plural, one {1 email} other {# emails}} selected';
    expect(formatMessage(msg, { count: 1 }, 'en')).toBe('1 email selected');
    expect(formatMessage(msg, { count: 5 }, 'en')).toBe('5 emails selected');
    expect(formatMessage(msg, { count: 0 }, 'en')).toBe('0 emails selected');
  });

  it('prefers exact =N branches', () => {
    const msg = '{count, plural, =0 {No attendees} one {# attendee} other {# attendees}}';
    expect(formatMessage(msg, { count: 0 }, 'en')).toBe('No attendees');
    expect(formatMessage(msg, { count: 1 }, 'en')).toBe('1 attendee');
    expect(formatMessage(msg, { count: 2 }, 'en')).toBe('2 attendees');
  });

  it('uses locale plural rules when available', () => {
    // Russian: 1 → one, 2 → few, 5 → many
    const msg = '{count, plural, one {# письмо} few {# письма} many {# писем} other {# письма}}';
    expect(formatMessage(msg, { count: 1 }, 'ru')).toBe('1 письмо');
    expect(formatMessage(msg, { count: 2 }, 'ru')).toBe('2 письма');
    expect(formatMessage(msg, { count: 5 }, 'ru')).toBe('5 писем');
  });

  it('handles nested arguments inside plural branches', () => {
    const msg = '{count, plural, one {{name} has # item} other {{name} has # items}}';
    expect(formatMessage(msg, { count: 3, name: 'Box' }, 'en')).toBe('Box has 3 items');
  });

  it('accepts numeric strings for plural arguments', () => {
    expect(formatMessage('{n, plural, one {one} other {many}}', { n: '1' }, 'en')).toBe('one');
  });

  it('returns the raw placeholder when a plural argument is missing', () => {
    const msg = '{count, plural, one {a} other {b}}';
    expect(formatMessage(msg, {}, 'en')).toBe(msg);
  });

  it('tolerates unbalanced braces', () => {
    expect(formatMessage('oops {name', { name: 'x' }, 'en')).toBe('oops {name');
  });
});

describe('pluralCategory', () => {
  it('follows English rules', () => {
    expect(pluralCategory(1, 'en')).toBe('one');
    expect(pluralCategory(0, 'en')).toBe('other');
    expect(pluralCategory(2, 'en')).toBe('other');
  });

  it('falls back to the English rule for unknown locales', () => {
    expect(pluralCategory(1, 'zz-not-a-locale')).toBe('one');
    expect(pluralCategory(7, 'zz-not-a-locale')).toBe('other');
  });
});

// The app's locales (src/i18n/index.ts SUPPORTED_LOCALES).
const APP_LOCALES = [
  'ar', 'ca', 'cs', 'sk', 'da', 'de', 'en', 'fa', 'es', 'fr', 'he', 'it', 'hu', 'lv',
  'nl', 'nb', 'pl', 'pt', 'ro', 'tr', 'ru', 'uk', 'ko', 'ja', 'mn', 'zh', 'zh-TW',
];

describe('builtinPluralCategory (Hermes has no Intl.PluralRules)', () => {
  // Sample numbers from the CLDR language plural rules chart.
  const CLDR_EXAMPLES: Record<string, Partial<Record<string, number[]>>> = {
    ru: { one: [1, 21, 31, 101, 1001], few: [2, 3, 4, 22, 24, 102, 1002], many: [0, 5, 11, 12, 14, 19, 20, 25, 100, 111, 1000], other: [0.5, 1.5, 10.1] },
    uk: { one: [1, 21, 101], few: [2, 4, 22, 104], many: [0, 5, 11, 14, 20, 100, 1000], other: [0.5, 1.5] },
    pl: { one: [1], few: [2, 3, 4, 22, 24, 102, 1002], many: [0, 5, 11, 12, 14, 19, 21, 25, 100, 112, 1000], other: [0.5, 1.5, 10.1] },
    cs: { one: [1], few: [2, 3, 4], many: [0.5, 1.5, 10.1], other: [0, 5, 19, 100, 1000] },
    sk: { one: [1], few: [2, 3, 4], many: [0.5, 1.5], other: [0, 5, 100] },
    lv: { zero: [0, 10, 11, 19, 20, 30, 100, 1000, 0.11], one: [1, 21, 31, 101, 0.1, 1.1, 0.01, 0.21], other: [2, 9, 22, 29, 102, 0.2, 0.02, 1.5] },
    ar: { zero: [0], one: [1], two: [2], few: [3, 10, 103, 110, 1003], many: [11, 26, 99, 111, 1011], other: [100, 101, 102, 200, 1000, 0.1, 1.5] },
    he: { one: [1, 0.5, 0.1], two: [2], other: [0, 3, 10, 17, 20, 100, 1000, 1.5] },
    ro: { one: [1], few: [0, 2, 16, 19, 101, 119, 1001, 0.5, 1.5], other: [20, 35, 100, 120, 1000] },
    fr: { one: [0, 1, 1.5], many: [1000000, 2000000], other: [2, 17, 100, 1000, 10000] },
    es: { one: [1], many: [1000000], other: [0, 2, 16, 100, 1000, 0.5, 1.5] },
    it: { one: [1], many: [1000000], other: [0, 2, 16, 100, 1.5] },
    ca: { one: [1], many: [1000000], other: [0, 2, 16, 100, 1.5] },
    pt: { one: [0, 1, 0.5, 1.5], many: [1000000], other: [2, 17, 100, 1000] },
    da: { one: [1, 0.1, 1.6], other: [0, 2, 16, 100, 2.5] },
    fa: { one: [0, 1, 0.5], other: [2, 17, 100, 1.5] },
    de: { one: [1], other: [0, 2, 16, 100, 1.5] },
    en: { one: [1], other: [0, 2, 16, 100, 1.5] },
    nl: { one: [1], other: [0, 2, 1.5] },
    hu: { one: [1], other: [0, 2, 1.5] },
    nb: { one: [1], other: [0, 2, 1.5] },
    tr: { one: [1], other: [0, 2, 1.5] },
    mn: { one: [1], other: [0, 2, 1.5] },
    ko: { other: [0, 1, 2, 1.5] },
    ja: { other: [0, 1, 2, 1.5] },
    zh: { other: [0, 1, 2, 1.5] },
    'zh-TW': { other: [0, 1, 2, 1.5] },
  };

  for (const [locale, categories] of Object.entries(CLDR_EXAMPLES)) {
    it(`follows the CLDR examples for ${locale}`, () => {
      for (const [category, samples] of Object.entries(categories)) {
        for (const n of samples ?? []) {
          expect(`${n} → ${builtinPluralCategory(n, locale)}`).toBe(`${n} → ${category}`);
        }
      }
    });
  }

  it('covers every app locale', () => {
    expect(Object.keys(CLDR_EXAMPLES).sort()).toEqual([...APP_LOCALES].sort());
  });

  it('agrees with the engine Intl.PluralRules for every app locale', () => {
    const samples: number[] = [];
    for (let n = 0; n <= 1200; n++) samples.push(n);
    samples.push(1000000, 2000000, 1234567, 10000000, -1, -2, -5);
    for (let d = 0; d <= 40; d++) samples.push(d / 10, d / 100 + 1, d / 100 + 20);
    const mismatches: string[] = [];
    for (const locale of APP_LOCALES) {
      const intl = new Intl.PluralRules(locale);
      for (const n of samples) {
        const expected = intl.select(n);
        const actual = builtinPluralCategory(n, locale);
        if (actual !== expected) mismatches.push(`${locale} ${n}: ${actual}, Intl says ${expected}`);
      }
    }
    expect(mismatches.slice(0, 20)).toEqual([]);
  });

  it('uses the English rule for languages it has no rule for', () => {
    expect(builtinPluralCategory(1, 'xx')).toBe('one');
    expect(builtinPluralCategory(2, 'xx')).toBe('other');
  });
});

describe('formatMessage without Intl.PluralRules', () => {
  it('picks the plural form from the built-in rules', async () => {
    const intl = Intl as unknown as { PluralRules: unknown };
    const original = intl.PluralRules;
    intl.PluralRules = undefined;
    try {
      vi.resetModules();
      const fresh = await import('../format');
      const msg = '{count, plural, one {# письмо} few {# письма} many {# писем} other {# письма}}';
      expect(fresh.formatMessage(msg, { count: 2 }, 'ru')).toBe('2 письма');
      expect(fresh.formatMessage(msg, { count: 5 }, 'ru')).toBe('5 писем');
      expect(fresh.formatMessage(msg, { count: 21 }, 'ru')).toBe('21 письмо');
      expect(fresh.pluralCategory(0, 'fr')).toBe('one');
    } finally {
      intl.PluralRules = original;
    }
  });
});
