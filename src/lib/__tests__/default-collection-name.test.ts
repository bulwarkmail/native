import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectionLabel, isServerDefaultCollectionName } from '../default-collection-name';
import { addressBookLabel } from '../address-book-label';

// e403478a0: the default calendar showed as "Stalwart Calendar (usera@example.org)".
describe('Stalwart default collection names', () => {
  it('shows the own default calendar and address book by their plain names', () => {
    expect(collectionLabel({ name: 'Stalwart Calendar (usera@example.org)' }, 'calendar', 'Calendar')).toBe('Calendar');
    expect(collectionLabel({ name: 'Stalwart Calendar' }, 'calendar', 'Calendar')).toBe('Calendar');
    expect(addressBookLabel({ name: 'Stalwart Address Book (usera@example.org)', isShared: false })).toBe('Contacts');
  });

  it('keeps whose a shared default is, and leaves names the user chose', () => {
    expect(collectionLabel({ name: 'Stalwart Calendar (bob@example.org)', isShared: true }, 'calendar', 'Kalender'))
      .toBe('Kalender (bob@example.org)');
    expect(collectionLabel({ name: 'Stalwart Calendar trips' }, 'calendar', 'Calendar')).toBe('Stalwart Calendar trips');
    expect(isServerDefaultCollectionName('Stalwart Address Book (a@b)', 'calendar')).toBe(false);
  });

  // No render setup in the repo: the drawers and pickers are checked for using it.
  it('is what the drawers, pickers and sheets show', () => {
    const src = (rel: string) => readFileSync(join(__dirname, '../..', rel), 'utf-8');
    for (const [file, call] of [
      ['components/calendar/CalendarSidebarDrawer.tsx', 'collectionNames.calendar(cal)'],
      ['components/calendar/EventDetailSheet.tsx', 'collectionNames.calendar(calendar)'],
      ['components/calendar/EventModal.tsx', 'collectionNames.calendar(c)'],
      ['components/calendar/EventModal.tsx', 'collectionNames.calendar(selectedCalendar)'],
      ['components/calendar/ICalImportSheet.tsx', 'collectionNames.calendar(cal)'],
      ['components/calendar/TasksSheet.tsx', 'collectionNames.calendar(cal)'],
      ['components/contacts/AddressBookPickerSheet.tsx', 'collectionNames.addressBook(book)'],
      ['components/contacts/ContactsSidebarDrawer.tsx', 'collectionNames.addressBook(book)'],
      ['screens/ContactsScreen.tsx', 'collectionNames.addressBook(book)'],
      ['screens/ContactDetailScreen.tsx', 'collectionNames.addressBook(book!)'],
    ]) {
      expect(src(file), file).toContain(call);
    }
  });
});
