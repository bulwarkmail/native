import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// #93: with Settings > Layout > Reading pane off, the mail screens keep the
// phone's single pane on a wide window; #104: with it on, they split only
// where the reader keeps room. No React Native renderer in the test env, so
// this checks the wiring; mailLayoutFor has unit tests in
// lib/__tests__/use-layout.test.ts.

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '..', '..', rel), 'utf8');
const MAIL_LAYOUT = /mailLayoutFor\(useLayout\(\), readingPane, width\)/;
const READING_PANE = /const readingPane = useSettingsStore\(\(s\) => s\.readingPane\);/;

describe('reading pane setting wiring', () => {
  it('drives the Mail tab, the unified views and the mail list', () => {
    for (const screen of ['screens/MailTab.tsx', 'screens/UnifiedInboxScreen.tsx']) {
      expect(read(screen)).toMatch(READING_PANE);
      expect(read(screen)).toMatch(MAIL_LAYOUT);
    }
    // The Mail tab goes by its own width, which leaves out the tab rail (#104)...
    const tab = read('screens/MailTab.tsx');
    expect(tab).toMatch(/onLayout=\{\(e\) => setTabWidth\(Math\.round\(e\.nativeEvent\.layout\.width\)\)\}/);
    expect(tab).toMatch(/const width = tabWidth \|\| windowWidth;/);
    // ...and the list places its undo bar by the tab's decision...
    expect(tab).toMatch(/split=\{layout\.isSplit\}/);
    const list = read('screens/EmailListScreen.tsx');
    expect(list).toMatch(/split: isSplit = false,/);
    // ...but reports its column to the push prompt by the window, which the
    // prompt goes by: else the prompt drops to the corner over the reader.
    expect(list).toMatch(/if \(!windowLayout\.isSplit \|\| !isFocused\) \{\s+setPromptListColumn\(null\);/);
  });

  it('lets the open message go when the setting turned the split off, and keeps it when the room did', () => {
    for (const screen of ['screens/MailTab.tsx', 'screens/UnifiedInboxScreen.tsx']) {
      expect(read(screen)).toMatch(/useMessagePane\(navigation, layout\.isSplit, readingPane === 'off'\)/);
    }
    expect(read('lib/use-message-pane.ts')).toMatch(/if \(!turnedOff\) navigation\.navigate\('EmailThread', openRef\.current\.params\);\s+close\(\);/);
  });

  it('is offered under Settings > Layout', () => {
    const src = read('components/settings/LayoutSettings.tsx');
    expect(src).toMatch(/onChange=\{\(v\) => update\('readingPane', v as ReadingPane\)\}/);
    expect(src).toMatch(/\{ value: 'off',\s+label: t\('settings\.layout\.reading_pane\.off'/);
  });

  it('stays on this device', () => {
    expect(read('stores/settings-store.ts')).toMatch(/'swipeMode',\n  'readingPane',\n/);
  });
});
