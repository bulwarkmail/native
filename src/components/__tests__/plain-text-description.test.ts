// "Plain text only" also makes the app show received mail as plain text
// (plain-text-reading.test.ts), but Settings > Composing described it with
// the webmail's text, which only talks about sending.
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('expo-localization', () => ({ getLocales: () => [] }));

import { translate } from '../../i18n';

function description(rel: string): string {
  const source = fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');
  const m = /t\('(settings\.email_behavior\.plain_text_mode\.[a-z_]+)', (['"])(.*?)\2\)/.exec(
    source.slice(source.indexOf("plain_text_mode.label")),
  );
  if (!m) throw new Error(`no plain_text_mode description in ${rel}`);
  return translate('en', m[1], m[3]);
}

describe('the plain text only setting', () => {
  it('mentions reading in Composing as well as in Reading', () => {
    expect(description('settings/ComposingSettings.tsx')).toMatch(/\bread\b/i);
    expect(description('settings/ReadingSettings.tsx')).toMatch(/\bread\b/i);
  });
});
