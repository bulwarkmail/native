import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// The organisation's archiveActionEnabled gate (webmail lib/archive-gate.ts,
// email-list.tsx, email-viewer.tsx, downloads-settings.tsx): off, no swipe,
// selection bar, reader toolbar, quick action, more-menu or after-export
// Archive. No React Native renderer in the test env, so this checks the
// wiring; the helpers have unit tests in lib/__tests__/swipe-actions.test.ts.

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '..', '..', rel), 'utf8');

describe('archive gate wiring', () => {
  it('drops a stored Archive swipe and the selection Archive in the folder list', () => {
    const src = read('screens/EmailListScreen.tsx');
    expect(src).toMatch(/const archiveEnabled = usePolicyFeature\('archiveActionEnabled'\);/);
    expect(src).toMatch(/const swipeLeftAction = swipeActionShown\(useSettingsStore\(\(s\) => s\.swipeLeftAction\), archiveEnabled\);/);
    expect(src).toMatch(/const swipeRightAction = swipeActionShown\(useSettingsStore\(\(s\) => s\.swipeRightAction\), archiveEnabled\);/);
    expect(src).toMatch(/const canArchiveSelection =\s+archiveEnabled && /);
  });

  it('drops them in the unified inbox', () => {
    const src = read('screens/UnifiedInboxScreen.tsx');
    expect(src).toMatch(/const archiveEnabled = usePolicyFeature\('archiveActionEnabled'\);/);
    expect(src).toMatch(/const swipeLeftAction = swipeActionShown\(useSettingsStore\(\(s\) => s\.swipeLeftAction\), archiveEnabled\);/);
    expect(src).toMatch(/const swipeRightAction = swipeActionShown\(useSettingsStore\(\(s\) => s\.swipeRightAction\), archiveEnabled\);/);
    expect(src).toMatch(/\{archiveEnabled && role !== 'archive' && \(\s+<Pressable\s+onPress=\{\(\) => \{ void archive\(selectedEmails\)/);
    expect(src).toMatch(/case 'archive': if \(archiveEnabled && role !== 'archive'\)/);
  });

  it('drops the reader Archive button, quick action and menu entry', () => {
    const src = read('screens/EmailThreadScreen.tsx');
    expect(src).toMatch(/bottomQuickActionsFor\(bottomQuickActionsRaw, archiveEnabled\)/);
    expect(src).not.toMatch(/normalizeBottomQuickActions\(bottomQuickActionsRaw\)/);
    // canArchive feeds the toolbar button, the quick action, the more menu
    // and the after-export move.
    expect(src).toMatch(/const canArchive = archiveEnabled && !!archiveMailbox/);
  });

  it('offers no move to archive after an export', () => {
    const src = read('components/settings/DownloadsSettings.tsx');
    expect(src).toMatch(/archiveEnabled \|\| storedPostExportAction !== 'archive' \? storedPostExportAction : 'keep'/);
    expect(src).toMatch(/\.\.\.\(archiveEnabled \? \[\{ value: 'archive'/);
  });
});
