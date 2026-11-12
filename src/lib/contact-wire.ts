import type {
  AddressComponent, ContactAddress, ContactAnniversary, ContactCalendar, ContactCard, ContactSchedulingAddress,
} from '../api/types';

/**
 * Translation between the ContactCard shape the app works with and the RFC
 * 9553 card the server stores (webmail lib/jmap/contact-wire.ts).
 *
 * ContactCard/set rejects a whole card over a single property it does not
 * know ("Invalid property."), so client-side fields must never reach it, and
 * the app's flat conveniences are written as their JSContact equivalents:
 * the vCard CALURI / FBURL / CALADRURI / SOURCE links, and the flat street,
 * locality... of a vCard ADR.
 */

/** Fields the client adds to cards it lists; not part of RFC 9553. */
const CLIENT_ONLY_KEYS = ['originalId', 'accountId', 'accountName', 'isShared'] as const;

/** vCard CALURI / FBURL / CALADRURI / SOURCE, kept flat in the app. */
const URI_KEYS = ['calendarUri', 'freeBusyUri', 'schedulingUri', 'source'] as const;

/**
 * Properties an update never clears. A null `id` fails the whole update ("The
 * id property is immutable.") and so does a null `addressBookIds` ("Invalid
 * patch operation for addressBookIds."). A null `uid` is refused by Stalwart
 * 1.0 ("You cannot change the UID of a contact.") and on 0.16 silently
 * deletes the card's UID.
 */
const NEVER_CLEARED_KEYS = ['id', 'uid', 'addressBookIds'] as const;

const LEGACY_ADDRESS_FIELDS: Array<[keyof ContactAddress, AddressComponent['kind']]> = [
  ['street', 'name'],
  ['locality', 'locality'],
  ['region', 'region'],
  ['postcode', 'postcode'],
  ['country', 'country'],
];

/** The flat calendar links: the kind of entry each is read from, and the key a new one gets. */
const CALENDAR_LINKS = [
  ['calendarUri', 'calendar', 'cal'],
  ['freeBusyUri', 'freeBusy', 'fb'],
] as const;

type LinkFields = Pick<ContactCard, 'calendarUri' | 'freeBusyUri' | 'schedulingUri'>;

/** The entries the app writes for a card that has only the flat links. */
function calendarsFromLinks(card: LinkFields): Record<string, ContactCalendar> {
  const calendars: Record<string, ContactCalendar> = {};
  for (const [field, kind, key] of CALENDAR_LINKS) {
    if (card[field]) calendars[key] = { '@type': 'Calendar', kind, uri: card[field] };
  }
  return calendars;
}

function schedulingFromLinks(card: LinkFields): Record<string, ContactSchedulingAddress> {
  return card.schedulingUri ? { sched: { '@type': 'SchedulingAddress', uri: card.schedulingUri } } : {};
}

/** The key of the entry a flat calendar link stands for: the first of its kind. */
function calendarKey(calendars: Record<string, ContactCalendar>, kind: string): string | undefined {
  return Object.keys(calendars).find((key) => calendars[key]?.kind === kind);
}

/** The link itself: the `uri` of that entry. */
function calendarLink(calendars: Record<string, ContactCalendar>, kind: string): string | undefined {
  const key = calendarKey(calendars, kind);
  return key ? calendars[key]?.uri : undefined;
}

/** `key`, or `key2`, `key3`... when another entry already has it. */
function freeKey(entries: Record<string, unknown>, key: string): string {
  if (!(key in entries)) return key;
  let n = 2;
  while (`${key}${n}` in entries) n++;
  return `${key}${n}`;
}

/** vCard imports store flat fields; RFC 9553 wants `components` and `full`. */
function addressToWire(address: ContactAddress): Record<string, unknown> {
  const { street: _s, locality: _l, region: _r, postcode: _p, country: _c, fullAddress, ...rest } = address;
  const out: Record<string, unknown> = { ...rest };
  if (!address.components?.length) {
    const components = LEGACY_ADDRESS_FIELDS
      .map(([field, kind]) => ({ kind, value: (address[field] as string | undefined)?.trim() ?? '' }))
      .filter((c) => c.value);
    if (components.length) {
      out.components = components;
      out.isOrdered = true;
      out.defaultSeparator = ', ';
    }
  }
  if (fullAddress && !address.full) out.full = fullAddress;
  return out;
}

/** A BIRTHPLACE / DEATHPLACE read from a vCard is an address too. */
function anniversaryToWire(anniversary: ContactAnniversary): Record<string, unknown> {
  if (!anniversary.place) return { ...anniversary };
  return { ...anniversary, place: addressToWire(anniversary.place) };
}

type Mode = 'create' | 'update';

/**
 * The card as ContactCard/set expects it. On `update`, a key that is present
 * with the value `undefined` means "the user cleared it" and is sent as
 * `null`: JSON drops undefined, and an omitted property keeps its old value.
 * `id`, `uid` and `addressBookIds` without a value are left out instead.
 */
export function contactToWire(card: Partial<ContactCard>, mode: Mode): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(card)) {
    if ((CLIENT_ONLY_KEYS as readonly string[]).includes(key)) continue;
    if ((URI_KEYS as readonly string[]).includes(key)) continue;
    if (mode === 'update' && value == null && (NEVER_CLEARED_KEYS as readonly string[]).includes(key)) continue;
    if (value === undefined) {
      if (mode === 'update') out[key] = null;
      continue;
    }
    out[key] = value;
  }

  if (card.addresses) {
    out.addresses = Object.fromEntries(
      Object.entries(card.addresses).map(([id, a]) => [id, addressToWire(a)]),
    );
  }
  if (card.anniversaries) {
    out.anniversaries = Object.fromEntries(
      Object.entries(card.anniversaries).map(([id, a]) => [id, anniversaryToWire(a)]),
    );
  }

  // Build the entries from the flat links only for a card that has nothing
  // else (a vCard import). A card that carries `calendars` or
  // `schedulingAddresses` is written with them as they are: the flat links
  // show one entry of each kind, and a map built from them would drop the
  // rest. An update that names neither leaves the server's entries alone.
  if (card.calendars == null && ('calendarUri' in card || 'freeBusyUri' in card)) {
    const calendars = calendarsFromLinks(card);
    if (Object.keys(calendars).length) out.calendars = calendars;
    else if (mode === 'update') out.calendars = null;
  }
  if (card.schedulingAddresses == null && 'schedulingUri' in card) {
    if (card.schedulingUri) out.schedulingAddresses = schedulingFromLinks(card);
    else if (mode === 'update') out.schedulingAddresses = null;
  }
  if (card.source) {
    // vCard SOURCE is a JSContact directory entry (RFC 9553 §2.6.2).
    const directories = { ...(card.directories ?? {}) } as Record<string, unknown>;
    directories.source = { '@type': 'Directory', kind: 'entry', uri: card.source };
    out.directories = directories;
  }
  return out;
}

/**
 * The contact form's three links as a patch of the stored `calendars` and
 * `schedulingAddresses`. A link that still reads as stored sends nothing. An
 * edited one changes the `uri` of the entry it was read from, which keeps its
 * key and its other properties; an emptied one removes that entry; a new one
 * is added as `cal`, `fb` or `sched`. Entries the form does not show are kept.
 *
 * The flat links go out with a changed map, read from it again, so the
 * store's copy of the card agrees with it: after the first calendar is
 * removed, the next one is the calendar link.
 *
 * Like the form's other collections, a changed map is built on the store's
 * copy of the card and replaces the server's, so an entry another client
 * added since the last fetch does not survive an edit of that map here.
 */
export function linksToPatch(existing: ContactCard | undefined, links: Required<LinkFields>): Partial<ContactCard> {
  const patch: Record<string, unknown> = {};
  const flat = (field: keyof LinkFields, uri: string | undefined) => {
    if (uri) patch[field] = uri;
    else if (existing?.[field] !== undefined) patch[field] = null;
  };

  // A copy with the flat links but no maps (a vCard import whose re-fetch
  // failed) stands for the entries the app wrote for them.
  const calendars = { ...(existing?.calendars ?? calendarsFromLinks(existing ?? {})) };
  let changed = false;
  for (const [field, kind, key] of CALENDAR_LINKS) {
    const uri = links[field];
    if (uri === (calendarLink(calendars, kind) ?? '').trim()) continue;
    changed = true;
    const stored = calendarKey(calendars, kind);
    if (!stored) calendars[freeKey(calendars, key)] = { '@type': 'Calendar', kind, uri };
    else if (uri) calendars[stored] = { ...calendars[stored], uri };
    else delete calendars[stored];
  }
  if (changed) {
    patch.calendars = Object.keys(calendars).length ? calendars : null;
    for (const [field, kind] of CALENDAR_LINKS) flat(field, calendarLink(calendars, kind));
  }

  const scheduling = { ...(existing?.schedulingAddresses ?? schedulingFromLinks(existing ?? {})) };
  const first = Object.keys(scheduling)[0] as string | undefined;
  const address = links.schedulingUri;
  if (address !== ((first && scheduling[first]?.uri) || '').trim()) {
    if (!first) scheduling.sched = { '@type': 'SchedulingAddress', uri: address };
    else if (address) scheduling[first] = { ...scheduling[first], uri: address };
    else delete scheduling[first];
    patch.schedulingAddresses = Object.keys(scheduling).length ? scheduling : null;
    flat('schedulingUri', Object.values(scheduling)[0]?.uri);
  }
  return patch;
}

/** Fill the app's flat URI fields from the RFC 9553 properties. */
export function contactFromWire<T extends ContactCard>(card: T): T {
  const calendars = card.calendars ?? {};
  const calendarUri = card.calendarUri ?? calendarLink(calendars, 'calendar');
  const freeBusyUri = card.freeBusyUri ?? calendarLink(calendars, 'freeBusy');
  const schedulingUri = card.schedulingUri ?? Object.values(card.schedulingAddresses ?? {})[0]?.uri;
  const source = card.source ?? Object.values(card.directories ?? {}).find((d) => d?.kind === 'entry')?.uri;
  if (!calendarUri && !freeBusyUri && !schedulingUri && !source) return card;
  return {
    ...card,
    ...(calendarUri ? { calendarUri } : {}),
    ...(freeBusyUri ? { freeBusyUri } : {}),
    ...(schedulingUri ? { schedulingUri } : {}),
    ...(source ? { source } : {}),
  };
}
