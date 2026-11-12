// The contact form's state and the ContactCard patch it saves. Kept out of
// ContactFormScreen so the save path can be tested without rendering it.
import type {
  ContactCard, ContactEmail, ContactPhone, ContactAddress, ContactOrganization,
  ContactAnniversary, ContactNote, ContactOnlineService, ContactPersonalInfo, ContactNickname,
  AddressComponent,
} from '../api/types';
import {
  partialDateToString, stringToPartialDate, deriveFullName, getCustomFullName,
} from './contact-utils';
import type { PhotoEdit } from './contact-media';

// Each row of a list field keeps the `key` of the card's entry it was read
// from, so a save can send an entry the user didn't touch back unchanged and
// build an edited one on the card's entry (#1515).
//
// `context` is "work", "private", "" or a context the form has no option
// for, as the card has it (a vCard TYPE such as "car" from an Android phone).
export interface EmailDraft { key?: string; address: string; context: string }
// `feature` is one of the form's features, "", PHONE_LABEL for a phone with
// its own label (X-ABLabel), or a feature the form has no option for.
export interface PhoneDraft { key?: string; number: string; context: string; feature: string }
export interface AddressDraft {
  key?: string;
  street: string;
  locality: string;
  region: string;
  postcode: string;
  country: string;
  context: string;
}
export interface OrgDraft { name: string; department: string; jobTitle: string; role: string }
export interface AnniversaryDraft { key?: string; kind: string; date: string }
export interface OnlineDraft { key?: string; uri: string; service: string; label: string }
export interface PersonalInfoDraft { key?: string; kind: string; level: string; value: string }
export interface NoteDraft { key?: string; note: string }

/** The phone type a row shows for a phone with its own label. No feature starts with "#". */
export const PHONE_LABEL = '#label';

/** The context a row shows: work or private, else the card's own as stored. */
function contextOf(contexts: Record<string, boolean> | undefined): string {
  if (contexts?.work) return 'work';
  if (contexts?.private) return 'private';
  return Object.keys(contexts ?? {}).find((k) => contexts![k]) ?? '';
}

/** The type a phone row shows: its label when it has one, else its feature. */
function phoneTypeOf(phone: ContactPhone): string {
  if (phone.label?.trim()) return PHONE_LABEL;
  const features = phone.features ?? {};
  // RFC 9553 calls it "mobile"; cards saved by older versions of the app
  // (and of the webmail) say "cell".
  if (features.mobile || features.cell) return 'mobile';
  return ['fax', 'pager', 'video', 'text', 'voice'].find((k) => features[k])
    ?? Object.keys(features).find((k) => features[k])
    ?? '';
}

export interface FormState {
  isOrg: boolean;
  prefix: string;
  given: string;
  middle: string;
  surname: string;
  suffix: string;
  full: string;
  nicknames: string[];
  emails: EmailDraft[];
  phones: PhoneDraft[];
  addresses: AddressDraft[];
  orgs: OrgDraft[];
  anniversaries: AnniversaryDraft[];
  online: OnlineDraft[];
  personalInfo: PersonalInfoDraft[];
  notes: NoteDraft[];
  keywords: string[];
  grammaticalGender: string;
  pronouns: string;
  calendarUri: string;
  schedulingUri: string;
  freeBusyUri: string;
  addressBookId: string;
  /**
   * What the user did to the photo. The stored photo may be a data: URI
   * (Stalwart 0.16) or a blob (1.0); the form only ever writes the photo the
   * user picks, never the one it shows.
   */
  photo: PhotoEdit;
  /** Group members (contact ids from the store), only used when editing a group. */
  members: string[];
}

export function blankForm(): FormState {
  return {
    isOrg: false,
    prefix: '',
    given: '',
    middle: '',
    surname: '',
    suffix: '',
    full: '',
    nicknames: [''],
    emails: [{ address: '', context: '' }],
    phones: [],
    addresses: [],
    orgs: [],
    anniversaries: [],
    online: [],
    personalInfo: [],
    notes: [],
    keywords: [],
    grammaticalGender: '',
    pronouns: '',
    calendarUri: '',
    schedulingUri: '',
    freeBusyUri: '',
    addressBookId: '',
    photo: { kind: 'unchanged' },
    members: [],
  };
}

function findNameComponent(contact: ContactCard | undefined, ...kinds: string[]): string {
  if (!contact?.name?.components) return '';
  const found = contact.name.components.find((c) => kinds.includes(c.kind as string));
  return found?.value || '';
}

function addressToFlat(key: string, a: ContactAddress): AddressDraft {
  if (a.components && a.components.length > 0) {
    const collect = (kind: string) => a.components!.filter((c) => c.kind === kind).map((c) => c.value).join(' ');
    const number = collect('number');
    const name = collect('name');
    return {
      key,
      street: [number, name].filter(Boolean).join(' ') || a.street || '',
      locality: collect('locality') || a.locality || '',
      region: collect('region') || a.region || '',
      postcode: collect('postcode') || a.postcode || '',
      country: collect('country') || a.country || '',
      context: contextOf(a.contexts),
    };
  }
  return {
    key,
    street: a.street || '',
    locality: a.locality || '',
    region: a.region || '',
    postcode: a.postcode || '',
    country: a.country || '',
    context: contextOf(a.contexts),
  };
}

export function contactToForm(contact: ContactCard, memberIds: string[]): FormState {
  const prefix = findNameComponent(contact, 'title', 'prefix');
  const given = findNameComponent(contact, 'given');
  const middle = findNameComponent(contact, 'given2', 'additional', 'middle');
  const surname = findNameComponent(contact, 'surname');
  const suffix = findNameComponent(contact, 'generation', 'suffix');

  const nicknames = contact.nicknames
    ? Object.values(contact.nicknames).map((n) => n.name || '').filter(Boolean)
    : [];

  const emails: EmailDraft[] = contact.emails ? Object.entries(contact.emails).map(([key, e]) => ({
    key,
    address: e.address,
    context: contextOf(e.contexts),
  })) : [];

  const phones: PhoneDraft[] = contact.phones ? Object.entries(contact.phones).map(([key, p]) => ({
    key,
    number: p.number,
    context: contextOf(p.contexts),
    feature: phoneTypeOf(p),
  })) : [];

  const addresses = contact.addresses
    ? Object.entries(contact.addresses).map(([key, a]) => addressToFlat(key, a))
    : [];

  // Pair organization and titles into a single "work" record per index.
  const rawOrgs = contact.organizations ? Object.values(contact.organizations) : [];
  const titles = contact.titles ? Object.values(contact.titles) : [];
  const orgs: OrgDraft[] = [];
  const maxLen = Math.max(rawOrgs.length, titles.length);
  for (let i = 0; i < maxLen; i++) {
    const o = rawOrgs[i];
    const t = titles[i];
    orgs.push({
      name: o?.name || '',
      department: o?.units?.[0]?.name || '',
      jobTitle: t?.kind !== 'role' ? t?.name || '' : '',
      role: t?.kind === 'role' ? t.name : '',
    });
  }

  const anniversaries = contact.anniversaries ? Object.entries(contact.anniversaries).map(([key, a]) => ({
    key,
    kind: a.kind || 'birth',
    date: partialDateToString(a.date),
  })) : [];

  const online = contact.onlineServices ? Object.entries(contact.onlineServices).map(([key, s]) => ({
    key,
    uri: s.uri || '',
    service: s.service || '',
    label: s.label || '',
  })) : [];

  const personalInfo = contact.personalInfo ? Object.entries(contact.personalInfo).map(([key, pi]) => ({
    key,
    kind: pi.kind || 'hobby',
    level: pi.level || '',
    value: pi.value || '',
  })) : [];

  const notes = contact.notes ? Object.entries(contact.notes).map(([key, n]) => ({ key, note: n.note })) : [];

  const keywords = contact.keywords
    ? Object.keys(contact.keywords).filter((k) => contact.keywords![k])
    : [];

  const addressBookId = Object.keys(contact.addressBookIds || {})
    .find((id) => contact.addressBookIds[id]) || '';

  const grammaticalGender = contact.speakToAs?.grammaticalGender || '';
  const pronouns = contact.speakToAs?.pronouns
    ? Object.values(contact.speakToAs.pronouns)[0]?.pronouns || ''
    : '';

  // A card may describe an organization instead of a person (RFC 9553 kind
  // "org"). Older cards predate the explicit kind, so fall back to "has an org
  // name but no personal name".
  const isOrg = contact.kind
    ? contact.kind === 'org'
    : !(given || surname) && !!rawOrgs[0]?.name;
  // Only a display name of its own goes in the field; a derived one is
  // derived again on save, so it can't go stale when the name changes.
  const full = getCustomFullName(contact, isOrg ? rawOrgs[0]?.name : undefined);

  return {
    isOrg, prefix, given, middle, surname, suffix, full,
    nicknames: nicknames.length > 0 ? nicknames : [''],
    emails: emails.length > 0 ? emails : [{ address: '', context: '' }],
    phones, addresses, orgs, anniversaries, online,
    personalInfo, notes, keywords, addressBookId,
    photo: { kind: 'unchanged' },
    grammaticalGender, pronouns,
    calendarUri: contact.calendarUri || '',
    schedulingUri: contact.schedulingUri || '',
    freeBusyUri: contact.freeBusyUri || '',
    members: memberIds,
  };
}

/** Group-membership key for a card (RFC 9553 members are keyed by UID). */
function memberKey(contact: ContactCard): string {
  return contact.uid || contact.originalId || contact.id;
}

function memberKeyMatches(key: string, contact: ContactCard): boolean {
  const bare = key.startsWith('urn:uuid:') ? key.slice(9) : key;
  const bareUid = contact.uid?.startsWith('urn:uuid:') ? contact.uid.slice(9) : contact.uid;
  return key === contact.id || bare === contact.id
    || (!!contact.originalId && (key === contact.originalId || bare === contact.originalId))
    || (!!contact.uid && (key === contact.uid || bare === bareUid));
}

/**
 * The map to save for a list field (emails, phones, addresses...). A row the
 * user didn't touch goes back exactly as the card had it, under its key. An
 * edited row is built on the card's entry (`previous`), so properties the
 * form doesn't show stay; a new row gets a key no other entry uses.
 */
function entriesToSave<E extends { key?: string }, V>(
  rows: E[],
  initialRows: E[],
  original: Record<string, V> | undefined,
  prefix: string,
  build: (row: E, previous: V | undefined, before: E | undefined) => V,
): Record<string, V> {
  const out: Record<string, V> = {};
  const taken = new Set(rows.map((r) => r.key).filter((k): k is string => !!k && !!original?.[k]));
  let n = 1;
  const freshKey = () => {
    let key = `${prefix}${n++}`;
    while (taken.has(key)) key = `${prefix}${n++}`;
    taken.add(key);
    return key;
  };
  for (const row of rows) {
    const previous = row.key ? original?.[row.key] : undefined;
    const before = previous !== undefined ? initialRows.find((r) => r.key === row.key) : undefined;
    if (previous !== undefined && before && JSON.stringify(before) === JSON.stringify(row)) {
      out[row.key!] = previous;
    } else {
      out[previous !== undefined ? row.key! : freshKey()] = build(row, previous, before);
    }
  }
  return out;
}

/** A row the card had and the user left as it was. */
function isUntouchedRow<E extends { key?: string }>(
  row: E, initialRows: E[], original: Record<string, unknown> | undefined,
): boolean {
  if (!row.key || original?.[row.key] === undefined) return false;
  const before = initialRows.find((r) => r.key === row.key);
  return !!before && JSON.stringify(before) === JSON.stringify(row);
}

/** `contexts` for a row: the card's own when the context wasn't changed. */
function contextsToSave(
  context: string, previous: Record<string, boolean> | undefined, before: { context: string } | undefined,
): Record<string, boolean> | undefined {
  if (before && before.context === context) return previous;
  return context ? { [context]: true } : undefined;
}

/** Drops keys whose value is undefined, so a built entry has no empty properties. */
function compact<T extends object>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

type AddressField = 'street' | 'locality' | 'region' | 'postcode' | 'country';
const ADDRESS_FIELDS: AddressField[] = ['street', 'locality', 'region', 'postcode', 'country'];
/** The component kinds each address field is read from. */
const ADDRESS_FIELD_KINDS: Record<AddressField, string[]> = {
  street: ['name', 'number'],
  locality: ['locality'],
  region: ['region'],
  postcode: ['postcode'],
  country: ['country'],
};
const ADDRESS_FORM_KINDS = new Set(['name', 'number', 'locality', 'region', 'postcode', 'country', 'separator']);

function freshAddressComponents(a: AddressDraft, extras: AddressComponent[]): AddressComponent[] {
  const comps: AddressComponent[] = [];
  if (a.street.trim()) comps.push({ kind: 'name', value: a.street.trim() });
  comps.push(...extras);
  if (a.locality.trim()) comps.push({ kind: 'locality', value: a.locality.trim() });
  if (a.region.trim()) comps.push({ kind: 'region', value: a.region.trim() });
  if (a.postcode.trim()) comps.push({ kind: 'postcode', value: a.postcode.trim() });
  if (a.country.trim()) comps.push({ kind: 'country', value: a.country.trim() });
  return comps;
}

/**
 * The components of an edited address: the card's own, with only the parts
 * of the fields the user changed replaced. Parts the form doesn't show
 * (apartment, district, PO box...) stay where they were.
 */
function addressComponentsToSave(
  row: AddressDraft, previous: AddressComponent[] | undefined, before: AddressDraft | undefined,
): AddressComponent[] {
  const prev = previous ?? [];
  if (!before || prev.length === 0) {
    return freshAddressComponents(row, prev.filter((c) => !ADDRESS_FORM_KINDS.has(c.kind) && c.value?.trim()));
  }
  let comps = [...prev];
  ADDRESS_FIELDS.forEach((field, fieldIndex) => {
    if (row[field] === before[field]) return;
    const kinds = ADDRESS_FIELD_KINDS[field];
    const value = row[field].trim();
    const replacement: AddressComponent[] = value ? [{ kind: field === 'street' ? 'name' : field, value }] : [];
    const at = comps.map((c, i) => (kinds.includes(c.kind) ? i : -1)).filter((i) => i >= 0);
    if (at.length > 0) {
      const first = at[0];
      const last = at[at.length - 1];
      // The field's parts go, with the separators between them ("Hauptstraße" " " "1").
      const kept = comps.filter((c, i) => !(i >= first && i <= last && (kinds.includes(c.kind) || c.kind === 'separator')));
      comps = [...kept.slice(0, first), ...replacement, ...kept.slice(first)];
      return;
    }
    // A field the card didn't have goes before the next field's parts.
    const laterKinds = ADDRESS_FIELDS.slice(fieldIndex + 1).flatMap((f) => ADDRESS_FIELD_KINDS[f]);
    const next = comps.findIndex((c) => laterKinds.includes(c.kind));
    comps = next >= 0 ? [...comps.slice(0, next), ...replacement, ...comps.slice(next)] : [...comps, ...replacement];
  });
  // No separator at either end or two in a row once parts are gone.
  return comps.filter((c, i, all) => c.kind !== 'separator'
    || (i > 0 && i < all.length - 1 && all[i - 1].kind !== 'separator'));
}

/**
 * Build the JMAP patch. In edit mode every collection the form owns that ended
 * up empty is sent as `null` so the server clears it - omitting the key would
 * mean "unchanged" and the removed phone/address/note would come right back.
 * A property whose fields the user didn't change is left out, so it stays on
 * the server exactly as stored, and list entries the user didn't touch go
 * back as the card had them (`initial` is the form as it was opened; it
 * defaults to the form read from `existing`).
 * `media` is not part of it: see mediaForPhotoEdit.
 */
export function formToPatch(
  form: FormState,
  existing: ContactCard | undefined,
  asGroup: boolean,
  allContacts: ContactCard[],
  initial?: FormState,
): Partial<ContactCard> {
  const isEdit = !!existing;
  const start = existing ? initial ?? contactToForm(existing, []) : undefined;
  const orgName = form.orgs[0]?.name.trim() || '';

  // Organization cards carry no personal name components; the org name goes
  // into `name.full` below. A group name lives in `given`.
  const components: Array<{ kind: string; value: string }> = [];
  if (!form.isOrg) {
    if (form.prefix.trim()) components.push({ kind: 'title', value: form.prefix.trim() });
    if (form.given.trim()) components.push({ kind: 'given', value: form.given.trim() });
    if (form.middle.trim()) components.push({ kind: 'given2', value: form.middle.trim() });
    if (form.surname.trim()) components.push({ kind: 'surname', value: form.surname.trim() });
    if (form.suffix.trim()) components.push({ kind: 'generation', value: form.suffix.trim() });
  }

  // Always send `name.full`: the vCard FN is built from it and is mandatory
  // (#430). Without personal name components, carry the organization name
  // so servers and other clients have something to display.
  const full = form.full.trim() || (form.isOrg ? orgName : deriveFullName(components));
  const name: ContactCard['name'] | undefined =
    components.length > 0 || full
      ? { ...(components.length > 0 ? { components, isOrdered: true } : {}), ...(full ? { full } : {}) }
      : undefined;

  const nicknames: Record<string, ContactNickname> = {};
  form.nicknames.map((n) => n.trim()).filter(Boolean).forEach((n, i) => {
    nicknames[`n${i}`] = { name: n };
  });

  const emails = entriesToSave<EmailDraft, ContactEmail>(
    form.emails.filter((e) => e.address.trim()), start?.emails ?? [], existing?.emails, 'e',
    (row, previous, before) => compact({
      ...previous,
      address: row.address.trim(),
      contexts: contextsToSave(row.context, previous?.contexts, before),
    }),
  );

  // A phone's features and label stay as stored until another type is picked.
  const phones = entriesToSave<PhoneDraft, ContactPhone>(
    form.phones.filter((p) => p.number.trim()), start?.phones ?? [], existing?.phones, 'p',
    (row, previous, before) => {
      const typeKept = !!before && before.feature === row.feature;
      return compact({
        ...previous,
        number: row.number.trim(),
        contexts: contextsToSave(row.context, previous?.contexts, before),
        features: typeKept
          ? previous?.features
          : row.feature && row.feature !== PHONE_LABEL ? { [row.feature]: true } : undefined,
        label: typeKept ? previous?.label : undefined,
      });
    },
  );

  // An address the form can't show (only `full` text, a PO box) has empty
  // fields here; untouched, it stays.
  const addresses = entriesToSave<AddressDraft, ContactAddress>(
    form.addresses.filter((a) => a.street.trim() || a.locality.trim() || a.country.trim() || a.region.trim()
      || a.postcode.trim() || isUntouchedRow(a, start?.addresses ?? [], existing?.addresses)),
    start?.addresses ?? [], existing?.addresses, 'a',
    (row, previous, before) => {
      const {
        components: previousComponents, full: _full, fullAddress: _fullAddress,
        street: _s, locality: _l, region: _r, postcode: _p, country: _c, ...kept
      } = previous ?? {};
      void _full; void _fullAddress; void _s; void _l; void _r; void _p; void _c;
      return compact({
        ...kept,
        components: addressComponentsToSave(row, previousComponents, before),
        isOrdered: true,
        defaultSeparator: previous?.defaultSeparator ?? ', ',
        countryCode: before && before.country === row.country ? previous?.countryCode : undefined,
        contexts: contextsToSave(row.context, previous?.contexts, before),
      });
    },
  );

  const organizations: Record<string, ContactOrganization> = {};
  const titles: Record<string, { name: string; kind?: 'title' | 'role' }> = {};
  form.orgs.forEach((o, i) => {
    if (o.name.trim() || o.department.trim()) {
      const units = o.department.trim() ? [{ name: o.department.trim() }] : undefined;
      organizations[`o${i + 1}`] = {
        ...(o.name.trim() ? { name: o.name.trim() } : {}),
        ...(units ? { units } : {}),
      };
    }
    if (o.jobTitle.trim()) {
      titles[`t${i + 1}`] = { name: o.jobTitle.trim(), kind: 'title' };
    }
    if (o.role.trim()) {
      titles[`r${i + 1}`] = { name: o.role.trim(), kind: 'role' };
    }
  });

  const anniversaries = entriesToSave<AnniversaryDraft, ContactAnniversary>(
    form.anniversaries.filter((a) => isUntouchedRow(a, start?.anniversaries ?? [], existing?.anniversaries)
      || !!stringToPartialDate(a.date)),
    start?.anniversaries ?? [], existing?.anniversaries, 'an',
    (row, previous) => ({
      ...previous,
      kind: row.kind as ContactAnniversary['kind'],
      date: stringToPartialDate(row.date)!,
    }),
  );

  const onlineServices = entriesToSave<OnlineDraft, ContactOnlineService>(
    form.online.filter((s) => s.uri.trim()), start?.online ?? [], existing?.onlineServices, 'os',
    (row, previous) => compact({
      ...previous,
      uri: row.uri.trim(),
      service: row.service.trim() || undefined,
      label: row.label.trim() || undefined,
    }),
  );

  const personalInfo = entriesToSave<PersonalInfoDraft, ContactPersonalInfo>(
    form.personalInfo.filter((p) => p.value.trim()), start?.personalInfo ?? [], existing?.personalInfo, 'pi',
    (row, previous) => compact({
      ...previous,
      kind: row.kind as ContactPersonalInfo['kind'],
      value: row.value.trim(),
      level: (row.level || undefined) as ContactPersonalInfo['level'],
    }),
  );

  const notes = entriesToSave<NoteDraft, ContactNote>(
    form.notes.filter((n) => n.note.trim()), start?.notes ?? [], existing?.notes, 'n',
    (row, previous) => ({ ...previous, note: row.note.trim() }),
  );

  const keywords: Record<string, boolean> = {};
  form.keywords.forEach((k) => {
    if (k.trim()) keywords[k.trim()] = true;
  });

  const speakToAs =
    form.grammaticalGender || form.pronouns.trim()
      ? {
        ...(form.grammaticalGender ? { grammaticalGender: form.grammaticalGender } : {}),
        ...(form.pronouns.trim()
          ? { pronouns: { p0: { pronouns: form.pronouns.trim() } } }
          : {}),
      }
      : undefined;

  // Collections: value when non-empty; `null` on edit when the card had one
  // before (clears it server-side); omitted otherwise.
  const collection = (key: keyof ContactCard, value: Record<string, unknown>): Record<string, unknown> => {
    if (Object.keys(value).length > 0) return { [key]: value };
    if (isEdit && existing?.[key] !== undefined) return { [key]: null };
    return {};
  };
  const scalar = (key: keyof ContactCard, value: string): Record<string, unknown> => {
    if (value) return { [key]: value };
    if (isEdit && existing?.[key] !== undefined) return { [key]: null };
    return {};
  };

  // Only send `kind` when this form owns the answer: switching a card between
  // person and organization. Leave other kinds (group, location, ...) untouched.
  const kind: Partial<ContactCard> = asGroup
    ? { kind: 'group' }
    : form.isOrg
      ? { kind: 'org' }
      : existing?.kind === 'org' ? { kind: 'individual' } : {};

  const patch: Record<string, unknown> = {
    ...kind,
    ...(name ? { name } : isEdit && existing?.name ? { name: null } : {}),
    ...collection('nicknames', nicknames),
    ...collection('emails', emails),
    ...collection('phones', phones),
    ...collection('addresses', addresses),
    ...collection('organizations', organizations),
    ...collection('titles', titles),
    ...collection('anniversaries', anniversaries),
    ...collection('onlineServices', onlineServices),
    ...collection('personalInfo', personalInfo),
    ...collection('notes', notes),
    ...collection('keywords', keywords),
    ...(speakToAs ? { speakToAs } : isEdit && existing?.speakToAs ? { speakToAs: null } : {}),
    ...scalar('calendarUri', form.calendarUri.trim()),
    ...scalar('schedulingUri', form.schedulingUri.trim()),
    ...scalar('freeBusyUri', form.freeBusyUri.trim()),
    // No `media`: an update without it keeps every entry on the server, and
    // the form adds one only when the photo changed (mediaForPhotoEdit). A
    // map built here from the card's copy deleted a photo stored as a blob
    // (Stalwart 1.0) on every save.
  };

  // An existing card gets only what changed: every property left out stays
  // on the server exactly as it is.
  if (start) {
    const sources = (f: FormState): Record<string, unknown> => ({
      name: [f.isOrg, f.prefix, f.given, f.middle, f.surname, f.suffix, f.full, f.isOrg ? f.orgs[0]?.name : ''],
      nicknames: f.nicknames.map((n) => n.trim()).filter(Boolean),
      emails: f.emails,
      phones: f.phones,
      addresses: f.addresses,
      organizations: f.orgs.map((o) => [o.name, o.department]),
      titles: f.orgs.map((o) => [o.jobTitle, o.role]),
      anniversaries: f.anniversaries,
      onlineServices: f.online,
      personalInfo: f.personalInfo,
      notes: f.notes,
      keywords: f.keywords,
      speakToAs: [f.grammaticalGender, f.pronouns],
      calendarUri: f.calendarUri,
      schedulingUri: f.schedulingUri,
      freeBusyUri: f.freeBusyUri,
    });
    const now = sources(form);
    const before = sources(start);
    for (const property of Object.keys(now)) {
      if (JSON.stringify(now[property]) === JSON.stringify(before[property])) delete patch[property];
    }
  }

  if (asGroup) {
    // Start from the stored map so members we cannot resolve locally survive;
    // drop the resolved ones that were deselected and add the new picks.
    const members: Record<string, boolean> = { ...(existing?.members || {}) };
    const selected = form.members
      .map((id) => allContacts.find((c) => c.id === id))
      .filter((c): c is ContactCard => !!c);
    for (const key of Object.keys(members)) {
      const owner = allContacts.find((c) => memberKeyMatches(key, c));
      if (owner && !selected.some((s) => s.id === owner.id)) delete members[key];
    }
    for (const contact of selected) {
      if (!Object.keys(members).some((key) => memberKeyMatches(key, contact))) {
        members[memberKey(contact)] = true;
      }
    }
    patch.members = members;
  }

  return patch as Partial<ContactCard>;
}
