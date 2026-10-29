import type { AddressComponent, ContactAddress, ContactAnniversary, ContactCard } from '../api/types';

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

/** The RFC 9553 calendar, scheduling and directory entries the app reads. */
interface WireLinks {
  calendars?: Record<string, { kind?: string; uri?: string } | null>;
  schedulingAddresses?: Record<string, { uri?: string } | null>;
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

  // Rebuild the calendar links only when the caller manages them, so an
  // update that does not mention them leaves the server's entries alone.
  if ('calendarUri' in card || 'freeBusyUri' in card) {
    const calendars: Record<string, unknown> = {};
    if (card.calendarUri) calendars.cal = { '@type': 'Calendar', kind: 'calendar', uri: card.calendarUri };
    if (card.freeBusyUri) calendars.fb = { '@type': 'Calendar', kind: 'freeBusy', uri: card.freeBusyUri };
    if (Object.keys(calendars).length) out.calendars = calendars;
    else if (mode === 'update') out.calendars = null;
  }
  if ('schedulingUri' in card) {
    if (card.schedulingUri) out.schedulingAddresses = { sched: { '@type': 'SchedulingAddress', uri: card.schedulingUri } };
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

/** Fill the app's flat URI fields from the RFC 9553 properties. */
export function contactFromWire<T extends ContactCard>(card: T): T {
  const links = card as T & WireLinks;
  const calendars = Object.values(links.calendars ?? {});
  const calendarUri = card.calendarUri ?? calendars.find((c) => c?.kind === 'calendar')?.uri;
  const freeBusyUri = card.freeBusyUri ?? calendars.find((c) => c?.kind === 'freeBusy')?.uri;
  const schedulingUri = card.schedulingUri ?? Object.values(links.schedulingAddresses ?? {})[0]?.uri;
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
