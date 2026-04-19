import type {
  ContactCard,
  AnniversaryDate,
  PartialDate,
  Timestamp,
} from '../api/types';

export function getContactDisplayName(contact: ContactCard): string {
  if (contact.name) {
    if (contact.name.components && contact.name.components.length > 0) {
      const given = contact.name.components.find((c) => c.kind === 'given')?.value || '';
      const surname = contact.name.components.find((c) => c.kind === 'surname')?.value || '';
      const middle = contact.name.components.find((c) => c.kind === 'middle')?.value || '';
      const full = [given, middle, surname].filter(Boolean).join(' ');
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

export function getContactPhotoUri(contact: ContactCard): string | undefined {
  if (!contact.media) return undefined;
  for (const media of Object.values(contact.media)) {
    if (media.kind === 'photo' && media.uri) return media.uri;
  }
  return undefined;
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
