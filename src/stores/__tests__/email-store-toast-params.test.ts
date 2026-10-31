// The toasts the email store raises fill every placeholder their catalog text
// has. Moving several emails to a folder without a name read
// "{count} emails moved": the call passed no count, and the catalog text
// (the webmail's notifications.emails_moved) wins over the fallback.
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('expo-localization', () => ({ getLocales: () => [] }));

import { getDictionary, translate } from '../../i18n';

const SOURCE = path.resolve(__dirname, '../email-store.ts');

function flatten(obj: Record<string, unknown>, prefix = '', out = new Map<string, string>()): Map<string, string> {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') flatten(v as Record<string, unknown>, key, out);
    else if (typeof v === 'string') out.set(key, v);
  }
  return out;
}

// t('key', 'fallback') closed right after the fallback: no values passed.
const CALL_WITHOUT_VALUES = /\bt\(\s*'([^']+)'\s*,\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`[^`]*`)\s*,?\s*\)/g;
const PLACEHOLDER = /(?<!\{)\{\s*\w+\s*[,}]/;

describe('email store toasts', () => {
  it('pass values for every catalog text with a placeholder', () => {
    const en = flatten(getDictionary('en') as Record<string, unknown>);
    const source = fs.readFileSync(SOURCE, 'utf8');
    const offenders = [...source.matchAll(CALL_WITHOUT_VALUES)]
      .map((m) => ({ key: m[1], text: en.get(m[1]) }))
      .filter(({ text }) => !!text && PLACEHOLDER.test(text))
      .map(({ key, text }) => `${key} = ${text}`);
    expect(offenders).toEqual([]);
  });

  it('reads the moved count in the catalog text', () => {
    expect(translate('en', 'notifications.emails_moved', 'Emails moved', { count: 3 })).toBe('3 emails moved');
    expect(PLACEHOLDER.test('{count} emails moved')).toBe(true);
    expect([..."t('notifications.emails_moved', 'Emails moved')".matchAll(CALL_WITHOUT_VALUES)]).toHaveLength(1);
    expect([..."t('notifications.emails_moved', `${count} emails moved`, { count })".matchAll(CALL_WITHOUT_VALUES)]).toHaveLength(0);
  });
});
