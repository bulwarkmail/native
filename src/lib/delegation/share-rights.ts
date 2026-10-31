/**
 * The rights Bulwark grants when it shares a folder, calendar, address book
 * or file (`shareWith/<principalId>`), as named presets (webmail
 * lib/jmap/share-rights.ts). The Delegates page builds its patches from here.
 *
 * What Stalwart stores differs from what it was sent in places:
 * - 1.0 keeps `maySetSeen` and `maySetKeywords` of a mailbox as one right, so
 *   a "read" grant (seen yes, keywords no) reads back with both true.
 * - v1.0.0 adds `maySetMetadata` to every type. Bulwark never sends it (0.16
 *   would refuse the property), and the server stores false.
 * So presets are compared on the rights they define, and the mailbox
 * keyword right is allowed to follow the seen right.
 */

export type ShareKind = 'calendar' | 'addressBook' | 'file' | 'mailbox';
export type RolePreset = 'freeBusy' | 'read' | 'readWrite' | 'manager' | 'custom';
type NamedPreset = Exclude<RolePreset, 'custom' | 'freeBusy'>;

export interface ShareCalendarRights {
  mayReadFreeBusy: boolean;
  mayReadItems: boolean;
  mayWriteAll: boolean;
  mayWriteOwn: boolean;
  mayUpdatePrivate: boolean;
  mayRSVP: boolean;
  mayShare: boolean;
  mayDelete: boolean;
}

export interface ShareAddressBookRights {
  mayRead: boolean;
  mayWrite: boolean;
  mayShare?: boolean;
  mayDelete: boolean;
}

export interface ShareFileRights {
  mayRead: boolean;
  mayAddChildren: boolean;
  mayRename: boolean;
  mayDelete: boolean;
  mayModifyContent: boolean;
  mayShare: boolean;
}

export interface ShareMailboxRights {
  mayReadItems: boolean;
  mayAddItems: boolean;
  mayRemoveItems: boolean;
  maySetSeen: boolean;
  maySetKeywords: boolean;
  mayCreateChild: boolean;
  mayRename: boolean;
  mayDelete: boolean;
  maySubmit: boolean;
  mayShare?: boolean;
}

export type AnyRights = ShareCalendarRights | ShareAddressBookRights | ShareFileRights | ShareMailboxRights;

export const CALENDAR_PRESETS: Record<Exclude<RolePreset, 'custom'>, ShareCalendarRights> = {
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

export const ADDRESS_BOOK_PRESETS: Record<NamedPreset, ShareAddressBookRights> = {
  read: { mayRead: true, mayWrite: false, mayShare: false, mayDelete: false },
  readWrite: { mayRead: true, mayWrite: true, mayShare: false, mayDelete: false },
  manager: { mayRead: true, mayWrite: true, mayShare: true, mayDelete: true },
};

export const FILE_PRESETS: Record<NamedPreset, ShareFileRights> = {
  read: {
    mayRead: true, mayAddChildren: false, mayRename: false,
    mayDelete: false, mayModifyContent: false, mayShare: false,
  },
  readWrite: {
    mayRead: true, mayAddChildren: true, mayRename: true,
    mayDelete: true, mayModifyContent: true, mayShare: false,
  },
  manager: {
    mayRead: true, mayAddChildren: true, mayRename: true,
    mayDelete: true, mayModifyContent: true, mayShare: true,
  },
};

// Mail folder rights (RFC 8621 §2 + mail:share). "Read & write" lets the
// grantee file, flag and remove mail; "Manager" additionally lets them
// rename/delete the folder, create subfolders, send as it and re-share.
export const MAILBOX_PRESETS: Record<NamedPreset, ShareMailboxRights> = {
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

function presetsFor(kind: ShareKind): Partial<Record<RolePreset, AnyRights>> {
  if (kind === 'calendar') return CALENDAR_PRESETS;
  if (kind === 'file') return FILE_PRESETS;
  if (kind === 'mailbox') return MAILBOX_PRESETS;
  return ADDRESS_BOOK_PRESETS;
}

function matches(kind: ShareKind, preset: AnyRights, rights: AnyRights): boolean {
  const have = rights as unknown as Record<string, boolean | undefined>;
  return Object.entries(preset).every(([key, want]) => {
    const got = have[key] ?? false;
    if (got === want) return true;
    // Stalwart 1.0 stores the two as one right (see the top of this file).
    return kind === 'mailbox' && key === 'maySetKeywords' && got === true && have.maySetSeen === true;
  });
}

/** The rights a preset grants; undefined for "custom". */
export function presetRights(kind: ShareKind, preset: RolePreset): AnyRights | undefined {
  if (preset === 'custom') return undefined;
  return presetsFor(kind)[preset];
}

/** The preset a stored grant amounts to, or "custom". */
export function detectPreset(kind: ShareKind, rights: AnyRights): RolePreset {
  for (const [name, preset] of Object.entries(presetsFor(kind)) as [RolePreset, AnyRights][]) {
    if (matches(kind, preset, rights)) return name;
  }
  return 'custom';
}

/** Read or read and write, as the Delegates page offers them. */
export type AccessLevel = 'read' | 'write';

/** The rights Delegates grants for one level. */
export function accessRights(kind: ShareKind, level: AccessLevel): AnyRights {
  return presetRights(kind, level === 'write' ? 'readWrite' : 'read')!;
}

/**
 * What a stored grant lets the grantee do, in the two words of the Delegates
 * page: "write" when they may change anything inside, "read" when they may
 * only read, null when they may not even read (free/busy only, or nothing).
 */
export function accessLevelOf(kind: ShareKind, rights: AnyRights | null | undefined): AccessLevel | null {
  if (!rights) return null;
  const r = rights as unknown as Record<string, boolean | undefined>;
  switch (kind) {
    case 'mailbox':
      if (!r.mayReadItems) return null;
      return r.mayAddItems || r.mayRemoveItems ? 'write' : 'read';
    case 'calendar':
      if (!r.mayReadItems) return null;
      return r.mayWriteAll || r.mayWriteOwn ? 'write' : 'read';
    case 'addressBook':
      if (!r.mayRead) return null;
      return r.mayWrite ? 'write' : 'read';
    case 'file':
      if (!r.mayRead) return null;
      return r.mayModifyContent || r.mayAddChildren || r.mayRename || r.mayDelete || r.mayWrite ? 'write' : 'read';
  }
}
