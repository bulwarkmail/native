// What the contact form starts from, and when it may save. Kept apart from
// ContactFormScreen so it can be tested without React Native.
//
// An edit form must start from its card: `formToPatch` sends `null` for every
// collection the form owns that is empty, so a blank form saved as an edit
// wipes the card. The card may not be in the store when the form opens (a
// cold-start `/contacts/<id>/edit` link, contacts still loading), so the form
// is seeded when the card arrives and cannot save before then.
import type { ContactCard, ContactAddress } from '../api/types';
import { normalizeContactPhotoUri, partialDateToString, getCustomFullName } from './contact-utils';
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
 * Whether the form may save: an edit only once its card is loaded. Without
 * the card an edit must neither patch (a blank form clears it) nor fall
 * through to creating a new card.
 */
export function canSaveContactForm({ isEdit, existing }: { isEdit: boolean; existing: ContactCard | undefined }): boolean {
  return !isEdit || !!existing;
}
