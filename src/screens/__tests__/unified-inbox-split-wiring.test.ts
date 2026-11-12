import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// #97: on a wide window the unified views open a message next to the list,
// as the Mail tab does, instead of always pushing the full-screen viewer. No
// React Native renderer in the test env, so this checks the wiring; the
// removal helper has unit tests in lib/__tests__/use-message-pane.test.ts.

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '..', '..', rel), 'utf8');

describe('unified inbox split view wiring', () => {
  const src = read('screens/UnifiedInboxScreen.tsx');

  it('opens a message in the pane on a wide window and on the stack otherwise', () => {
    expect(src).toMatch(/const pane = useMessagePane\(navigation, layout\.isSplit, windowLayout\.isSplit\);/);
    expect(src).toMatch(/if \(layout\.isSplit\) \{\s+showInPane\(\{ params, rowKey: rowKey\(email\), index: /);
    expect(src).toMatch(/\} else \{\s+navigation\.navigate\('EmailThread', params\);/);
  });

  it('draws the list and the pane side by side, like the Mail tab', () => {
    // Only the list keeps clear of the top edge: the viewer does that itself.
    expect(src).toMatch(/<SafeAreaView style=\{\[styles\.listPane, \{ width: listPaneWidth\(width\) \}\]\} edges=\{\['top', 'left'\]\}>\s+\{listColumn\}/);
    expect(src).toMatch(/<MessagePane\s+message=\{pane\.open\}/);
    const mailTab = read('screens/MailTab.tsx');
    expect(mailTab).toMatch(/const pane = useMessagePane\(navigation, layout\.isSplit, windowLayout\.isSplit\);/);
    expect(mailTab).toMatch(/<MessagePane\s+message=\{pane\.open\}/);
  });

  it('marks the open row as the folder list does', () => {
    expect(src).toMatch(/const isActive = layout\.isSplit && pane\.activeKey === rowKey\(item\);/);
    expect(src).toMatch(/isActive && styles\.rowActive,/);
  });

  it('keeps the list in place when opening a message switches account', () => {
    expect(src).toMatch(/const allAccountIds = accounts\.map\(\(a\) => a\.id\)\.join\('\\n'\);/);
    expect(src).toMatch(/const scopeAccountId = crossAccount \? null : activeAccountId;/);
    expect(src).toMatch(/\}, \[allAccountIds, scopeAccountId\]\);/);
  });

  it('empties the pane before switching account', () => {
    expect(src).toMatch(/closePane\(\);\s+await switchAccount\(email\.sourceAccountId\);/);
  });

  it('refreshes the rows quietly while a message is open in the pane', () => {
    expect(src).toMatch(/else if \(paneRef\.current\) void load\(\{ quiet: true \}\);/);
    expect(src).toMatch(/if \(!opts\?\.quiet\) setLoading\(true\);/);
    // ...without dropping the pages loaded after the first.
    expect(src).toMatch(/const limit = opts\?\.quiet \? Math\.max\(PAGE_SIZE, \.\.\.Object\.values\(positionsRef\.current\)\) : PAGE_SIZE;/);
    expect(src).toMatch(/fetchUnifiedInbox\(accountIds, limit, \{ \.\.\.fetchOpts, positions: \{\} \}\)/);
  });

  it('moves on within the same account after a removal', () => {
    expect(src).toMatch(/const next = rowAfterRemoval\(rows, current, rowKey, sameAccount\);/);
  });
});
