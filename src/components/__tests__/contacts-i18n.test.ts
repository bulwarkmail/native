// Contacts screens and sheets whose every user-visible string goes through
// t(). A literal English label, alert or JSX text sneaking back in stays
// English in every locale, so this scans the source for them.
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { findUntranslatedLiterals } from './untranslated-literals';

const SRC = join(__dirname, '..', '..');

// File (relative to src/) → texts that stay as they are on purpose.
const TRANSLATED_FILES: Record<string, string[]> = {
  'screens/ContactsScreen.tsx': [],
  'screens/ContactDetailScreen.tsx': [],
  // Service names are product names.
  'screens/ContactFormScreen.tsx': ['LinkedIn, Mastodon, …'],
  'screens/GroupDetailScreen.tsx': [],
  'components/contacts/ContactActivity.tsx': [],
  'components/contacts/ContactImportSheet.tsx': [
    // Only reachable in a development build without the native module.
    'Import unavailable',
    'The file picker is not installed in this build. Rebuild the app (expo run:android) to enable importing.',
  ],
  'components/contacts/ContactsSidebarDrawer.tsx': [],
  'components/contacts/AddressBookPickerSheet.tsx': [],
  'components/contacts/ContactPickerSheet.tsx': [],
  'components/contacts/TagAssignSheet.tsx': [],
  'components/contacts/ContactListRow.tsx': [],
  'components/contacts/FieldBlock.tsx': [],
};

describe('translated contacts screens', () => {
  for (const [file, allow] of Object.entries(TRANSLATED_FILES)) {
    it(`${file} has no hard-coded English text`, () => {
      expect(findUntranslatedLiterals(join(SRC, file), allow)).toEqual([]);
    });
  }
});
