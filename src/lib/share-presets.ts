import type { AddressBookRights, CalendarRights, MailboxRights } from '../api/types';

/** What a share sheet shares: a calendar, an address book or a mail folder. */
export type ShareKind = 'calendar' | 'addressBook' | 'mailbox';

export type RolePreset = 'freeBusy' | 'read' | 'readWrite' | 'manager';

/** The rights a share of `kind` grants. */
export type ShareRights<K extends ShareKind> = K extends 'calendar'
  ? CalendarRights
  : K extends 'mailbox' ? MailboxRights : AddressBookRights;

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

// And for mail folders (RFC 8621 rights plus mail:share). "Read & write" lets
// the grantee file, flag and remove mail; "Manager" also lets them rename or
// delete the folder, create subfolders, send as its owner and share it again.
export const MAILBOX_PRESETS: Record<Exclude<RolePreset, 'freeBusy'>, MailboxRights> = {
  read: {
    mayReadItems: true, mayAddItems: false, mayRemoveItems: false, maySetSeen: true,
    maySetKeywords: false, mayCreateChild: false, mayRename: false, mayDelete: false,
    maySubmit: false, mayShare: false,
  },
  readWrite: {
    mayReadItems: true, mayAddItems: true, mayRemoveItems: true, maySetSeen: true,
    maySetKeywords: true, mayCreateChild: false, mayRename: false, mayDelete: false,
    maySubmit: false, mayShare: false,
  },
  manager: {
    mayReadItems: true, mayAddItems: true, mayRemoveItems: true, maySetSeen: true,
    maySetKeywords: true, mayCreateChild: true, mayRename: true, mayDelete: true,
    maySubmit: true, mayShare: true,
  },
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
    : (kind === 'mailbox' ? MAILBOX_PRESETS : ADDRESS_BOOK_PRESETS)[preset as Exclude<RolePreset, 'freeBusy'>];
  return rights as ShareRights<K>;
}

/**
 * The preset `rights` matches exactly, a right the server left out counting
 * as not granted, or 'custom' when it matches none.
 */
export function detectPreset(
  kind: ShareKind,
  rights: CalendarRights | AddressBookRights | MailboxRights,
): RolePreset | 'custom' {
  const given = rights as Record<string, boolean | undefined>;
  // Stalwart maps a folder's maySetSeen and maySetKeywords to one ACL
  // (ModifyItems), so a "Read only" grant reads back with maySetKeywords set:
  // there the grantee can also flag messages, a limit of the server. Seen
  // implies keywords when matching, so that readback still reads as 'read'.
  const impliedKeywords = kind === 'mailbox' && !!given.maySetSeen;
  for (const preset of presetOrder(kind)) {
    const expected = presetRights(kind, preset) as Record<string, boolean | undefined>;
    const matches = Object.keys(expected).every((k) =>
      (impliedKeywords && k === 'maySetKeywords') || !!expected[k] === !!given[k]);
    if (matches) return preset;
  }
  return 'custom';
}
