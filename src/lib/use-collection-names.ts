import React from 'react';
import { useLocaleStore } from '../stores/locale-store';
import { collectionLabel } from './default-collection-name';

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
