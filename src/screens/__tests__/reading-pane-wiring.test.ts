import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// #93: with Settings > Layout > Reading pane off, the mail screens keep the
// phone's single pane on a wide window. No React Native renderer in the test
// env, so this checks the wiring; mailLayoutFor has unit tests in
// lib/__tests__/use-layout.test.ts.

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '..', '..', rel), 'utf8');
const MAIL_LAYOUT = /const layout = useMailLayout\((true|false)\);/;

describe('reading pane setting wiring', () => {
  it('drives the Mail tab, the unified views and the mail list', () => {
    expect(read('screens/MailTab.tsx')).toMatch(MAIL_LAYOUT);
    expect(read('screens/UnifiedInboxScreen.tsx')).toMatch(MAIL_LAYOUT);
    expect(read('lib/use-mail-layout.ts')).toMatch(/const layout = mailLayoutFor\(window, readingPane, contentWidth\);/);
    // The list places its undo bar by the same layout, which the tab hands it...
    expect(read('screens/MailTab.tsx')).toMatch(/split=\{layout\.isSplit\}/);
    const list = read('screens/EmailListScreen.tsx');
    expect(list).toMatch(/split: isSplit = false,/);
    // ...but reports its column to the push prompt by the window, which the
    // prompt goes by: else the prompt drops to the corner over the reader.
    expect(list).toMatch(/if \(!windowLayout\.isSplit \|\| !isFocused\) \{\s+setPromptListColumn\(null\);/);
  });

  it('lets the open message go when only the setting turned the split off', () => {
    for (const screen of ['screens/MailTab.tsx', 'screens/UnifiedInboxScreen.tsx']) {
      expect(read(screen)).toMatch(/useMessagePane\(navigation, layout\.isSplit, layout\.windowIsSplit\)/);
    }
    expect(read('lib/use-message-pane.ts')).toMatch(/if \(!windowIsSplit\) navigation\.navigate\('EmailThread', openRef\.current\.params\);\s+close\(\);/);
  });

  it('is offered under Settings > Layout', () => {
    const src = read('components/settings/LayoutSettings.tsx');
    expect(src).toMatch(/onChange=\{\(v\) => update\('readingPane', v as ReadingPane\)\}/);
    expect(src).toMatch(/\{ value: 'off',\s+label: t\('settings\.layout\.reading_pane\.off'/);
  });

  it('stays on this device', () => {
    expect(read('stores/settings-store.ts')).toMatch(/'swipeMode',\r?\n  'readingPane',\r?\n/);
  });
});
