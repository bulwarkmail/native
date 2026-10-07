import type { AnniversaryDate, ContactCard } from '../api/types';
import { getContactPhotoUri } from './contact-utils';

// Advanced contact-list filters, ported from the webmail's contact-list.tsx.
// The text search stays matchesContactSearch; a contact is shown when it
// passes both.

export type TriState = boolean | null;

export interface ContactListFilters {
  organization: string;
  jobTitle: string;
  location: string;
  emailDomain: string;
  /** 1-12, or null for any month. */
  birthdayMonth: number | null;
  hasEmail: TriState;
  hasPhone: TriState;
  hasPhoto: TriState;
}

export const EMPTY_CONTACT_FILTERS: ContactListFilters = {
  organization: '',
  jobTitle: '',
  location: '',
  emailDomain: '',
  birthdayMonth: null,
  hasEmail: null,
  hasPhone: null,
  hasPhoto: null,
};

/** null (don't care) -> true (must have) -> false (must not have) -> null. */
export function cycleTri(v: TriState): TriState {
  if (v === null) return true;
  return v ? false : null;
}

export function countActiveFilters(f: ContactListFilters): number {
  let n = 0;
  if (f.organization.trim()) n++;
  if (f.jobTitle.trim()) n++;
  if (f.location.trim()) n++;
  if (f.emailDomain.trim()) n++;
  if (f.birthdayMonth !== null) n++;
  if (f.hasEmail !== null) n++;
  if (f.hasPhone !== null) n++;
  if (f.hasPhoto !== null) n++;
  return n;
}

// Cards come from a server (and vCard imports), so a field may not be text.
function has(value: unknown, needle: string): boolean {
  return typeof value === 'string' && value.toLowerCase().includes(needle);
}

function matchTri(actual: boolean, filter: TriState): boolean {
  return filter === null || actual === filter;
}

// Read the month straight from the text so a bare date is not shifted by the
// device time zone; only a Timestamp goes through Date.
function anniversaryMonth(date: AnniversaryDate): number | null {
  if (typeof date === 'string') {
    const iso = date.match(/^(\d{4})-(\d{2})/);
    if (iso) return parseInt(iso[2], 10);
    const partial = date.match(/^--(\d{2})/);
    return partial ? parseInt(partial[1], 10) : null;
  }
  if (typeof date !== 'object' || date === null) return null;
  if ('month' in date && date.month) return date.month;
  if ('utc' in date && date.utc) {
    const d = new Date(date.utc);
    return isNaN(d.getTime()) ? null : d.getMonth() + 1;
  }
  return null;
}

export function matchesContactFilters(card: ContactCard, f: ContactListFilters): boolean {
  const emails = card.emails ? Object.values(card.emails) : [];
  const phones = card.phones ? Object.values(card.phones) : [];

  if (!matchTri(emails.length > 0, f.hasEmail)) return false;
  if (!matchTri(phones.length > 0, f.hasPhone)) return false;
  if (!matchTri(!!getContactPhotoUri(card), f.hasPhoto)) return false;

  const org = f.organization.trim().toLowerCase();
  if (org) {
    const orgs = card.organizations ? Object.values(card.organizations) : [];
    const hit = orgs.some((o) =>
      has(o.name, org) || (Array.isArray(o.units) && o.units.some((u) => has(u?.name, org))),
    );
    if (!hit) return false;
  }

  const job = f.jobTitle.trim().toLowerCase();
  if (job) {
    const titles = card.titles ? Object.values(card.titles) : [];
    if (!titles.some((ti) => has(ti?.name, job))) return false;
  }

  const loc = f.location.trim().toLowerCase();
  if (loc) {
    const addresses = card.addresses ? Object.values(card.addresses) : [];
    const hit = addresses.some((a) => {
      const parts = [a.full, a.fullAddress, a.locality, a.region, a.country, a.postcode, a.street];
      if (Array.isArray(a.components)) for (const comp of a.components) parts.push(comp?.value);
      return parts.some((p) => has(p, loc));
    });
    if (!hit) return false;
  }

  const domain = f.emailDomain.trim().toLowerCase().replace(/^@/, '');
  if (domain) {
    const hit = emails.some((e) => {
      if (typeof e?.address !== 'string') return false;
      const at = e.address.toLowerCase().split('@');
      return at.length > 1 && at[1].includes(domain);
    });
    if (!hit) return false;
  }

  if (f.birthdayMonth !== null) {
    const target = f.birthdayMonth;
    const anniversaries = card.anniversaries ? Object.values(card.anniversaries) : [];
    if (!anniversaries.some((a) => a?.kind === 'birth' && anniversaryMonth(a.date) === target)) return false;
  }

  return true;
}
