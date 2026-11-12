/**
 * Stalwart names the calendar and address book it creates for a new account
 * "Stalwart Calendar (<address>)" and "Stalwart Address Book (<address>)"
 * (registry defaults, 0.16 and 1.0). The app shows those as plain "Calendar"
 * and "Contacts" in the user's language, the way the drawer shows "Sent"
 * instead of the server's folder name. A name the user chose stays as it is.
 * Ported from the webmail's lib/default-collection-name.ts and
 * hooks/use-collection-names.ts.
 */
import React from 'react';
import { useLocaleStore } from '../stores/locale-store';

const SERVER_DEFAULT_NAMES = {
  calendar: /^Stalwart Calendar(?: \([^()]*\))?$/,
  addressBook: /^Stalwart Address Book(?: \([^()]*\))?$/,
} as const;

export type DefaultCollectionKind = keyof typeof SERVER_DEFAULT_NAMES;

export function isServerDefaultCollectionName(name: string | undefined, kind: DefaultCollectionKind): boolean {
  return !!name && SERVER_DEFAULT_NAMES[kind].test(name.trim());
}

/**
 * The name to show for a collection anywhere in the app: the plain name for
 * the user's own default one, and for a colleague's shared default the plain
 * name with whose it is ("Calendar (bob@example.org)"), so two stay apart.
 */
export function collectionLabel(
  collection: { name: string; isShared?: boolean },
  kind: DefaultCollectionKind,
  plainName: string,
): string {
  const { name } = collection;
  if (!isServerDefaultCollectionName(name, kind)) return name;
  if (!collection.isShared) return plainName;
  const owner = /\(([^()]*)\)\s*$/.exec(name.trim())?.[1];
  return owner ? `${plainName} (${owner})` : plainName;
}

interface NamedCollection {
  name: string;
  isShared?: boolean;
}

/** Calendar and address book names as the screens show them, in the user's language. */
export function useCollectionNames(): {
  calendar: (calendar: NamedCollection) => string;
  addressBook: (book: NamedCollection) => string;
} {
  const t = useLocaleStore((s) => s.t);
  return React.useMemo(() => {
    const calendarName = t('uxs_wording.default_calendar', 'Calendar');
    const bookName = t('uxs_wording.default_address_book', 'Contacts');
    return {
      calendar: (calendar: NamedCollection) => collectionLabel(calendar, 'calendar', calendarName),
      addressBook: (book: NamedCollection) => collectionLabel(book, 'addressBook', bookName),
    };
  }, [t]);
}
