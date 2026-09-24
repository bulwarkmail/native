// Settings panes whose every user-visible string goes through t(). A literal
// English label, description, option label, alert or JSX text sneaking back
// in stays English in every locale, so this scans the source for them.
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { findUntranslatedLiterals } from './untranslated-literals';

// Pane file → texts that stay as they are on purpose.
const TRANSLATED_PANES: Record<string, string[]> = {
  'ReadingSettings.tsx': [],
  'ContactsSettings.tsx': [],
  'ContentSendersSettings.tsx': [],
  'LayoutSettings.tsx': [],
  'CalendarSettings.tsx': [],
  'IdentitySettings.tsx': [
    // Example signatures in the placeholders: sample data, not UI text.
    '--&#10;Jane Doe&#10;Bulwark Mail',
    '<p><b>Jane Doe</b><br>Bulwark Mail</p>',
  ],
  'FilterSettings.tsx': [],
  'SidebarAppsSettings.tsx': ['https://example.com'],
  'TemplateSettings.tsx': ['JSON', '{"templates": [...]}'],
};

describe('translated settings panes', () => {
  for (const [file, allow] of Object.entries(TRANSLATED_PANES)) {
    it(`${file} has no hard-coded English text`, () => {
      const literals = findUntranslatedLiterals(join(__dirname, '..', 'settings', file), allow);
      expect(literals).toEqual([]);
    });
  }
});
