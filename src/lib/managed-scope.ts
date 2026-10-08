import type { AddressBook, Calendar } from '../api/types';
import type { CalendarUpdates } from '../api/calendar';
import { useCalendarStore } from '../stores/calendar-store';
import { useContactsStore } from '../stores/contacts-store';
import { isShownAccount, requireShownAccountScope } from '../stores/email-store';
import { useSettingsStore } from '../stores/settings-store';
import { t } from '../stores/locale-store';
import { getCalendarColor, sharedCalendarColorKey } from './calendar-utils';

// Settings scoped to a shared/group account (webmail: scoped settings) list
// and edit that account's calendars and address books only. Stalwart numbers
// ids per account, so the user's own collection and the shared one can carry
// the same raw id: a collection is the managed account's when it is shared
// and tagged with that JMAP account, never by its id alone.

/**
 * The account Settings manages: JMAP account `managedAccountId` of app
 * account `appAccountId`, the one shown when the pane opened.
 */
export interface ManagedScope {
  appAccountId: string | null | undefined;
  managedAccountId: string;
}

export function scopedCalendars(calendars: Calendar[], managedAccountId: string): Calendar[] {
  return calendars.filter((cal) => !!cal.isShared && cal.accountId === managedAccountId);
}

export function scopedBooks<B extends AddressBook>(books: B[], managedAccountId: string): B[] {
  return books.filter((book) => !!book.isShared && book.accountId === managedAccountId);
}

/**
 * What the scoped pane offers on a shared calendar. Rename and recolour
 * change the calendar for everyone it is shared with, so they need the
 * right to manage it (mayShare, or the RFC-style mayAdmin; mayWriteAll
 * covers its events only). A server that sends no rights decides on the
 * write. Delete is never offered.
 */
export function scopedCalendarActions(cal: Calendar): { edit: boolean; delete: false } {
  const r = cal.myRights;
  return { edit: !r || !!r.mayShare || !!r.mayAdmin, delete: false };
}

/** What the scoped pane offers on a shared address book. Delete is never offered. */
export function scopedBookActions(book: AddressBook): { rename: boolean; delete: false } {
  return { rename: book.myRights?.mayWrite !== false, delete: false };
}

/**
 * Rename, recolour or describe the managed account's calendar `calendarId`,
 * in that account. Refused, nothing sent, once the app shows another
 * account, and for a calendar that is not the managed account's or that the
 * user may not edit.
 */
export async function updateScopedCalendar(
  scope: ManagedScope,
  calendarId: string,
  values: { name: string; color: string; description: string },
): Promise<void> {
  const at = requireShownAccountScope(scope.appAccountId, scope.managedAccountId);
  const store = useCalendarStore.getState();
  const cal = scopedCalendars(store.calendars, scope.managedAccountId).find((c) => c.id === calendarId);
  if (!cal || !scopedCalendarActions(cal).edit) {
    throw new Error(t('calendar.management.error_update', 'Failed to update calendar'));
  }
  // Only what changed: the sheet shows a fallback colour for a calendar
  // without one, and a rename must not write it.
  const updates: CalendarUpdates = {};
  if (values.name !== cal.name) updates.name = values.name;
  if (values.color.toLowerCase() !== getCalendarColor(cal).toLowerCase()) updates.color = values.color;
  if ((values.description || null) !== (cal.description || null)) updates.description = values.description || null;
  if (Object.keys(updates).length === 0) return;
  await store.updateCalendar(
    cal.id,
    updates,
    { appAccountId: scope.appAccountId, jmapAccountId: scope.managedAccountId, scope: at },
  );
  // The viewer's own colour for a shared calendar wins on screen (#345):
  // make it the new one so the recolour shows. Setting it rather than
  // clearing it, since the calendar screen gives a calendar without one a
  // random colour.
  if (updates.color && isShownAccount(scope.appAccountId)) {
    useSettingsStore.getState().setSharedCalendarColor(sharedCalendarColorKey(cal), updates.color);
  }
}

/** Rename the managed account's address book `bookId`, in that account (see updateScopedCalendar). */
export async function renameScopedBook(scope: ManagedScope, bookId: string, name: string): Promise<void> {
  // Refuse before reading the store: after a switch its books are the next
  // account's, where the same id can name another book. The store takes
  // its own scope for the write.
  requireShownAccountScope(scope.appAccountId, scope.managedAccountId);
  const store = useContactsStore.getState();
  const book = scopedBooks(store.addressBooks, scope.managedAccountId).find((b) => b.id === bookId);
  if (!book || !scopedBookActions(book).rename) {
    throw new Error(t('contacts.address_books.rename_failed', 'Failed to rename address book'));
  }
  await store.renameAddressBook(book.id, name, {
    appAccountId: scope.appAccountId ?? null,
    jmapAccountId: scope.managedAccountId,
  });
}
