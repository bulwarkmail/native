import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AddressBook, Calendar } from '../../api/types';

// Settings scoped to a shared/group account manage that account's calendars
// and address books. Stalwart numbers ids per account, so the user's own
// collection and the shared one can carry the same raw id: every write names
// the owning account, and nothing is sent once the app shows another account.

const shown = vi.hoisted(() => ({ app: 'app-1' as string | null }));
vi.mock('../../stores/email-store', () => ({
  isShownAccount: (appAccountId: string | null) => !!appAccountId && appAccountId === shown.app,
  requireShownAccountScope: (appAccountId: string | null, jmapAccountId?: string) => {
    if (!appAccountId || appAccountId !== shown.app) throw new Error('This belongs to another account.');
    return { gen: 9, accountId: jmapAccountId ?? 'own' };
  },
}));

const calendarStore = vi.hoisted(() => ({
  calendars: [] as Calendar[],
  updateCalendar: vi.fn(),
}));
vi.mock('../../stores/calendar-store', () => ({
  useCalendarStore: { getState: () => calendarStore },
}));

const contactsStore = vi.hoisted(() => ({
  addressBooks: [] as AddressBook[],
  renameAddressBook: vi.fn(),
}));
vi.mock('../../stores/contacts-store', () => ({
  useContactsStore: { getState: () => contactsStore },
}));

const settings = vi.hoisted(() => ({ setSharedCalendarColor: vi.fn() }));
vi.mock('../../stores/settings-store', () => ({
  useSettingsStore: { getState: () => settings },
}));

vi.mock('../../stores/locale-store', () => ({
  t: (_key: string, fallback?: string) => fallback ?? _key,
}));

import {
  scopedCalendars,
  scopedBooks,
  scopedCalendarActions,
  scopedBookActions,
  updateScopedCalendar,
  renameScopedBook,
} from '../managed-scope';
import { getCalendarColor } from '../calendar-utils';

const ownCal: Calendar = { id: 'c1', name: 'Mine' };
const teamCal: Calendar = {
  id: 'team:c1', originalId: 'c1', accountId: 'team', isShared: true, name: 'Team', color: '#00aa00',
};
const otherCal: Calendar = { id: 'ops:c1', originalId: 'c1', accountId: 'ops', isShared: true, name: 'Ops' };
// Own calendars carry no accountId; one tagged with the managed id but not shared is still not the team's.
const untaggedShared: Calendar = { id: 'team-own', accountId: 'team', name: 'Odd' };

const ownBook: AddressBook = { id: 'ab', name: 'Mine' };
const teamBook: AddressBook = { id: 'team:ab', originalId: 'ab', accountId: 'team', isShared: true, name: 'Team' };
const otherBook: AddressBook = { id: 'ops:ab', originalId: 'ab', accountId: 'ops', isShared: true, name: 'Ops' };

const scope = { appAccountId: 'app-1', managedAccountId: 'team' };

beforeEach(() => {
  vi.clearAllMocks();
  shown.app = 'app-1';
  calendarStore.calendars = [ownCal, teamCal, otherCal, untaggedShared];
  contactsStore.addressBooks = [ownBook, teamBook, otherBook];
});

describe('scopedCalendars / scopedBooks', () => {
  it('keep only the managed account\'s shared calendars, not an own one with the same raw id', () => {
    expect(scopedCalendars(calendarStore.calendars, 'team')).toEqual([teamCal]);
  });

  it('keep only the managed account\'s shared address books, not an own one with the same raw id', () => {
    expect(scopedBooks(contactsStore.addressBooks, 'team')).toEqual([teamBook]);
  });
});

describe('actions offered on a shared collection', () => {
  it('never offers delete for a calendar, whatever the rights', () => {
    const full = { ...teamCal, myRights: { mayDelete: true, mayShare: true, mayWriteAll: true } };
    expect(scopedCalendarActions(full)).toEqual({ edit: true, delete: false });
  });

  it('offers rename and recolour only where the rights allow it', () => {
    expect(scopedCalendarActions(teamCal).edit).toBe(true); // no rights sent: the server decides
    expect(scopedCalendarActions({ ...teamCal, myRights: { mayShare: true } }).edit).toBe(true);
    expect(scopedCalendarActions({ ...teamCal, myRights: { mayAdmin: true } }).edit).toBe(true);
    // Writing every event is not managing the calendar itself.
    expect(scopedCalendarActions({ ...teamCal, myRights: { mayWriteAll: true } }).edit).toBe(false);
    expect(scopedCalendarActions({ ...teamCal, myRights: { mayReadItems: true, mayWriteOwn: true } }).edit).toBe(false);
  });

  it('never offers delete for an address book, and rename only with write rights', () => {
    expect(scopedBookActions({ ...teamBook, myRights: { mayWrite: true, mayDelete: true } }))
      .toEqual({ rename: true, delete: false });
    expect(scopedBookActions({ ...teamBook, myRights: { mayRead: true, mayWrite: false } }).rename).toBe(false);
  });
});

describe('updateScopedCalendar', () => {
  const values = { name: 'Crew', color: '#ff0000', description: '' };

  it('writes to the owning account, on the connection taken when the save started', async () => {
    await updateScopedCalendar(scope, 'team:c1', values);
    expect(calendarStore.updateCalendar).toHaveBeenCalledWith(
      'team:c1',
      { name: 'Crew', color: '#ff0000' },
      { appAccountId: 'app-1', jmapAccountId: 'team', scope: { gen: 9, accountId: 'team' } },
    );
  });

  it('sends only what changed: a rename keeps the colour the sheet showed off the wire', async () => {
    // No colour of its own: the sheet shows the fallback getCalendarColor picks.
    const plain: Calendar = { ...teamCal, color: undefined };
    calendarStore.calendars = [plain];
    await updateScopedCalendar(scope, 'team:c1', { name: 'Crew', color: getCalendarColor(plain), description: '' });
    expect(calendarStore.updateCalendar).toHaveBeenCalledWith('team:c1', { name: 'Crew' }, expect.anything());
    expect(settings.setSharedCalendarColor).not.toHaveBeenCalled();
  });

  it('sends nothing when nothing changed', async () => {
    await updateScopedCalendar(scope, 'team:c1', { name: 'Team', color: '#00AA00', description: '' });
    expect(calendarStore.updateCalendar).not.toHaveBeenCalled();
  });

  it('after a recolour, makes the new colour the viewer\'s own for that calendar so it shows', async () => {
    await updateScopedCalendar(scope, 'team:c1', { name: 'Team', color: '#ff0000', description: '' });
    expect(calendarStore.updateCalendar).toHaveBeenCalledWith('team:c1', { color: '#ff0000' }, expect.anything());
    expect(settings.setSharedCalendarColor).toHaveBeenCalledWith('team|c1', '#ff0000');
  });

  it('leaves the viewer\'s colours alone when the server refuses the recolour', async () => {
    calendarStore.updateCalendar.mockRejectedValueOnce(new Error('forbidden'));
    await expect(updateScopedCalendar(scope, 'team:c1', { name: 'Team', color: '#ff0000', description: '' }))
      .rejects.toThrow('forbidden');
    expect(settings.setSharedCalendarColor).not.toHaveBeenCalled();
  });

  it('writes nothing once another account is shown (a switch mid-edit)', async () => {
    shown.app = 'app-2';
    await expect(updateScopedCalendar(scope, 'team:c1', values)).rejects.toThrow();
    expect(calendarStore.updateCalendar).not.toHaveBeenCalled();
  });

  it('refuses a calendar that is not the managed account\'s', async () => {
    await expect(updateScopedCalendar(scope, 'c1', values)).rejects.toThrow();
    await expect(updateScopedCalendar(scope, 'ops:c1', values)).rejects.toThrow();
    expect(calendarStore.updateCalendar).not.toHaveBeenCalled();
  });

  it('refuses a calendar the rights do not let the user edit', async () => {
    calendarStore.calendars = [{ ...teamCal, myRights: { mayReadItems: true } }];
    await expect(updateScopedCalendar(scope, 'team:c1', values)).rejects.toThrow();
    expect(calendarStore.updateCalendar).not.toHaveBeenCalled();
  });
});

describe('renameScopedBook', () => {
  it('renames in the owning account, for the app account the pane opened in', async () => {
    await renameScopedBook(scope, 'team:ab', 'Crew');
    expect(contactsStore.renameAddressBook).toHaveBeenCalledWith(
      'team:ab',
      'Crew',
      { appAccountId: 'app-1', jmapAccountId: 'team' },
    );
  });

  it('writes nothing once another account is shown (a switch mid-edit)', async () => {
    shown.app = 'app-2';
    await expect(renameScopedBook(scope, 'team:ab', 'Crew')).rejects.toThrow();
    expect(contactsStore.renameAddressBook).not.toHaveBeenCalled();
  });

  it('refuses a book that is not the managed account\'s, or that the user may not write', async () => {
    await expect(renameScopedBook(scope, 'ab', 'Crew')).rejects.toThrow();
    contactsStore.addressBooks = [{ ...teamBook, myRights: { mayWrite: false } }];
    await expect(renameScopedBook(scope, 'team:ab', 'Crew')).rejects.toThrow();
    expect(contactsStore.renameAddressBook).not.toHaveBeenCalled();
  });
});
