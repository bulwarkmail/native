/**
 * JSContact contexts, features, kinds and relation types ↔ the TYPE/LABEL
 * columns of Android's typed data kinds (docs/device-sync.md, "Contacts
 * mapping"). Uploads replace only the vocabulary a TYPE stands for and keep
 * the rest (a phone's `text` feature, a `school` context).
 */
import {
  ContactEventType,
  EmailType,
  PhoneType,
  PostalType,
  RelationType,
  WebsiteType,
} from '../android-columns';

const on = (flags: unknown, name: string) =>
  !!flags && typeof flags === 'object' && (flags as Record<string, unknown>)[name] === true;

/** TYPE + LABEL as the row holds them. */
export interface TypeCells {
  type: number;
  label: string | null;
}

/** What a TYPE says about an entry: the contexts, features and label to upload. */
export interface EntryFlags {
  contexts: string[];
  features?: string[];
  /** The label a custom type carries; null removes the entry's label. */
  label: string | null;
}

function labelled(label: unknown, type: number, custom: number): TypeCells {
  return typeof label === 'string' && label.trim() ? { type: custom, label } : { type, label: null };
}

/**
 * Android types RFC 9553 has no word for upload as a label naming them; that
 * label (exactly as written) names the type again on the way back.
 */
function namedType(labels: Record<number, string>, label: unknown): number | null {
  const hit = Object.entries(labels).find(([, name]) => name === label);
  return hit ? Number(hit[0]) : null;
}

// ─── Emails ────────────────────────────────────────────

const EMAIL_LABELS: Record<number, string> = { [EmailType.MOBILE]: 'mobile' };

export function emailType(entry: { contexts?: unknown; label?: unknown }): TypeCells {
  const named = namedType(EMAIL_LABELS, entry.label);
  if (named !== null) return { type: named, label: null };
  const type = on(entry.contexts, 'private') ? EmailType.HOME : on(entry.contexts, 'work') ? EmailType.WORK : EmailType.OTHER;
  return labelled(entry.label, type, EmailType.CUSTOM);
}

export function emailFlags(type: number | null, label: string | null): EntryFlags {
  switch (type) {
    case EmailType.HOME: return { contexts: ['private'], label: null };
    case EmailType.WORK: return { contexts: ['work'], label: null };
    case EmailType.MOBILE: return { contexts: [], label: EMAIL_LABELS[EmailType.MOBILE] };
    case EmailType.CUSTOM: return { contexts: [], label };
    default: return { contexts: [], label: null };
  }
}

// ─── Phones ────────────────────────────────────────────

/**
 * First match wins, as in the design's table; `cell` is read as `mobile`. A
 * label naming a type RFC 9553 lacks, next to the feature that type uploads
 * with, is that type (a custom "car" uploads without the feature).
 */
export function phoneType(entry: { features?: unknown; contexts?: unknown; label?: unknown }): TypeCells {
  const f = (n: string) => on(entry.features, n);
  const c = (n: string) => on(entry.contexts, n);
  const named = namedType(PHONE_LABELS, entry.label);
  if (named !== null && (phoneFlags(named, null).features ?? []).every(f)) return { type: named, label: null };
  const mobile = f('mobile') || f('cell');
  let type: number = PhoneType.OTHER;
  if (mobile && c('work')) type = PhoneType.WORK_MOBILE;
  else if (mobile) type = PhoneType.MOBILE;
  else if (f('fax') && c('work')) type = PhoneType.FAX_WORK;
  else if (f('fax') && c('private')) type = PhoneType.FAX_HOME;
  else if (f('fax')) type = PhoneType.OTHER_FAX;
  else if (f('pager') && c('work')) type = PhoneType.WORK_PAGER;
  else if (f('pager')) type = PhoneType.PAGER;
  else if (f('textphone')) type = PhoneType.TTY_TDD;
  else if (f('main-number') && c('work')) type = PhoneType.COMPANY_MAIN;
  else if (f('main-number')) type = PhoneType.MAIN;
  else if (c('work')) type = PhoneType.WORK;
  else if (c('private')) type = PhoneType.HOME;
  return labelled(entry.label, type, PhoneType.CUSTOM);
}

/** The features a phone TYPE stands for; uploads swap these and keep the others. */
export const PHONE_TYPE_FEATURES = ['mobile', 'cell', 'fax', 'pager', 'textphone', 'main-number', 'voice'];

const PHONE_LABELS: Record<number, string> = {
  [PhoneType.CALLBACK]: 'callback',
  [PhoneType.CAR]: 'car',
  [PhoneType.ISDN]: 'isdn',
  [PhoneType.RADIO]: 'radio',
  [PhoneType.TELEX]: 'telex',
  [PhoneType.ASSISTANT]: 'assistant',
  [PhoneType.MMS]: 'mms',
};

export function phoneFlags(type: number | null, label: string | null): EntryFlags {
  switch (type) {
    case PhoneType.WORK_MOBILE: return { contexts: ['work'], features: ['mobile'], label: null };
    case PhoneType.MOBILE: return { contexts: [], features: ['mobile'], label: null };
    case PhoneType.FAX_WORK: return { contexts: ['work'], features: ['fax'], label: null };
    case PhoneType.FAX_HOME: return { contexts: ['private'], features: ['fax'], label: null };
    case PhoneType.OTHER_FAX: return { contexts: [], features: ['fax'], label: null };
    case PhoneType.WORK_PAGER: return { contexts: ['work'], features: ['pager'], label: null };
    case PhoneType.PAGER: return { contexts: [], features: ['pager'], label: null };
    case PhoneType.TTY_TDD: return { contexts: [], features: ['textphone'], label: null };
    case PhoneType.MAIN: return { contexts: [], features: ['main-number'], label: null };
    case PhoneType.COMPANY_MAIN: return { contexts: ['work'], features: ['main-number'], label: null };
    case PhoneType.WORK: return { contexts: ['work'], features: ['voice'], label: null };
    case PhoneType.HOME: return { contexts: ['private'], features: ['voice'], label: null };
    case PhoneType.MMS: return { contexts: [], features: ['text'], label: PHONE_LABELS[PhoneType.MMS] };
    case PhoneType.CUSTOM: return { contexts: [], features: [], label };
    case null:
    case PhoneType.OTHER: return { contexts: [], features: [], label: null };
    default: return { contexts: [], features: ['voice'], label: PHONE_LABELS[type] ?? null };
  }
}

// ─── Addresses and websites ────────────────────────────

export function postalType(entry: { contexts?: unknown; label?: unknown }): TypeCells {
  const type = on(entry.contexts, 'private') ? PostalType.HOME : on(entry.contexts, 'work') ? PostalType.WORK : PostalType.OTHER;
  return labelled(entry.label, type, PostalType.CUSTOM);
}

export function postalFlags(type: number | null, label: string | null): EntryFlags {
  switch (type) {
    case PostalType.HOME: return { contexts: ['private'], label: null };
    case PostalType.WORK: return { contexts: ['work'], label: null };
    case PostalType.CUSTOM: return { contexts: [], label };
    default: return { contexts: [], label: null };
  }
}

export function websiteType(entry: { contexts?: unknown; label?: unknown }): TypeCells {
  const named = namedType(WEBSITE_LABELS, entry.label);
  if (named !== null) return { type: named, label: null };
  const type = on(entry.contexts, 'private') ? WebsiteType.HOME : on(entry.contexts, 'work') ? WebsiteType.WORK : WebsiteType.OTHER;
  return labelled(entry.label, type, WebsiteType.CUSTOM);
}

const WEBSITE_LABELS: Record<number, string> = {
  [WebsiteType.HOMEPAGE]: 'homepage',
  [WebsiteType.BLOG]: 'blog',
  [WebsiteType.PROFILE]: 'profile',
  [WebsiteType.FTP]: 'ftp',
};

export function websiteFlags(type: number | null, label: string | null): EntryFlags {
  switch (type) {
    case WebsiteType.HOME: return { contexts: ['private'], label: null };
    case WebsiteType.WORK: return { contexts: ['work'], label: null };
    case WebsiteType.CUSTOM: return { contexts: [], label };
    case null:
    case WebsiteType.OTHER: return { contexts: [], label: null };
    default: return { contexts: [], label: WEBSITE_LABELS[type] ?? null };
  }
}

/** Contexts the TYPEs above speak for; others are kept on upload. */
export const TYPED_CONTEXTS = ['private', 'work'];

// ─── Anniversaries ─────────────────────────────────────

export function eventType(kind: unknown): TypeCells {
  switch (kind) {
    case 'birth': return { type: ContactEventType.BIRTHDAY, label: null };
    case 'wedding': return { type: ContactEventType.ANNIVERSARY, label: null };
    case 'other': return { type: ContactEventType.OTHER, label: null };
    default: return { type: ContactEventType.CUSTOM, label: typeof kind === 'string' && kind ? kind : null };
  }
}

/** The anniversary kind for a device TYPE; a custom label becomes the kind itself. */
export function eventKind(type: number | null, label: string | null): string {
  switch (type) {
    case ContactEventType.BIRTHDAY: return 'birth';
    case ContactEventType.ANNIVERSARY: return 'wedding';
    case ContactEventType.CUSTOM: return label?.trim() ? label.trim().toLowerCase() : 'other';
    default: return 'other';
  }
}

// ─── Relations ─────────────────────────────────────────

/** RFC 9553 relation types in the order they pick the device TYPE. */
const RELATION_TO_TYPE: Array<[string, number]> = [
  ['friend', RelationType.FRIEND],
  ['spouse', RelationType.SPOUSE],
  ['child', RelationType.CHILD],
  ['parent', RelationType.PARENT],
  ['sibling', RelationType.RELATIVE],
  ['kin', RelationType.RELATIVE],
  ['agent', RelationType.ASSISTANT],
];

export function relationType(relation: unknown): TypeCells {
  const types = relation && typeof relation === 'object'
    ? Object.keys(relation as object).filter((k) => on(relation, k))
    : [];
  for (const [name, type] of RELATION_TO_TYPE) if (types.includes(name)) return { type, label: null };
  return { type: RelationType.CUSTOM, label: types[0] ?? null };
}

/** Device types without an RFC 9553 twin upload as the nearest one. */
const TYPE_TO_RELATION: Record<number, string> = {
  [RelationType.SPOUSE]: 'spouse',
  [RelationType.CHILD]: 'child',
  [RelationType.PARENT]: 'parent',
  [RelationType.FRIEND]: 'friend',
  [RelationType.RELATIVE]: 'kin',
  [RelationType.ASSISTANT]: 'agent',
  [RelationType.BROTHER]: 'sibling',
  [RelationType.SISTER]: 'sibling',
  [RelationType.MOTHER]: 'parent',
  [RelationType.FATHER]: 'parent',
  [RelationType.MANAGER]: 'colleague',
  [RelationType.DOMESTIC_PARTNER]: 'spouse',
  [RelationType.PARTNER]: 'spouse',
  [RelationType.REFERRED_BY]: 'contact',
};

export function relationName(type: number | null, label: string | null): string | null {
  if (type === RelationType.CUSTOM || type === null) return label?.trim() ? label.trim().toLowerCase() : null;
  return TYPE_TO_RELATION[type] ?? null;
}

/** The relation types a device TYPE covers, removed when the TYPE changes. */
export function relationTypesOf(type: number | null, label: string | null): string[] {
  const covered = RELATION_TO_TYPE.filter(([, t]) => t === type).map(([name]) => name);
  const own = relationName(type, label);
  if (own && !covered.includes(own)) covered.push(own);
  return covered;
}
