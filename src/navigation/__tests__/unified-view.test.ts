import { describe, expect, it, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { isUnifiedViewShown, showMailFolders, showUnifiedView, useUnifiedView } from '../unified-view';

// #119: All mail and the other unified views opened as a screen over the
// tabs, with a back arrow where every folder has the menu button. They are
// lists of the Mail tab now. No React Native renderer in the test env, so the
// screens are checked by their wiring.

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '..', '..', rel), 'utf8').replace(/\r\n/g, '\n');

describe('the unified view the Mail tab shows', () => {
  beforeEach(() => showMailFolders());

  it('is set by a drawer row and cleared for the folders', () => {
    expect(useUnifiedView.getState().target).toBeNull();
    showUnifiedView({ view: 'all' });
    expect(useUnifiedView.getState().target).toEqual({ view: 'all' });
    showMailFolders();
    expect(useUnifiedView.getState().target).toBeNull();
  });

  it('marks only its own row as selected', () => {
    expect(isUnifiedViewShown(null, { role: 'inbox' })).toBe(false);
    expect(isUnifiedViewShown({ view: 'all' }, { view: 'all' })).toBe(true);
    expect(isUnifiedViewShown({ view: 'all' }, { view: 'unread' })).toBe(false);
    // A cross view is not the inbox row, though neither names a role.
    expect(isUnifiedViewShown({ view: 'all' }, { role: 'inbox' })).toBe(false);
    expect(isUnifiedViewShown({ role: 'sent' }, { view: 'all' })).toBe(false);
    expect(isUnifiedViewShown({ role: 'sent' }, { role: 'sent' })).toBe(true);
    // "All inboxes" is the default role.
    expect(isUnifiedViewShown({}, { role: 'inbox' })).toBe(true);
    expect(isUnifiedViewShown({ role: 'inbox' }, { role: 'sent' })).toBe(false);
  });
});

describe('unified views in the Mail tab (wiring)', () => {
  it('are no screen of the root stack', () => {
    expect(read('../App.tsx')).not.toMatch(/name="UnifiedInbox"/);
    expect(read('navigation/types.ts')).not.toMatch(/UnifiedInbox/);
  });

  it('take the place of the folder list, which stays mounted', () => {
    const tab = read('screens/MailTab.tsx');
    expect(tab).toMatch(/\{unified && \(\s+<View style=\{styles\.fill\}>\s+<UnifiedInboxScreen/);
    expect(tab).toMatch(/unified && styles\.hidden\]\}>\{list\}<\/View>/);
    expect(tab).toMatch(/\{layout\.isSplit && !unified && \(/);
    // Next to a docked folder list, the view has that much less room.
    expect(tab).toMatch(/width=\{roomWidth\}\s+sidebarDocked=\{layout\.hasSidebar\}/);
  });

  it('take Back in the steps of a folder list, then lead back to the folders', () => {
    const src = read('screens/UnifiedInboxScreen.tsx');
    expect(src).toMatch(/const backStep = listBackStep\(\{ selecting: selected\.size > 0, searching: searchInput\.length > 0 \|\| query\.length > 0 \}\);/);
    expect(src).toMatch(/\} else \{\s+showMailFolders\(\);\s+\}\s+\}, \[backStep, clearSelection\]\);\s+useBackWhileFocused\(true, handleBack\);/);
    // The folder list underneath leaves Back alone meanwhile.
    expect(read('screens/MailTab.tsx')).toMatch(/covered=\{!!unified\}/);
    expect(read('screens/EmailListScreen.tsx')).toMatch(/useBackWhileFocused\(backStep !== 'leave' && !covered, handleBack\);/);
  });

  it('give way once the drawer no longer offers them', () => {
    const drawer = read('components/SidebarDrawer.tsx');
    expect(drawer).toMatch(/&& !unifiedViewOffered\(unifiedShown, \{ showUnified, crossViews \}\);\s+React\.useEffect\(\(\) => \{\s+if \(unifiedGone\) showMailFolders\(\);/);
  });

  it('have the menu button of a folder, not a back arrow', () => {
    const src = read('screens/UnifiedInboxScreen.tsx');
    expect(src).not.toMatch(/navigation\.goBack\(\)/);
    expect(src).not.toMatch(/ArrowLeft/);
    expect(src).toMatch(/\{!sidebarDocked && \(\s+<Pressable\s+onPress=\{\(\) => setDrawerOpen\(true\)\}/);
    expect(src).toMatch(/\{!sidebarDocked && <SidebarDrawer visible=\{drawerOpen\} onClose=\{\(\) => setDrawerOpen\(false\)\} \/>\}/);
  });

  it('open from the drawer without leaving the tab, and give way to a folder, a tag or an account', () => {
    const drawer = read('components/SidebarDrawer.tsx');
    expect(drawer).not.toMatch(/navigate\('UnifiedInbox'/);
    expect(drawer).toMatch(/onPress=\{\(\) => openUnified\(\{ view: row\.view \}\)\}/);
    expect(drawer).toMatch(/onPress=\{\(\) => openUnified\(\{ role: r\.role \}\)\}/);
    expect(drawer).toMatch(/showMailFolders\(\);\s+void selectMailbox\(id\);/);
    expect(drawer).toMatch(/showMailFolders\(\);\s+void selectMailbox\(id\)\.then\(\(\) => setFilters\(\{ isUnread: true \}\)\);/);
    expect(drawer).toMatch(/showMailFolders\(\);\s+setFilters\(\{ keyword: keywordToken\(id\) \}\);/);
    expect(drawer).toMatch(/showMailFolders\(\);\s+void switchAccount\(acc\.id\);/);
  });

  it('show their drawer row as the selected one instead of the open folder', () => {
    const drawer = read('components/SidebarDrawer.tsx');
    expect(drawer).toMatch(/isSelected=\{isUnifiedViewShown\(unifiedShown, \{ view: row\.view \}\)\}/);
    expect(drawer).toMatch(/isSelected=\{isUnifiedViewShown\(unifiedShown, \{ role: r\.role \}\)\}/);
    expect(drawer).toMatch(/!tagViewActive && !unifiedShown && node\.id === currentMailboxId/);
  });
});
