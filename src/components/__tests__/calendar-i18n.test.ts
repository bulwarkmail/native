// Calendar screens and sheets whose every user-visible string goes through
// t(). A literal English label, alert or JSX text sneaking back in stays
// English in every locale, so this scans the source for them.
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { findUntranslatedLiterals } from './untranslated-literals';

const SRC = join(__dirname, '..', '..');

// File (relative to src/) → texts that stay as they are on purpose.
const TRANSLATED_FILES: Record<string, string[]> = {
  'screens/CalendarScreen.tsx': [],
  'components/calendar/AgendaView.tsx': [],
  'components/calendar/EventCard.tsx': [],
  'components/calendar/MonthScrollView.tsx': [],
  'components/calendar/MonthView.tsx': [],
  'components/calendar/TimeGridScrollView.tsx': [],
  'components/calendar/WeekView.tsx': [],
  'components/calendar/CalendarEditSheet.tsx': [],
  'components/calendar/CalendarShareSheet.tsx': [],
  'components/calendar/CalendarSidebarDrawer.tsx': [],
  'components/calendar/EventDetailSheet.tsx': [],
  // The meeting link placeholder shows an example URL.
  'components/calendar/EventModal.tsx': ['https://meet.example.com/…'],
  'components/calendar/ICalImportSheet.tsx': [],
  'components/calendar/ICalSubscriptionSheet.tsx': [],
  'components/calendar/ParticipantInput.tsx': [],
  'components/calendar/RecurrenceEditor.tsx': [],
  'components/calendar/RecurrenceScopeDialog.tsx': [],
  'components/calendar/TasksSheet.tsx': [],
};

describe('translated calendar screens', () => {
  for (const [file, allow] of Object.entries(TRANSLATED_FILES)) {
    it(`${file} has no hard-coded English text`, () => {
      expect(findUntranslatedLiterals(join(SRC, file), allow)).toEqual([]);
    });
  }
});
