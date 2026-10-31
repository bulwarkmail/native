// The tag picker's header read "1 emails selected": it used the webmail's
// context_menu.items_selected ("{count} emails selected"), which has no
// singular since the webmail shows it for several emails only.
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('expo-localization', () => ({ getLocales: () => [] }));

import { translate } from '../../i18n';

const source = fs.readFileSync(path.resolve(__dirname, '../TagSheet.tsx'), 'utf8');
// The key and, when it is a literal, the English fallback.
const call = /t\('(context_menu\.[a-z_]+)', (?:'([^']*)'|`[^`]*`), \{ count: selectedEmails\.length \}\)/.exec(source);

describe('the tag picker header', () => {
  it('counts the selection with a plural', () => {
    expect(call).not.toBeNull();
    const [, key, fallback] = call!;
    expect(translate('en', key, fallback, { count: 1 })).toBe('1 email selected');
    expect(translate('en', key, fallback, { count: 3 })).toBe('3 emails selected');
    expect(translate('de', key, fallback, { count: 1 })).toBe('1 E-Mail ausgewählt');
  });
});
