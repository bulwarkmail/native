// German addresses the user formally, as the webmail does (7b720dd22). The
// phone's own strings still said "du" in a dozen places (privacy, backup,
// licences, the identities summary), and the reader's Prev/Next read
// "Zurück"/"Weiter" (back/continue, U-045).
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('expo-localization', () => ({ getLocales: () => [] }));

import { translate } from '../index';

const DE = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'locales', 'rn', 'de.json'), 'utf8')) as Record<string, unknown>;

function strings(obj: Record<string, unknown>, prefix = '', out: Array<[string, string]> = []): Array<[string, string]> {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') out.push([key, v]);
    else if (v && typeof v === 'object' && !Array.isArray(v)) strings(v as Record<string, unknown>, key, out);
    // Arrays are word lists for detection (placeholder words), not UI text.
  }
  return out;
}

const INFORMAL = /\b(du|dich|dir|dein|deine|deinen|deinem|deiner|deines)\b|(?:^|[.!?]\s+)(Öffne|Tippe|Wähle|Prüfe|Übertrage)\s/i;

describe('German phone strings', () => {
  it('say "Sie", not "du"', () => {
    expect(strings(DE).filter(([, text]) => INFORMAL.test(text)).map(([key]) => key)).toEqual([]);
  });

  it('call the reader\'s Prev and Next "Vorherige" and "Nächste" (U-045)', () => {
    expect(translate('de', 'email_viewer.previous')).toBe('Vorherige');
    expect(translate('de', 'email_viewer.next')).toBe('Nächste');
    expect(translate('en', 'email_viewer.previous')).toBe('Prev');
  });
});
