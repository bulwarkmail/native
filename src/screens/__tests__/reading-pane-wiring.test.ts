import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// #93: with Settings > Layout > Reading pane off, the mail screens keep the
// phone's single pane on a wide window; #104: with it on, they split only
// where the reader keeps room. No React Native renderer in the test env, so
// this checks the wiring; mailLayoutFor has unit tests in
// lib/__tests__/use-layout.test.ts.

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '..', '..', rel), 'utf8');
const READING_PANE = /const readingPane = useSettingsStore\(\(s\) => s\.readingPane\);/;

describe('reading pane setting wiring', () => {
  it('drives the Mail tab, the unified views and the mail list', () => {
    expect(read('screens/MailTab.tsx')).toMatch(READING_PANE);
    expect(read('screens/UnifiedInboxScreen.tsx')).toMatch(READING_PANE);
    expect(read('lib/use-mail-layout.ts')).toMatch(/const readingPane = useSettingsStore\(\(s\) => s\.readingPane\);/);
    expect(read('lib/use-layout.ts')).toMatch(/const layout = readingPane === 'auto' \? auto : mailLayoutFor\(window, readingPane, contentWidth\);/);
    // The Mail tab goes by its own width, right of the tab rail (#104); the
    // unified views are stack screens, without the rail...
    const tab = read('screens/MailTab.tsx');
    expect(tab).toMatch(/const layout = useMailLayout\(true\);/);
    expect(tab).toMatch(/<View style=\{styles\.row\} onLayout=\{layout\.onLayout\}>/);
    expect(read('screens/UnifiedInboxScreen.tsx')).toMatch(/const layout = useMailLayout\(false\);/);
    // ...and the list places its undo bar by the tab's decision...
    expect(tab).toMatch(/split=\{layout\.isSplit\}/);
    const list = read('screens/EmailListScreen.tsx');
    expect(list).toMatch(/split: isSplit = false,/);
    // ...but reports its column to the push prompt by the window, which the
    // prompt goes by: else the prompt drops to the corner over the reader.
    expect(list).toMatch(/if \(!windowLayout\.isSplit \|\| !isFocused\) \{\s+setPromptListColumn\(null\);/);
  });

  it('draws the mail screens only once the stored setting is known', () => {
    expect(read('lib/use-mail-layout.ts')).toMatch(/mailScreenLayoutFor\(window, contentWidth, readingPane, hydrated\)/);
    expect(read('lib/use-mail-layout.ts')).toMatch(/const hydrated = useSettingsStore\(\(s\) => s\.hydrated\);/);
    expect(read('screens/MailTab.tsx')).toMatch(/if \(!layout\.ready\) return <View style=\{styles\.row\} onLayout=\{layout\.onLayout\} \/>;\r?\n\r?\n(\s*\/\/.*\r?\n)*  return \(\r?\n    <View style=\{styles\.row\} onLayout=\{layout\.onLayout\}>/);
    expect(read('screens/UnifiedInboxScreen.tsx')).toMatch(/if \(!layout\.ready\) return <View style=\{styles\.container\} onLayout=\{layout\.onLayout\} \/>;\r?\n\r?\n  if \(!layout\.isSplit\) \{/);
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
    expect(read('stores/settings-store.ts')).toMatch(/'swipeMode',\r?\n  'readingPane',\r?\n/);
  });
});
