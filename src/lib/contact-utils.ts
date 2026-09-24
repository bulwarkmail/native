import type {
  ContactCard,
  AnniversaryDate,
  NameComponent,
  PartialDate,
  Timestamp,
} from '../api/types';

export function getContactDisplayName(contact: ContactCard): string {
  if (contact.name) {
    // given + surname only, like the webmail: keeps sort order, dedupe keys
    // and initials identical across clients (the middle name is shown by the
    // detail screen, not by the list).
    if (contact.name.components && contact.name.components.length > 0) {
      const given = contact.name.components.find((c) => c.kind === 'given')?.value || '';
      const surname = contact.name.components.find((c) => c.kind === 'surname')?.value || '';
      const full = [given, surname].filter(Boolean).join(' ');
      if (full) return full;
    }
    if (contact.name.full) return contact.name.full;
  }
  if (contact.nicknames) {
    const nick = Object.values(contact.nicknames)[0];
    if (nick?.name) return nick.name;
  }
  if (contact.organizations) {
    const org = Object.values(contact.organizations)[0];
    if (org?.name) return org.name;
  }
  if (contact.emails) {
    const email = Object.values(contact.emails)[0];
    if (email?.address) return email.address;
  }
  return '';
}

// Name used to order (and letter-group) the contact list. With `byLastName`
// the surname leads ("Smith, Alice") so family members sit together (#963).
// Contacts without a structured surname fall back to the last word of
// `name.full`; everything else (nickname, org, email) keeps the display name.
// Same rules as the webmail's getContactSortName.
export function getContactSortName(contact: ContactCard, byLastName: boolean): string {
  const display = getContactDisplayName(contact);
  if (!byLastName) return display;
  const components = contact.name?.components;
  if (components && components.length > 0) {
    const pick = (...kinds: string[]) =>
      components.filter((c) => kinds.includes(c.kind) && c.value).map((c) => c.value).join(' ');
    const surname = pick('surname', 'surname2');
    if (surname) {
      const rest = pick('given', 'given2', 'middle', 'additional');
      return rest ? `${surname}, ${rest}` : surname;
    }
  }
  const full = contact.name?.full;
  if (full && display === full) {
    const words = full.trim().split(/\s+/);
    if (words.length > 1) {
      const last = words[words.length - 1];
      return `${last}, ${words.slice(0, -1).join(' ')}`;
    }
  }
  return display;
}

export function getContactPrimaryEmail(contact: ContactCard): string {
  if (!contact.emails) return '';
  const entries = Object.values(contact.emails);
  const preferred = entries.find((e) => e.pref === 1);
  return (preferred || entries[0])?.address || '';
}

export function getContactPrimaryPhone(contact: ContactCard): string {
  if (!contact.phones) return '';
  const entries = Object.values(contact.phones);
  const preferred = entries.find((p) => p.pref === 1);
  return (preferred || entries[0])?.number || '';
}

export function getPrimaryOrg(contact: ContactCard): string {
  if (!contact.organizations) return '';
  const org = Object.values(contact.organizations)[0];
  return org?.name || '';
}

export function getPrimaryTitle(contact: ContactCard): string {
  if (!contact.titles) return '';
  const title = Object.values(contact.titles)[0];
  return title?.name || '';
}

/**
 * `name.full` derived from the name components in display order (prefix,
 * given, middle, surname, suffix), as the webmail's form writes it. Every
 * write should carry `full`: the vCard FN is built from it, FN is mandatory
 * (RFC 6350 §6.2.1), and strict CardDAV clients such as Apple Contacts drop
 * cards without it (#430).
 */
export function deriveFullName(components: readonly NameComponent[] | undefined): string {
  const find = (...kinds: string[]) =>
    components?.find((c) => kinds.includes(c.kind))?.value?.trim() || '';
  return [
    find('title', 'prefix'),
    find('given'),
    find('given2', 'additional', 'middle'),
    find('surname'),
    find('generation', 'suffix'),
  ].filter(Boolean).join(' ');
}

/**
 * The card's `name.full` when it is a display name of its own. Empty when it
 * only repeats what `deriveFullName` (or, on an organization card, the
 * organization name) gives, so an edit form re-derives it from the edited
 * fields on save instead of writing back a stale copy (#430).
 */
export function getCustomFullName(contact: ContactCard, orgName?: string): string {
  const full = contact.name?.full?.trim() || '';
  if (!full) return '';
  if (full === deriveFullName(contact.name?.components)) return '';
  if (orgName && full === orgName.trim()) return '';
  return full;
}

export function getContactInitials(contact: ContactCard): string {
  const name = getContactDisplayName(contact).trim();
  if (!name) return '?';
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase();
  }
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Some JMAP servers (notably Stalwart, see webmail #307) emit photo data URIs
// without a mediatype, like `data:base64,...` or `data:;base64,...`. Per
// RFC 2397 the missing/empty mediatype defaults to `text/plain`, so RN's
// Image cannot decode the bytes. Rewrite to include a mediatype.
export function normalizeContactPhotoUri(uri: string, mediaType?: string): string {
  const mime = mediaType && mediaType.includes('/') ? mediaType : 'image/jpeg';
  if (uri.startsWith('data:base64,')) {
    return `data:${mime};base64,${uri.slice('data:base64,'.length)}`;
  }
  if (uri.startsWith('data:;base64,')) {
    return `data:${mime};base64,${uri.slice('data:;base64,'.length)}`;
  }
  return uri;
}

export function getContactPhotoUri(contact: ContactCard): string | undefined {
  if (!contact.media) return undefined;
  for (const media of Object.values(contact.media)) {
    if (media.kind === 'photo' && media.uri) {
      return normalizeContactPhotoUri(media.uri, media.mediaType);
    }
  }
  return undefined;
}

/**
 * Lossless PartialDate → input string: `1990-05-04`, `1990-05`, `1990`,
 * `--05-04`, `--05`, `---04`. Never pads a missing month/day with `01` (that
 * used to rewrite a year-only birthday to Jan 1 on the next save).
 */
export function partialDateToString(d: AnniversaryDate | undefined): string {
  if (!d) return '';
  if (typeof d === 'string') return d;
  if (typeof d === 'object') {
    if ('@type' in d && d['@type'] === 'Timestamp') {
      return typeof d.utc === 'string' ? d.utc.split('T')[0] : '';
    }
    const pd = d as PartialDate;
    const yr = pd.year ? String(pd.year).padStart(4, '0') : '';
    const mo = pd.month ? String(pd.month).padStart(2, '0') : '';
    const da = pd.day ? String(pd.day).padStart(2, '0') : '';
    if (yr && mo && da) return `${yr}-${mo}-${da}`;
    if (yr && mo) return `${yr}-${mo}`;
    if (yr) return yr;
    if (mo && da) return `--${mo}-${da}`;
    if (mo) return `--${mo}`;
    if (da) return `---${da}`;
  }
  return '';
}

/**
 * Parse a typed date into an RFC 9553 PartialDate. Accepts the extended and
 * basic vCard forms (`YYYY-MM-DD`, `YYYYMMDD`, `YYYY-MM`, `YYYY`, `--MM-DD`,
 * `--MMDD`, `--MM`, `---DD`) and an optional trailing time part, which is
 * dropped. Returns null for anything else - Stalwart rejects string dates, so
 * free text must never reach the server.
 */
export function stringToPartialDate(s: string): PartialDate | null {
  const datePart = s.trim().split(/[T ]/)[0];
  if (!datePart) return null;
  const mk = (year?: number, month?: number, day?: number): PartialDate | null => {
    if (month !== undefined && (month < 1 || month > 12)) return null;
    if (day !== undefined && (day < 1 || day > 31)) return null;
    const pd: PartialDate = {};
    if (year !== undefined) pd.year = year;
    if (month !== undefined) pd.month = month;
    if (day !== undefined) pd.day = day;
    return Object.keys(pd).length > 0 ? pd : null;
  };
  const n = (v: string | undefined) => (v === undefined ? undefined : parseInt(v, 10));
  let m = datePart.match(/^---(\d{2})$/);
  if (m) return mk(undefined, undefined, n(m[1]));
  m = datePart.match(/^--(\d{2})-?(\d{2})$/);
  if (m) return mk(undefined, n(m[1]), n(m[2]));
  m = datePart.match(/^--(\d{2})$/);
  if (m) return mk(undefined, n(m[1]));
  m = datePart.match(/^(\d{4})-?(\d{2})-?(\d{2})$/);
  if (m) return mk(n(m[1]), n(m[2]), n(m[3]));
  m = datePart.match(/^(\d{4})-(\d{2})$/);
  if (m) return mk(n(m[1]), n(m[2]));
  m = datePart.match(/^(\d{4})$/);
  if (m) return mk(n(m[1]));
  return null;
}

const MONTH_NAMES_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatPartialDate(dateInput: AnniversaryDate | string | undefined): string {
  if (dateInput == null) return '';
  if (typeof dateInput === 'object') {
    const ts = dateInput as Timestamp;
    if (ts['@type'] === 'Timestamp' && typeof ts.utc === 'string') {
      const d = new Date(ts.utc);
      if (!isNaN(d.getTime())) {
        return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
      }
      return String(ts.utc);
    }
    const pd = dateInput as PartialDate;
    const parts: string[] = [];
    if (pd.month && MONTH_NAMES_SHORT[pd.month - 1]) parts.push(MONTH_NAMES_SHORT[pd.month - 1]);
    if (pd.day) parts.push(String(pd.day));
    if (pd.year) parts.push(String(pd.year));
    return parts.join(' ');
  }
  const dateStr = String(dateInput);
  if (dateStr.startsWith('--')) {
    const parts = dateStr.substring(2).split('-');
    const month = parseInt(parts[0], 10);
    const day = parts[1] ? parseInt(parts[1], 10) : undefined;
    if (!month || !MONTH_NAMES_SHORT[month - 1]) return dateStr;
    return day ? `${MONTH_NAMES_SHORT[month - 1]} ${day}` : MONTH_NAMES_SHORT[month - 1];
  }
  const d = new Date(dateStr);
  if (!isNaN(d.getTime())) {
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  }
  return dateStr;
}

export function getBirthday(contact: ContactCard): AnniversaryDate | undefined {
  if (!contact.anniversaries) return undefined;
  for (const ann of Object.values(contact.anniversaries)) {
    if (ann.kind === 'birth') return ann.date;
  }
  return undefined;
}

export function getDateParts(dateInput: AnniversaryDate): { year?: number; month?: number; day?: number } {
  if (typeof dateInput === 'object' && dateInput !== null) {
    if ((dateInput as Timestamp)['@type'] === 'Timestamp') {
      const ts = dateInput as Timestamp;
      const d = new Date(ts.utc);
      if (!isNaN(d.getTime())) {
        return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
      }
      return {};
    }
    const pd = dateInput as PartialDate;
    return { year: pd.year, month: pd.month, day: pd.day };
  }
  const s = String(dateInput);
  if (s.startsWith('--')) {
    const parts = s.substring(2).split('-');
    return { month: parseInt(parts[0], 10), day: parts[1] ? parseInt(parts[1], 10) : undefined };
  }
  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
  }
  return {};
}

export function getCompletedYears(dateInput: AnniversaryDate): number | null {
  const { year, month, day } = getDateParts(dateInput);
  if (!year) return null;
  const now = new Date();
  let years = now.getFullYear() - year;
  const m = month ?? 1;
  const d = day ?? 1;
  const nowM = now.getMonth() + 1;
  const nowD = now.getDate();
  if (nowM < m || (nowM === m && nowD < d)) years -= 1;
  if (years < 0) return null;
  return years;
}

export function getPhoneFeatures(features?: Record<string, boolean>): string[] {
  if (!features) return [];
  return Object.keys(features).filter((k) => features[k]);
}

export function getActiveContexts(contexts?: Record<string, boolean>): string[] {
  if (!contexts) return [];
  return Object.keys(contexts).filter((k) => contexts[k]);
}

export function getPrimaryNickname(contact: ContactCard): string | undefined {
  if (!contact.nicknames) return undefined;
  return Object.values(contact.nicknames)[0]?.name;
}

export function formatAddress(address: {
  components?: Array<{ kind: string; value: string }>;
  full?: string;
  street?: string;
  locality?: string;
  region?: string;
  postcode?: string;
  country?: string;
}): string {
  if (address.full) return address.full;
  if (address.components && address.components.length > 0) {
    const byKind: Record<string, string[]> = {};
    for (const c of address.components) {
      if (!byKind[c.kind]) byKind[c.kind] = [];
      byKind[c.kind].push(c.value);
    }
    const street = [byKind.name, byKind.number].flat().filter(Boolean).join(' ').trim();
    const locality = (byKind.locality || []).join(' ');
    const region = (byKind.region || []).join(' ');
    const postcode = (byKind.postcode || []).join(' ');
    const country = (byKind.country || []).join(' ');
    const cityRegion = [locality, region, postcode].filter(Boolean).join(' ');
    return [street, cityRegion, country].filter(Boolean).join(', ');
  }
  return [
    address.street,
    [address.locality, address.region, address.postcode].filter(Boolean).join(' '),
    address.country,
  ].filter(Boolean).join(', ');
}

export function getContactKeywords(contact: ContactCard): string[] {
  if (!contact.keywords) return [];
  return Object.keys(contact.keywords).filter((k) => contact.keywords![k]);
}

export function isGroup(contact: ContactCard): boolean {
  return contact.kind === 'group';
}

export function matchesContactSearch(contact: ContactCard, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  if (getContactDisplayName(contact).toLowerCase().includes(q)) return true;
  if (contact.emails) {
    for (const e of Object.values(contact.emails)) {
      if (e.address?.toLowerCase().includes(q)) return true;
    }
  }
  if (contact.phones) {
    for (const p of Object.values(contact.phones)) {
      if (p.number?.toLowerCase().includes(q)) return true;
    }
  }
  if (contact.organizations) {
    for (const o of Object.values(contact.organizations)) {
      if (o.name?.toLowerCase().includes(q)) return true;
    }
  }
  if (contact.keywords) {
    for (const k of Object.keys(contact.keywords)) {
      if (k.toLowerCase().includes(q)) return true;
    }
  }
  return false;
}
