// What the contact form starts from, and when it may save. Kept apart from
// ContactFormScreen so it can be tested without React Native.
//
// An edit form must start from its card: `formToPatch` sends `null` for every
// collection the form owns that is empty, so a blank form saved as an edit
// wipes the card. The card may not be in the store when the form opens (a
// cold-start `/contacts/<id>/edit` link, contacts still loading), so the form
// is seeded when the card arrives and cannot save before then.
import type {
  ContactCard, ContactEmail, ContactPhone, ContactAddress, ContactOrganization,
  ContactAnniversary, ContactNote, ContactMedia, ContactOnlineService,
  ContactPersonalInfo, ContactNickname,
} from '../api/types';
import {
  normalizeContactPhotoUri, partialDateToString, stringToPartialDate, getCustomFullName, deriveFullName,
} from './contact-utils';
import { contactLinkPatch } from './contact-wire';
import { sanitizeDisplayName, splitMailbox } from './rfc5322-mailbox';

interface EmailDraft { address: string; context: string }
interface PhoneDraft { number: string; context: string; feature: string }
interface AddressDraft {
  street: string;
  locality: string;
  region: string;
  postcode: string;
  country: string;
  context: string;
}
interface OrgDraft { name: string; department: string; jobTitle: string; role: string }
interface AnniversaryDraft { kind: string; date: string }
interface OnlineDraft { uri: string; service: string; label: string }
interface PersonalInfoDraft { kind: string; level: string; value: string }
interface NoteDraft { note: string }

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
  photoUri: string;
  photoMediaType: string;
  /** Group members (contact ids from the store), only used when editing a group. */
  members: string[];
}

function blankForm(): FormState {
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
    photoUri: '',
    photoMediaType: '',
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
      context: a.contexts?.work ? 'work' : a.contexts?.private ? 'private' : '',
    };
  }
  return {
    street: a.street || '',
    locality: a.locality || '',
    region: a.region || '',
    postcode: a.postcode || '',
    country: a.country || '',
    context: a.contexts?.work ? 'work' : a.contexts?.private ? 'private' : '',
  };
}

function contactToForm(contact: ContactCard, memberIds: string[]): FormState {
  const prefix = findNameComponent(contact, 'title', 'prefix');
  const given = findNameComponent(contact, 'given');
  const middle = findNameComponent(contact, 'given2', 'additional', 'middle');
  const surname = findNameComponent(contact, 'surname');
  const suffix = findNameComponent(contact, 'generation', 'suffix');

  const nicknames = contact.nicknames
    ? Object.values(contact.nicknames).map((n) => n.name || '').filter(Boolean)
    : [];

  const emails = contact.emails ? Object.values(contact.emails).map((e) => ({
    address: e.address,
    context: e.contexts?.work ? 'work' : e.contexts?.private ? 'private' : '',
  })) : [];

  const phones = contact.phones ? Object.values(contact.phones).map((p) => ({
    number: p.number,
    context: p.contexts?.work ? 'work' : p.contexts?.private ? 'private' : '',
    feature:
      p.features?.cell ? 'cell'
        : p.features?.fax ? 'fax'
          : p.features?.pager ? 'pager'
            : p.features?.video ? 'video'
              : p.features?.text ? 'text'
                : p.features?.voice ? 'voice'
                  : '',
  })) : [];

  const addresses = contact.addresses ? Object.values(contact.addresses).map(addressToFlat) : [];

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

  const anniversaries = contact.anniversaries ? Object.values(contact.anniversaries).map((a) => ({
    kind: a.kind || 'birth',
    date: partialDateToString(a.date),
  })) : [];

  const online = contact.onlineServices ? Object.values(contact.onlineServices).map((s) => ({
    uri: s.uri || '',
    service: s.service || '',
    label: s.label || '',
  })) : [];

  const personalInfo = contact.personalInfo ? Object.values(contact.personalInfo).map((pi) => ({
    kind: pi.kind || 'hobby',
    level: pi.level || '',
    value: pi.value || '',
  })) : [];

  const notes = contact.notes ? Object.values(contact.notes).map((n) => ({ note: n.note })) : [];

  const keywords = contact.keywords
    ? Object.keys(contact.keywords).filter((k) => contact.keywords![k])
    : [];

  const addressBookId = Object.keys(contact.addressBookIds || {})
    .find((id) => contact.addressBookIds[id]) || '';

  const photoEntry = contact.media
    ? Object.values(contact.media).find((m) => m.kind === 'photo')
    : undefined;
  // Stalwart may hand back `data:base64,…` without a media type (#307).
  const photoUri = photoEntry?.uri ? normalizeContactPhotoUri(photoEntry.uri, photoEntry.mediaType) : '';
  const photoMediaType = photoEntry?.mediaType || (photoUri.startsWith('data:image/jpeg') ? 'image/jpeg' : '');

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
    personalInfo, notes, keywords, addressBookId, photoUri, photoMediaType,
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
 * Build the JMAP patch. In edit mode every collection the form owns that ended
 * up empty is sent as `null` so the server clears it - omitting the key would
 * mean "unchanged" and the removed phone/address/note would come right back.
 */
export function formToPatch(
  form: FormState,
  existing: ContactCard | undefined,
  asGroup: boolean,
  allContacts: ContactCard[],
): Partial<ContactCard> {
  const isEdit = !!existing;
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

  const emails: Record<string, ContactEmail> = {};
  form.emails.filter((e) => e.address.trim()).forEach((e, i) => {
    emails[`e${i + 1}`] = {
      address: e.address.trim(),
      ...(e.context ? { contexts: { [e.context]: true } } : {}),
    };
  });

  const phones: Record<string, ContactPhone> = {};
  form.phones.filter((p) => p.number.trim()).forEach((p, i) => {
    phones[`p${i + 1}`] = {
      number: p.number.trim(),
      ...(p.context ? { contexts: { [p.context]: true } } : {}),
      ...(p.feature ? { features: { [p.feature]: true } } : {}),
    };
  });

  const addresses: Record<string, ContactAddress> = {};
  form.addresses
    .filter((a) => a.street.trim() || a.locality.trim() || a.country.trim() || a.region.trim() || a.postcode.trim())
    .forEach((a, i) => {
      const comps: Array<{ kind: string; value: string }> = [];
      if (a.street.trim()) comps.push({ kind: 'name', value: a.street.trim() });
      if (a.locality.trim()) comps.push({ kind: 'locality', value: a.locality.trim() });
      if (a.region.trim()) comps.push({ kind: 'region', value: a.region.trim() });
      if (a.postcode.trim()) comps.push({ kind: 'postcode', value: a.postcode.trim() });
      if (a.country.trim()) comps.push({ kind: 'country', value: a.country.trim() });
      addresses[`a${i + 1}`] = {
        components: comps,
        isOrdered: true,
        defaultSeparator: ', ',
        ...(a.context ? { contexts: { [a.context]: true } } : {}),
      };
    });

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

  const anniversaries: Record<string, ContactAnniversary> = {};
  form.anniversaries.forEach((a, i) => {
    const date = stringToPartialDate(a.date);
    if (!date) return;
    anniversaries[`an${i + 1}`] = { kind: a.kind as ContactAnniversary['kind'], date };
  });

  const onlineServices: Record<string, ContactOnlineService> = {};
  form.online.filter((s) => s.uri.trim()).forEach((s, i) => {
    onlineServices[`os${i + 1}`] = {
      uri: s.uri.trim(),
      ...(s.service.trim() ? { service: s.service.trim() } : {}),
      ...(s.label.trim() ? { label: s.label.trim() } : {}),
    };
  });

  const personalInfo: Record<string, ContactPersonalInfo> = {};
  form.personalInfo.filter((p) => p.value.trim()).forEach((p, i) => {
    personalInfo[`pi${i + 1}`] = {
      kind: p.kind as ContactPersonalInfo['kind'],
      value: p.value.trim(),
      ...(p.level ? { level: p.level as 'high' | 'medium' | 'low' } : {}),
    };
  });

  const notes: Record<string, ContactNote> = {};
  form.notes.forEach((n, i) => {
    if (n.note.trim()) notes[`n${i + 1}`] = { note: n.note.trim() };
  });

  const keywords: Record<string, boolean> = {};
  form.keywords.forEach((k) => {
    if (k.trim()) keywords[k.trim()] = true;
  });

  // Media: keep every non-photo entry (logo, sound) the card already has and
  // write the photo back under its original key.
  const media: Record<string, ContactMedia> = {};
  let photoKey = 'photo';
  if (existing?.media) {
    for (const [key, m] of Object.entries(existing.media)) {
      if (m.kind === 'photo') photoKey = key;
      else media[key] = m;
    }
  }
  if (form.photoUri.trim()) {
    media[photoKey] = {
      kind: 'photo',
      uri: form.photoUri.trim(),
      ...(form.photoMediaType ? { mediaType: form.photoMediaType } : {}),
    };
  }

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
    ...contactLinkPatch(existing, {
      calendarUri: form.calendarUri.trim(),
      schedulingUri: form.schedulingUri.trim(),
      freeBusyUri: form.freeBusyUri.trim(),
    }),
    ...collection('media', media),
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

/** A new contact's starting values, from a link or "Add to contacts". */
export interface ContactFormPrefill {
  email?: string;
  name?: string;
}

export interface ContactFormSeedOptions {
  /** The book a new contact goes in (an edit keeps the card's own). */
  addressBookId?: string;
  /** A group's members: its current ones when editing, the picked ones when creating. */
  memberIds?: string[];
}

/** The form for `existing` when there is one, else a new contact's, prefilled. */
export function contactFormSeed(
  existing: ContactCard | undefined,
  prefill: ContactFormPrefill | undefined,
  { addressBookId = '', memberIds = [] }: ContactFormSeedOptions = {},
): FormState {
  if (existing) return contactToForm(existing, memberIds);
  const init = blankForm();
  init.addressBookId = addressBookId;
  init.members = memberIds;
  // "Add sender to contacts": split the display name like the webmail
  // (first word -> given, rest -> surname) and never let a mailbox-shaped
  // name through (#672).
  let name = sanitizeDisplayName(prefill?.name);
  if (prefill?.email) {
    const mailbox = splitMailbox(name ? `${name} <${prefill.email}>` : prefill.email);
    init.emails = [{ address: mailbox.email, context: '' }];
    name = mailbox.name || '';
  }
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length > 0) {
    init.given = parts[0];
    init.surname = parts.slice(1).join(' ');
  }
  return init;
}

/**
 * The accounts a form's seed is checked against. Card ids repeat across
 * accounts, so an id match alone would take another account's card.
 */
export interface ContactFormAccounts {
  /** The app account the form edits or creates in. */
  formAccount: string | null | undefined;
  /** The app account shown now, whose card `existing` is. */
  shownAccount: string | null | undefined;
  /** The app account `seededFrom` came from. */
  seededAccount: string | null | undefined;
}

/**
 * Whether the form shows `existing` now: when it was not seeded from this
 * card yet (whatever the user did meanwhile: the fields were hidden), or when
 * the card changed (a refresh, the server's copy replacing the cached one)
 * before the user typed. Once they have typed the form keeps their values and
 * the card they started from. Never from another account's card: while
 * another account is shown, its card with the same id is not this one.
 */
export function shouldSeedContactForm({ seededFrom, existing, dirty, formAccount, shownAccount, seededAccount }: {
  seededFrom: ContactCard | undefined;
  existing: ContactCard | undefined;
  dirty: boolean;
} & ContactFormAccounts): boolean {
  if (!existing || !formAccount || shownAccount !== formAccount) return false;
  if (seededFrom?.id !== existing.id || seededAccount !== formAccount) return true;
  return !dirty && seededFrom !== existing;
}

/**
 * What an edit's patch is relative to: the card the form was seeded from,
 * the one the user saw, not the store's newer copy. Against the newer copy,
 * whatever it gained since (the server photo replacing the cached card's,
 * which has none; a phone added elsewhere) would be sent as `null` and
 * cleared, though the user never saw it.
 */
export function contactFormPatchBase({ isEdit, seededFrom }: {
  isEdit: boolean;
  seededFrom: ContactCard | undefined;
}): ContactCard | undefined {
  return isEdit ? seededFrom : undefined;
}

/**
 * Whether the form may save: an edit only once it shows its card, seeded in
 * the form's account while that account is shown. Without it an edit must
 * neither patch (a blank form clears the card, another account's values
 * overwrite this one's) nor fall through to creating a new card.
 */
export function canSaveContactForm({ isEdit, existing, seededFrom, formAccount, shownAccount, seededAccount }: {
  isEdit: boolean;
  existing: ContactCard | undefined;
  seededFrom?: ContactCard;
} & ContactFormAccounts): boolean {
  if (!isEdit) return true;
  return !!existing && !!formAccount && shownAccount === formAccount
    && seededAccount === formAccount && seededFrom?.id === existing.id;
}

/** What an edit form without its card says instead of the fields. */
export type ContactFormMissingState = 'switched' | 'loading' | 'not_found' | 'needs_connection' | 'load_failed';

/**
 * Why an edit form has no card to show: another account is shown (its cards
 * are not this form's), the lookup is still running, the live cards lack it,
 * there is no connection (only the cache, which keeps no photos, so an edit
 * from it would clear the photo), or the server was reached but the load
 * failed.
 */
export function contactFormMissingState({ formAccountShown, lookedUp, liveCards, online, connected, loadFailed }: {
  formAccountShown: boolean;
  lookedUp: boolean;
  liveCards: boolean;
  online: boolean;
  connected: boolean;
  loadFailed: boolean;
}): ContactFormMissingState {
  if (!formAccountShown) return 'switched';
  if (!lookedUp) return 'loading';
  if (liveCards) return 'not_found';
  if (!online || !connected) return 'needs_connection';
  return loadFailed ? 'load_failed' : 'needs_connection';
}
