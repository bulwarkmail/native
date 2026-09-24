// Settings panes whose every user-visible string goes through t(). A literal
// English label, description, option label, alert or JSX text sneaking back
// in stays English in every locale, so this scans the source for them.
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { findUntranslatedLiterals } from './untranslated-literals';

// Pane file (relative to src/components/) → texts that stay as they are on
// purpose: product names, units, format patterns and sample data.
const TRANSLATED_PANES: Record<string, string[]> = {
  'settings/AboutDataSettings.tsx': ['MB', 'GitHub'],
  'settings/AccountSecuritySettings.tsx': ['AES-128', 'AES-256'],
  'settings/AccountSettings.tsx': [],
  'settings/AppearanceSettings.tsx': [],
  'settings/CalendarSettings.tsx': [],
  // Sub-address delimiter samples ("user+tag").
  'settings/ComposingSettings.tsx': ['user tag'],
  'settings/ContactsSettings.tsx': [],
  'settings/ContentSendersSettings.tsx': [],
  'settings/DownloadsSettings.tsx': [],
  'settings/FilesSettings.tsx': [],
  'settings/FilterSettings.tsx': [],
  'settings/FolderSettings.tsx': [],
  'settings/IdentitySettings.tsx': [
    // Example signatures in the placeholders.
    '--&#10;Jane Doe&#10;Bulwark Mail',
    '<p><b>Jane Doe</b><br>Bulwark Mail</p>',
  ],
  // The raw keyword prefix shown next to a tag id.
  'settings/KeywordSettings.tsx': ['$label:'],
  'settings/LanguageSettings.tsx': [],
  'settings/LayoutSettings.tsx': [],
  'settings/NotificationSettings.tsx': [],
  'settings/PluginsSettings.tsx': [],
  'settings/ReadingSettings.tsx': [],
  'settings/SidebarAppsSettings.tsx': ['https://example.com'],
  'settings/SmimeSettings.tsx': [],
  'settings/TemplateSettings.tsx': ['JSON', '{"templates": [...]}'],
  'settings/ThemesSettings.tsx': [],
  'settings/UpdatesSettings.tsx': [],
  'settings/VacationSettings.tsx': ['YYYY-MM-DD HH:MM'],
  'settings/settings-section.tsx': [],
  'filters/FilterRuleModal.tsx': [],
  'filters/SieveEditorSheet.tsx': [],
};

describe('translated settings panes', () => {
  for (const [file, allow] of Object.entries(TRANSLATED_PANES)) {
    it(`${file} has no hard-coded English text`, () => {
      const literals = findUntranslatedLiterals(join(__dirname, '..', file), allow);
      expect(literals).toEqual([]);
    });
  }
});
