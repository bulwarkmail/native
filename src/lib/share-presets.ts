import type { AddressBookRights, CalendarRights } from '../api/types';

/** What a share sheet shares: a calendar or an address book. */
export type ShareKind = 'calendar' | 'addressBook';

export type RolePreset = 'freeBusy' | 'read' | 'readWrite' | 'manager';

/** The rights a share of `kind` grants. */
export type ShareRights<K extends ShareKind> = K extends 'calendar' ? CalendarRights : AddressBookRights;

// Same presets the webmail's share-collection dialog offers for calendars.
export const CALENDAR_PRESETS: Record<RolePreset, CalendarRights> = {
  freeBusy: {
    mayReadFreeBusy: true, mayReadItems: false, mayWriteAll: false, mayWriteOwn: false,
    mayUpdatePrivate: false, mayRSVP: false, mayShare: false, mayDelete: false,
  },
  read: {
    mayReadFreeBusy: true, mayReadItems: true, mayWriteAll: false, mayWriteOwn: false,
    mayUpdatePrivate: false, mayRSVP: false, mayShare: false, mayDelete: false,
  },
  readWrite: {
    mayReadFreeBusy: true, mayReadItems: true, mayWriteAll: true, mayWriteOwn: true,
    mayUpdatePrivate: true, mayRSVP: true, mayShare: false, mayDelete: false,
  },
  manager: {
    mayReadFreeBusy: true, mayReadItems: true, mayWriteAll: true, mayWriteOwn: true,
    mayUpdatePrivate: true, mayRSVP: true, mayShare: true, mayDelete: true,
  },
};

// And for address books, which have no free/busy level.
export const ADDRESS_BOOK_PRESETS: Record<Exclude<RolePreset, 'freeBusy'>, AddressBookRights> = {
  read: { mayRead: true, mayWrite: false, mayShare: false, mayDelete: false },
  readWrite: { mayRead: true, mayWrite: true, mayShare: false, mayDelete: false },
  manager: { mayRead: true, mayWrite: true, mayShare: true, mayDelete: true },
};

const CALENDAR_ORDER: RolePreset[] = ['freeBusy', 'read', 'readWrite', 'manager'];
const ADDRESS_BOOK_ORDER: RolePreset[] = ['read', 'readWrite', 'manager'];

/** The presets a share of `kind` offers, least access first. */
export function presetOrder(kind: ShareKind): RolePreset[] {
  return kind === 'calendar' ? CALENDAR_ORDER : ADDRESS_BOOK_ORDER;
}

/** The rights preset `preset` grants for a share of `kind`. */
export function presetRights<K extends ShareKind>(kind: K, preset: RolePreset): ShareRights<K> {
  const rights = kind === 'calendar'
    ? CALENDAR_PRESETS[preset]
    : ADDRESS_BOOK_PRESETS[preset as Exclude<RolePreset, 'freeBusy'>];
  return rights as ShareRights<K>;
}

/**
 * The preset `rights` matches exactly, a right the server left out counting
 * as not granted, or 'custom' when it matches none.
 */
export function detectPreset(
  kind: ShareKind,
  rights: CalendarRights | AddressBookRights,
): RolePreset | 'custom' {
  const given = rights as Record<string, boolean | undefined>;
  for (const preset of presetOrder(kind)) {
    const expected = presetRights(kind, preset) as Record<string, boolean | undefined>;
    if (Object.keys(expected).every((k) => !!expected[k] === !!given[k])) return preset;
  }
  return 'custom';
}
