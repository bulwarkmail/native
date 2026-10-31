import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Where the organisation policy reaches the settings pages. No React Native
// renderer in the test env, so this checks the wiring (as
// src/components/__tests__/org-policy-wiring.test.ts does); what the policy
// does to the settings is tested in org-policy.test.ts and policy-store.test.ts.

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '..', '..', '..', '..', rel), 'utf8');
const settings = (name: string) => read(`src/components/settings/${name}.tsx`);

describe('organisation policy on the settings pages', () => {
  it('shows the colour mode as set by the organisation when its theme policy locks it', () => {
    const page = settings('AppearanceSettings');
    expect(page).toContain("const themeLocked = useSettingLocked('theme');");
    expect(page).toMatch(/label=\{t\('settings\.appearance\.theme\.label', "Theme"\)\}[^>]*locked=\{themeLocked\}>/);
  });

  it('hides the themes the policy turns off and keeps the grid still while the theme is locked', () => {
    const page = settings('ThemesSettings');
    expect(page).toContain('const policy = usePolicyStore((s) => s.effective);');
    expect(page).toMatch(/visibleThemeCards\(\[[\s\S]*\], policy\), \[t, policy\]\)/);
    expect(page).toContain('{cards.map((card) => {');
    expect(page).toContain("const themeLocked = useSettingLocked('activeThemeId');");
    expect(page).toContain('disabled={themeLocked}');
    expect(page).toContain("{themeLocked && (");
  });

  it('hides the tasks option when the organisation turns tasks off, and marks it locked', () => {
    const page = settings('CalendarSettings');
    expect(page).toContain("const tasksAllowed = usePolicyFeature('calendarTasksEnabled');");
    expect(page).toContain("const tasksLocked = useSettingLocked('enableCalendarTasks');");
    expect(page).toMatch(/\{tasksAllowed && \(\s*<SettingItem\s+label=\{t\('calendar\.settings\.enable_tasks'[\s\S]*?locked=\{tasksLocked\}/);
    expect(page).toContain('{tasksAllowed && tasksEnabled && (');
  });

  it('hides the external content option when the organisation turns it off or hides it', () => {
    const page = settings('ContentSendersSettings');
    expect(page).toContain("const externalContentAllowed = usePolicyFeature('externalContentEnabled');");
    expect(page).toContain("const externalContentHidden = useSettingHidden('externalContentPolicy');");
    expect(page).toContain('const showExternalContent = externalContentAllowed && !externalContentHidden;');
    expect(page).toMatch(/\{showExternalContent && \(\s*<SettingItem\s+label=\{t\('settings\.email_behavior\.external_content\.label'[\s\S]*?locked=\{externalContentLocked\}/);
    expect(page).toContain("const externalContentLocked = useSettingLocked('externalContentPolicy');");
  });

  it('offers settings export and import only while the organisation allows them', () => {
    const page = settings('StorageSettings');
    expect(page).toContain("const exportAllowed = usePolicyFeature('settingsExportEnabled');");
    expect(page).toMatch(/\{exportAllowed && \(\s*<SettingItem\s+label=\{t\('settings\.backup\.export_import'[\s\S]*?handleExport[\s\S]*?handleImport[\s\S]*?<\/SettingItem>\s*\)\}/);
  });

  it('takes Archive out of the swipe and quick actions when the organisation turns it off', () => {
    const layout = settings('LayoutSettings');
    expect(layout).toContain("const archiveEnabled = usePolicyFeature('archiveActionEnabled');");
    expect(layout).toContain('withoutArchive(swipeOptions(t), archiveEnabled)');
    expect(layout).toContain('value={swipeActionShown(swipeRightAction, archiveEnabled)}');
    expect(layout).toContain('value={swipeActionShown(swipeLeftAction, archiveEnabled)}');
    expect(layout).toMatch(/withoutArchive\(ALL_QUICK_ACTIONS\.map\([\s\S]*?\), archiveEnabled\)/);
    expect(layout).toContain('const bottomActions = bottomQuickActionsFor(bottomQuickActionsRaw, archiveEnabled);');

    const reading = settings('ReadingSettings');
    expect(reading).toContain("const archiveEnabled = usePolicyFeature('archiveActionEnabled');");
    expect(reading).toMatch(/\{archiveEnabled && \(\s*<View style=\{styles\.group\}>\s*<SettingItem label=\{t\('settings\.email_behavior\.archive_mode\.label'/);
  });
});
