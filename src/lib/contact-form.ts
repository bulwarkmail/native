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
import { linksToPatch } from './contact-wire';

// A row read from a card carries the `key` of the entry it came from (and an
// organization row the key of its title), so a save can put back what the
// form doesn't show. A row the user added has none.
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
export interface OrgDraft { key?: string; titleKey?: string; name: string; department: string; jobTitle: string; role: string }
export interface AnniversaryDraft { key?: string; kind: string; date: string }
export interface OnlineDraft { key?: string; uri: string; service: string; label: string }
export interface PersonalInfoDraft { key?: string; kind: string; level: string; value: string }
export interface NoteDraft { key?: string; note: string }
export interface NicknameDraft { key?: string; name: string }

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
  // (and of the webmail) say "cell", which a save turns into "mobile".
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
  nicknames: NicknameDraft[];
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
    nicknames: [{ name: '' }],
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

function addressToFlat(a: ContactAddress): AddressDraft {
  if (a.components && a.components.length > 0) {
    const collect = (kind: string) => a.components!.filter((c) => c.kind === kind).map((c) => c.value).join(' ');
    const number = collect('number');
    const name = collect('name');
    return {
      street: [number, name].filter(Boolean).join(' ') || a.street || '',
      locality: collect('locality') || a.locality || '',
      region: collect('region') || a.region || '',
      postcode: collect('postcode') || a.postcode || '',
      country: collect('country') || a.country || '',
      context: contextOf(a.contexts),
    };
  }
  return {
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
    ? Object.entries(contact.nicknames).filter(([, n]) => !!n.name).map(([key, n]) => ({ key, name: n.name }))
    : [];

  const emails = contact.emails ? Object.entries(contact.emails).map(([key, e]) => ({
    key,
    address: e.address,
    context: contextOf(e.contexts),
  })) : [];

  const phones = contact.phones ? Object.entries(contact.phones).map(([key, p]) => ({
    key,
    number: p.number,
    context: contextOf(p.contexts),
    feature: phoneTypeOf(p),
  })) : [];

  const addresses = contact.addresses
    ? Object.entries(contact.addresses).map(([key, a]) => ({ key, ...addressToFlat(a) }))
    : [];

  // Pair organization and titles into a single "work" record per index.
  const orgEntries = contact.organizations ? Object.entries(contact.organizations) : [];
  const titleEntries = contact.titles ? Object.entries(contact.titles) : [];
  const rawOrgs = orgEntries.map(([, o]) => o);
  const orgs: OrgDraft[] = [];
  const maxLen = Math.max(orgEntries.length, titleEntries.length);
  for (let i = 0; i < maxLen; i++) {
    const o = rawOrgs[i];
    const t = titleEntries[i]?.[1];
    orgs.push({
      ...(orgEntries[i] ? { key: orgEntries[i][0] } : {}),
      ...(titleEntries[i] ? { titleKey: titleEntries[i][0] } : {}),
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
    nicknames: nicknames.length > 0 ? nicknames : [{ name: '' }],
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

/** Deep equality that ignores the order of object keys. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length
    && keys.every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** Drops keys whose value is undefined, so a built entry has no empty properties. */
function compact<T extends object>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

/** Hands out `prefix1`, `prefix2`, ... skipping the keys already in use. */
function keyMaker(prefix: string, used: Iterable<string>): () => string {
  const taken = new Set(used);
  let n = 1;
  return () => {
    let key = `${prefix}${n++}`;
    while (taken.has(key)) key = `${prefix}${n++}`;
    taken.add(key);
    return key;
  };
}

/** `contexts` for a row: the card's own when the pills weren't changed. */
function contextsToSave(
  context: string,
  previous: Record<string, boolean> | undefined,
  before: { context: string } | undefined,
): Record<string, boolean> | undefined {
  if (before && before.context === context) return previous;
  return context ? { [context]: true } : undefined;
}

/**
 * One of the card's maps (emails, phones, ...) rebuilt from the form's rows
 * without losing what the form doesn't show (webmail #1515). A row the user
 * didn't touch goes back exactly as the card had it, under its key. An edited
 * row is built on the card's entry (`previous`), so its other properties
 * stay; a new row gets a key no kept entry uses. `filled` says whether a row
 * holds anything worth saving; `build` may return undefined to drop the row.
 */
function entriesToSave<E extends { key?: string }, V>(
  rows: E[],
  initialRows: E[],
  original: Record<string, V> | undefined,
  prefix: string,
  filled: (row: E) => boolean,
  build: (row: E, previous: V | undefined, before: E | undefined) => V | undefined,
): Record<string, V> {
  const out: Record<string, V> = {};
  const stored = (row: E) => (row.key ? original?.[row.key] : undefined);
  const freshKey = keyMaker(prefix, rows.filter((r) => stored(r) !== undefined).map((r) => r.key!));
  for (const row of rows) {
    const previous = stored(row);
    const before = previous !== undefined ? initialRows.find((r) => r.key === row.key) : undefined;
    if (previous !== undefined && before && same(before, row)) {
      out[row.key!] = previous;
    } else if (filled(row) || (before !== undefined && !filled(before))) {
      // (An entry the form shows no value for, say an address with only
      // `full` text, is not dropped for looking empty.)
      const built = build(row, previous, before);
      if (built !== undefined) out[previous !== undefined ? row.key! : freshKey()] = built;
    }
  }
  return out;
}

// The address fields of the form, each with the component kinds it shows and
// the kind it writes.
const ADDRESS_FIELDS: Array<{ field: 'street' | 'locality' | 'region' | 'postcode' | 'country'; shows: string[]; kind: string }> = [
  { field: 'street', shows: ['number', 'name'], kind: 'name' },
  { field: 'locality', shows: ['locality'], kind: 'locality' },
  { field: 'region', shows: ['region'], kind: 'region' },
  { field: 'postcode', shows: ['postcode'], kind: 'postcode' },
  { field: 'country', shows: ['country'], kind: 'country' },
];

/**
 * An edited address's components. A field the user left alone keeps the
 * card's components for it, and so do the parts the form has no field for
 * (apartment, floor, PO box); a changed field replaces its own, in place.
 */
function addressComponentsToSave(
  row: AddressDraft,
  before: AddressDraft | undefined,
  previous: AddressComponent[] | undefined,
): AddressComponent[] {
  const kept = before && previous && previous.length > 0;
  let out: AddressComponent[] = kept ? [...previous] : [];
  ADDRESS_FIELDS.forEach(({ field, shows, kind }, i) => {
    if (kept && before[field] === row[field]) return;
    let at = out.findIndex((c) => shows.includes(c.kind));
    out = out.filter((c) => !shows.includes(c.kind));
    if (!row[field].trim()) return;
    if (at < 0) {
      // A part the address didn't have goes before the first later field's.
      const later = ADDRESS_FIELDS.slice(i + 1).flatMap((f) => f.shows);
      at = out.findIndex((c) => later.includes(c.kind));
    }
    out.splice(at < 0 ? out.length : at, 0, { kind, value: row[field].trim() });
  });
  // A removed part leaves its separator behind: keep one between two parts
  // and none at either end.
  return out.filter((c, i) => c.kind !== 'separator'
    || (i > 0 && i < out.length - 1 && out[i + 1].kind !== 'separator'));
}

/**
 * Build the JMAP patch. In edit mode every collection the form owns that ended
 * up empty is sent as `null` so the server clears it - omitting the key would
 * mean "unchanged" and the removed phone/address/note would come right back.
 * A property that comes out as the card already has it is left out, so a save
 * changes only what the user edited.
 * `media` is not part of it: see mediaForPhotoEdit.
 */
export function formToPatch(
  form: FormState,
  existing: ContactCard | undefined,
  asGroup: boolean,
  allContacts: ContactCard[],
  filledForm?: FormState,
): Partial<ContactCard> {
  const isEdit = !!existing;
  // The form as it was filled from the card: what a row is compared with to
  // tell whether the user touched it. The screen passes the one it filled,
  // since `existing` may be a newer copy of the card than the form shows.
  const initial = existing ? filledForm ?? contactToForm(existing, []) : undefined;
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
  const nameFields = (f: FormState) => [
    f.isOrg, f.prefix, f.given, f.middle, f.surname, f.suffix, f.full, f.isOrg ? f.orgs[0]?.name ?? '' : '',
  ];
  // An untouched name keeps what the form doesn't show (sort order, phonetics).
  const name: ContactCard['name'] | undefined =
    initial && existing?.name && same(nameFields(form), nameFields(initial))
      ? { ...existing.name, ...(full ? { full } : {}) }
      : components.length > 0 || full
        ? { ...(components.length > 0 ? { components, isOrdered: true } : {}), ...(full ? { full } : {}) }
        : undefined;

  const nicknames = entriesToSave<NicknameDraft, ContactNickname>(
    form.nicknames, initial?.nicknames ?? [], existing?.nicknames, 'n',
    (n) => !!n.name.trim(),
    (row, previous) => ({ ...previous, name: row.name.trim() }),
  );

  const emails = entriesToSave<EmailDraft, ContactEmail>(
    form.emails, initial?.emails ?? [], existing?.emails, 'e',
    (row) => !!row.address.trim(),
    (row, previous, before) => compact({
      ...previous,
      address: row.address.trim(),
      contexts: contextsToSave(row.context, previous?.contexts, before),
    }),
  );

  // A phone's features and label stay as stored until another type is picked.
  const phones = entriesToSave<PhoneDraft, ContactPhone>(
    form.phones, initial?.phones ?? [], existing?.phones, 'p',
    (row) => !!row.number.trim(),
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
  // RFC 9553 calls it "mobile"; a "cell" written by an older version of the
  // app or the webmail becomes "mobile" on any save.
  for (const [key, phone] of Object.entries(phones)) {
    if (!phone.features?.cell) continue;
    const features: Record<string, boolean> = { ...phone.features, mobile: true };
    delete features.cell;
    phones[key] = { ...phone, features };
  }

  // An address the form can't show (only `full` text) has empty fields; it is
  // kept as long as its row is untouched.
  const addresses = entriesToSave<AddressDraft, ContactAddress>(
    form.addresses, initial?.addresses ?? [], existing?.addresses, 'a',
    (a) => !!(a.street.trim() || a.locality.trim() || a.country.trim() || a.region.trim() || a.postcode.trim()),
    (row, previous, before) => {
      const contexts = contextsToSave(row.context, previous?.contexts, before);
      if (previous && before && ADDRESS_FIELDS.every(({ field }) => before[field] === row[field])) {
        return compact({ ...previous, contexts });
      }
      // The text copies of the address go: they would contradict the edit.
      const kept = { ...previous };
      for (const stale of ['components', 'full', 'fullAddress', 'street', 'locality', 'region', 'postcode', 'country'] as const) {
        delete kept[stale];
      }
      return compact({
        ...kept,
        components: addressComponentsToSave(row, before, previous?.components),
        isOrdered: true,
        defaultSeparator: previous?.defaultSeparator ?? ', ',
        countryCode: before && before.country === row.country ? previous?.countryCode : undefined,
        contexts,
      });
    },
  );

  // One form row is an organization and, by position, a title or a role.
  type Title = NonNullable<ContactCard['titles']>[string];
  const organizations: Record<string, ContactOrganization> = {};
  const titles: Record<string, Title> = {};
  const storedOrgs = existing?.organizations ?? {};
  const storedTitles: Record<string, Title> = existing?.titles ?? {};
  // Stored keys are never handed out again: a title may still point at one.
  const orgKey = keyMaker('o', Object.keys(storedOrgs));
  const titleKey = keyMaker('t', Object.keys(storedTitles));
  const roleKey = keyMaker('r', Object.keys(storedTitles));
  form.orgs.forEach((o) => {
    const before = o.key || o.titleKey
      ? initial?.orgs.find((r) => r.key === o.key && r.titleKey === o.titleKey)
      : undefined;
    const previousOrg = o.key ? storedOrgs[o.key] : undefined;
    const name = o.name.trim();
    const department = o.department.trim();
    if (before && previousOrg && before.name === o.name && before.department === o.department) {
      organizations[o.key!] = previousOrg;
    } else if (name || department) {
      // Further units stay until the department, the first one, is edited.
      const unitsKept = !!before && before.department === o.department;
      organizations[previousOrg ? o.key! : orgKey()] = compact({
        ...previousOrg,
        name: name || undefined,
        units: unitsKept ? previousOrg?.units : department ? [{ name: department }] : undefined,
      });
    }

    const previousTitle = o.titleKey ? storedTitles[o.titleKey] : undefined;
    const previousJob = previousTitle && previousTitle.kind !== 'role' ? previousTitle : undefined;
    const previousRole = previousTitle && previousTitle.kind === 'role' ? previousTitle : undefined;
    if (o.jobTitle.trim()) {
      titles[previousJob ? o.titleKey! : titleKey()] = previousJob && before?.jobTitle === o.jobTitle
        ? previousJob
        : { ...previousJob, name: o.jobTitle.trim(), kind: 'title' };
    }
    if (o.role.trim()) {
      titles[previousRole ? o.titleKey! : roleKey()] = previousRole && before?.role === o.role
        ? previousRole
        : { ...previousRole, name: o.role.trim(), kind: 'role' };
    }
  });
  // A title must not point at an organization that was removed.
  for (const [key, title] of Object.entries(titles)) {
    const linked = (title as { organizationId?: string }).organizationId;
    if (linked === undefined || organizations[linked]) continue;
    const unlinked = { ...title } as Title & { organizationId?: string };
    delete unlinked.organizationId;
    titles[key] = unlinked;
  }

  const anniversaries = entriesToSave<AnniversaryDraft, ContactAnniversary>(
    form.anniversaries, initial?.anniversaries ?? [], existing?.anniversaries, 'an',
    () => true,
    (row, previous, before) => {
      // An unchanged date keeps its stored form (a timestamp, another calendar).
      const date = previous && before?.date === row.date ? previous.date : stringToPartialDate(row.date);
      return date ? { ...previous, kind: row.kind as ContactAnniversary['kind'], date } : undefined;
    },
  );

  const onlineServices = entriesToSave<OnlineDraft, ContactOnlineService>(
    form.online, initial?.online ?? [], existing?.onlineServices, 'os',
    (s) => !!s.uri.trim(),
    (row, previous) => compact({
      ...previous,
      uri: row.uri.trim() || previous?.uri || '',
      service: row.service.trim() || undefined,
      label: row.label.trim() || undefined,
    }),
  );

  const personalInfo = entriesToSave<PersonalInfoDraft, ContactPersonalInfo>(
    form.personalInfo, initial?.personalInfo ?? [], existing?.personalInfo, 'pi',
    (p) => !!p.value.trim(),
    (row, previous) => compact({
      ...previous,
      kind: row.kind as ContactPersonalInfo['kind'],
      value: row.value.trim(),
      level: (row.level || undefined) as ContactPersonalInfo['level'],
    }),
  );

  const notes = entriesToSave<NoteDraft, ContactNote>(
    form.notes, initial?.notes ?? [], existing?.notes, 'n',
    (n) => !!n.note.trim(),
    (row, previous) => ({ ...previous, note: row.note.trim() }),
  );

  const keywords: Record<string, boolean> = {};
  form.keywords.forEach((k) => {
    if (k.trim()) keywords[k.trim()] = true;
  });

  // The form edits the first pronouns entry and the card's others stay;
  // emptying the field clears them all, or the next one would show up in it.
  const storedPronouns = Object.entries(existing?.speakToAs?.pronouns ?? {});
  const pronouns = form.pronouns.trim()
    ? {
      [storedPronouns[0]?.[0] ?? 'p0']: { ...storedPronouns[0]?.[1], pronouns: form.pronouns.trim() },
      ...Object.fromEntries(storedPronouns.slice(1)),
    }
    : {};
  const speakToAs = compact({
    ...existing?.speakToAs,
    grammaticalGender: form.grammaticalGender || undefined,
    pronouns: Object.keys(pronouns).length > 0 ? pronouns : undefined,
  });

  // A property: its value when it has one and the card's differs; `null` on
  // edit when the form emptied one the card had (clears it server-side);
  // left out otherwise.
  const property = (key: keyof ContactCard, value: object | undefined): Record<string, unknown> => {
    const stored = existing?.[key];
    if (value && Object.keys(value).length > 0) return same(value, stored) ? {} : { [key]: value };
    return isEdit && stored !== undefined ? { [key]: null } : {};
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
    ...property('name', name),
    ...property('nicknames', nicknames),
    ...property('emails', emails),
    ...property('phones', phones),
    ...property('addresses', addresses),
    ...property('organizations', organizations),
    ...property('titles', titles),
    ...property('anniversaries', anniversaries),
    ...property('onlineServices', onlineServices),
    ...property('personalInfo', personalInfo),
    ...property('notes', notes),
    ...property('keywords', keywords),
    ...property('speakToAs', speakToAs),
    ...linksToPatch(existing, {
      calendarUri: form.calendarUri.trim(),
      freeBusyUri: form.freeBusyUri.trim(),
      schedulingUri: form.schedulingUri.trim(),
    }),
    // No `media`: an update without it keeps every entry on the server, and
    // the form adds one only when the photo changed (mediaForPhotoEdit). A
    // map built here from the card's copy deleted a photo stored as a blob
    // (Stalwart 1.0) on every save.
  };

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
