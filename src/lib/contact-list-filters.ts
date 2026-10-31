import type { AnniversaryDate, ContactCard } from '../api/types';
import { hasContactPhoto } from './contact-utils';

// The contact list's advanced filters (webmail components/contacts/contact-list.tsx).

export type TriState = boolean | null;

export interface ContactListFilters {
  organization: string;
  jobTitle: string;
  location: string;
  emailDomain: string;
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

/** Off, then "must have", then "must not have". */
export function cycleTri(v: TriState): TriState {
  return v === null ? true : v === true ? false : null;
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

function matchTri(actual: boolean, filter: TriState): boolean {
  return filter === null || actual === filter;
}

function anniversaryMonth(date: AnniversaryDate): number | null {
  if (typeof date === 'string') {
    const iso = date.match(/^(\d{4})-(\d{2})/);
    if (iso) return parseInt(iso[2], 10);
    const partial = date.match(/^--(\d{2})/);
    if (partial) return parseInt(partial[1], 10);
    return null;
  }
  if ('month' in date && date.month) return date.month;
  if ('utc' in date && date.utc) {
    const d = new Date(date.utc);
    return isNaN(d.getTime()) ? null : d.getMonth() + 1;
  }
  return null;
}

/** Whether `contact` passes every filter that is set. */
export function matchesContactFilters(contact: ContactCard, filters: ContactListFilters): boolean {
  const emails = contact.emails ? Object.values(contact.emails) : [];
  const phones = contact.phones ? Object.values(contact.phones) : [];
  if (!matchTri(emails.length > 0, filters.hasEmail)) return false;
  if (!matchTri(phones.length > 0, filters.hasPhone)) return false;
  if (!matchTri(hasContactPhoto(contact), filters.hasPhoto)) return false;

  const org = filters.organization.trim().toLowerCase();
  if (org) {
    const orgs = contact.organizations ? Object.values(contact.organizations) : [];
    if (!orgs.some((o) => o.name?.toLowerCase().includes(org) || o.units?.some((u) => u.name?.toLowerCase().includes(org)))) {
      return false;
    }
  }

  const job = filters.jobTitle.trim().toLowerCase();
  if (job) {
    const titles = contact.titles ? Object.values(contact.titles) : [];
    if (!titles.some((ti) => ti.name?.toLowerCase().includes(job))) return false;
  }

  const loc = filters.location.trim().toLowerCase();
  if (loc) {
    const addresses = contact.addresses ? Object.values(contact.addresses) : [];
    const match = addresses.some((a) => {
      const parts = [a.full, a.fullAddress, a.locality, a.region, a.country, a.postcode, a.street,
        ...(a.components ?? []).map((comp) => comp.value)];
      return parts.some((p) => !!p && p.toLowerCase().includes(loc));
    });
    if (!match) return false;
  }

  const domain = filters.emailDomain.trim().toLowerCase().replace(/^@/, '');
  if (domain) {
    const match = emails.some((e) => {
      const at = e.address?.toLowerCase().split('@');
      return !!at && at.length > 1 && at[1].includes(domain);
    });
    if (!match) return false;
  }

  if (filters.birthdayMonth !== null) {
    const anniversaries = contact.anniversaries ? Object.values(contact.anniversaries) : [];
    if (!anniversaries.some((a) => a.kind === 'birth' && anniversaryMonth(a.date) === filters.birthdayMonth)) return false;
  }
  return true;
}
