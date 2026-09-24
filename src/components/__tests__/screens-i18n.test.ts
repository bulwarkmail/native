// Screens and sheets outside Settings and Contacts whose every user-visible
// string goes through t(). A literal English label, alert or JSX text
// sneaking back in stays English in every locale, so this scans the source.
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { findUntranslatedLiterals } from './untranslated-literals';

const SRC = join(__dirname, '..', '..');

// File (relative to src/) → texts that stay as they are on purpose.
const TRANSLATED_FILES: Record<string, string[]> = {
  'screens/FilesScreen.tsx': [],
  'components/files/ShareSheet.tsx': [],
  'components/files/FilePreviewModal.tsx': [],
};

describe('translated screens', () => {
  for (const [file, allow] of Object.entries(TRANSLATED_FILES)) {
    it(`${file} has no hard-coded English text`, () => {
      expect(findUntranslatedLiterals(join(SRC, file), allow)).toEqual([]);
    });
  }
});
