import type { AddressComponent, ContactAddress, ContactCard } from '../api/types';

/**
 * Translation between the ContactCard shape the UI works with and the RFC 9553
 * card the server stores.
 *
 * ContactCard/set rejects a whole card over a single property it does not
 * know ("Invalid property."), so client-side fields must never reach it, and
 * the UI's flat conveniences are written as their JSContact equivalents.
 */

/** Fields the client adds to cards it lists; not part of RFC 9553. */
const CLIENT_ONLY_KEYS = [
  'originalId', 'accountId', 'accountName', 'isShared', 'localAccountId',
] as const;

/** vCard CALURI / FBURL / CALADRURI, kept flat in the UI. */
const URI_KEYS = ['calendarUri', 'freeBusyUri', 'schedulingUri', 'source'] as const;

const LEGACY_ADDRESS_FIELDS: Array<[keyof ContactAddress, AddressComponent['kind']]> = [
  ['street', 'name'],
  ['locality', 'locality'],
  ['region', 'region'],
  ['postcode', 'postcode'],
  ['country', 'country'],
];

/** vCard imports store flat fields; RFC 9553 wants `components`. */
function addressToWire(address: ContactAddress): Record<string, unknown> {
  const { street: _s, locality: _l, region: _r, postcode: _p, country: _c, fullAddress, ...rest } = address;
  const out: Record<string, unknown> = { ...rest };
  if (!address.components?.length) {
    const components = LEGACY_ADDRESS_FIELDS
      .map(([field, kind]) => ({ kind, value: (address[field] as string | undefined)?.trim() ?? '' }))
      .filter(c => c.value);
    if (components.length) {
      out.components = components;
      out.isOrdered = true;
      out.defaultSeparator = ', ';
    }
  }
  if (fullAddress && !address.full) out.full = fullAddress;
  return out;
}

type Mode = 'create' | 'update';

/**
 * The card as ContactCard/set expects it. On `update`, a key that is present
 * with the value `undefined` means "the user cleared it" and is sent as
 * `null`: JSON drops undefined, and an omitted property keeps its old value.
 */
export function contactToWire(card: Partial<ContactCard>, mode: Mode): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(card)) {
    if ((CLIENT_ONLY_KEYS as readonly string[]).includes(key)) continue;
    if ((URI_KEYS as readonly string[]).includes(key)) continue;
    if (value === undefined || (value === null && mode === 'create')) {
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

  // A card that carries a link map (a form edit's merged map, or a loaded card
  // being moved or duplicated) sends that map as it is: JMAP replaces the
  // whole property, so rebuilding it from the flat fields would drop the other
  // entries and their mediaType/pref. Only a card without the map (a new card,
  // a vCard import) has its links built from the flat fields.
  if (!('calendars' in card) && ('calendarUri' in card || 'freeBusyUri' in card)) {
    const calendars: Record<string, unknown> = {};
    if (card.calendarUri) calendars.cal = { '@type': 'Calendar', kind: 'calendar', uri: card.calendarUri };
    if (card.freeBusyUri) calendars.fb = { '@type': 'Calendar', kind: 'freeBusy', uri: card.freeBusyUri };
    if (Object.keys(calendars).length) out.calendars = calendars;
    else if (mode === 'update') out.calendars = null;
  }
  if (!('schedulingAddresses' in card) && 'schedulingUri' in card) {
    if (card.schedulingUri) out.schedulingAddresses = { sched: { '@type': 'SchedulingAddress', uri: card.schedulingUri } };
    else if (mode === 'update') out.schedulingAddresses = null;
  }
  if (card.source) {
    // vCard SOURCE is a JSContact directory entry (RFC 9553 §2.6.2). A vCard
    // can also carry ORG-DIRECTORY, so the entry joins the existing map. A
    // loaded card's map already holds the entry its `source` came from; that
    // map is sent as it is.
    const existing = card.directories ?? {};
    const hasEntry = Object.values(existing).some(d => d?.kind === 'entry' && d.uri === card.source);
    if (!hasEntry) {
      out.directories = { ...existing, source: { '@type': 'Directory', kind: 'entry', uri: card.source } };
    }
  }
  return out;
}

/** Fill the UI's flat URI fields from the RFC 9553 properties. */
export function contactFromWire<T extends ContactCard>(card: T): T {
  const calendars = Object.values(card.calendars ?? {});
  const calendarUri = card.calendarUri ?? calendars.find(c => c?.kind === 'calendar')?.uri;
  const freeBusyUri = card.freeBusyUri ?? calendars.find(c => c?.kind === 'freeBusy')?.uri;
  const schedulingUri = card.schedulingUri ?? Object.values(card.schedulingAddresses ?? {})[0]?.uri;
  const source = card.source ?? Object.values(card.directories ?? {}).find(d => d?.kind === 'entry')?.uri;
  if (!calendarUri && !freeBusyUri && !schedulingUri && !source) return card;
  return {
    ...card,
    ...(calendarUri ? { calendarUri } : {}),
    ...(freeBusyUri ? { freeBusyUri } : {}),
    ...(schedulingUri ? { schedulingUri } : {}),
    ...(source ? { source } : {}),
  };
}

type LinkMaps = {
  calendars?: ContactCard['calendars'] | null;
  schedulingAddresses?: ContactCard['schedulingAddresses'] | null;
};

/**
 * Apply an edit of the flat link fields to the card's own maps, touching only
 * the first entry of the matching kind. A map left empty comes back as `null`
 * so an update clears it.
 */
export function mergeContactLinks(
  existing: Partial<ContactCard> | undefined,
  changes: { calendarUri?: string; freeBusyUri?: string; schedulingUri?: string },
): LinkMaps {
  const out: LinkMaps = {};
  if ('calendarUri' in changes || 'freeBusyUri' in changes) {
    const calendars: NonNullable<ContactCard['calendars']> = { ...(existing?.calendars ?? {}) };
    const apply = (kind: 'calendar' | 'freeBusy', key: string, uri: string | undefined) => {
      if (uri === undefined) return;
      const found = Object.keys(calendars).find(k => calendars[k]?.kind === kind);
      if (!uri) { if (found) delete calendars[found]; return; }
      if (found) calendars[found] = { ...calendars[found], uri };
      else calendars[key] = { '@type': 'Calendar', kind, uri };
    };
    apply('calendar', 'cal', changes.calendarUri);
    apply('freeBusy', 'fb', changes.freeBusyUri);
    out.calendars = Object.keys(calendars).length ? calendars : null;
  }
  if ('schedulingUri' in changes) {
    const sched: NonNullable<ContactCard['schedulingAddresses']> = { ...(existing?.schedulingAddresses ?? {}) };
    const found = Object.keys(sched)[0];
    const uri = changes.schedulingUri;
    if (!uri) { if (found) delete sched[found]; }
    else if (found) sched[found] = { ...sched[found], uri };
    else sched.sched = { '@type': 'SchedulingAddress', uri };
    out.schedulingAddresses = Object.keys(sched).length ? sched : null;
  }
  return out;
}

/**
 * The link part of a form save. A new card sends the flat fields (contactToWire
 * maps them); an edit sends maps only for the fields the user changed, so a
 * name-only edit leaves the server's links alone.
 */
export function contactLinkPatch(
  existing: Partial<ContactCard> | undefined,
  form: { calendarUri: string; freeBusyUri: string; schedulingUri: string },
): Record<string, unknown> {
  const fields = ['calendarUri', 'freeBusyUri', 'schedulingUri'] as const;
  if (!existing) {
    return Object.fromEntries(fields.filter(f => form[f]).map(f => [f, form[f]]));
  }
  const changes: Record<string, string> = {};
  for (const f of fields) {
    if (form[f].trim() !== (existing[f] ?? '').trim()) changes[f] = form[f].trim();
  }
  if (!Object.keys(changes).length) return {};
  // The flat values ride along so the store's local merge keeps them in step
  // with the maps; contactToWire drops them before sending.
  return {
    ...mergeContactLinks(existing, changes),
    ...Object.fromEntries(Object.entries(changes).map(([f, v]) => [f, v || null])),
  };
}
