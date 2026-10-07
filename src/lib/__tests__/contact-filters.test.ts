import { describe, it, expect } from 'vitest';
import type { ContactCard } from '../../api/types';
import {
  EMPTY_CONTACT_FILTERS,
  cycleTri,
  countActiveFilters,
  matchesContactFilters,
  type ContactListFilters,
} from '../contact-filters';

const card = (over: Record<string, unknown>): ContactCard => ({ id: 'c1', ...over } as unknown as ContactCard);
const f = (over: Partial<ContactListFilters>): ContactListFilters => ({ ...EMPTY_CONTACT_FILTERS, ...over });

describe('matchesContactFilters', () => {
  it('passes everything with empty filters', () => {
    expect(matchesContactFilters(card({}), EMPTY_CONTACT_FILTERS)).toBe(true);
  });

  it('matches organisation names and units, case-insensitively', () => {
    const c = card({ organizations: { o: { name: 'Acme Corp', units: [{ name: 'Research' }] } } });
    expect(matchesContactFilters(c, f({ organization: 'acme' }))).toBe(true);
    expect(matchesContactFilters(c, f({ organization: ' RESEARCH ' }))).toBe(true);
    expect(matchesContactFilters(c, f({ organization: 'nope' }))).toBe(false);
    expect(matchesContactFilters(card({}), f({ organization: 'acme' }))).toBe(false);
  });

  it('matches job titles', () => {
    const c = card({ titles: { t: { name: 'Senior Designer' } } });
    expect(matchesContactFilters(c, f({ jobTitle: 'design' }))).toBe(true);
    expect(matchesContactFilters(c, f({ jobTitle: 'engineer' }))).toBe(false);
  });

  it('matches every address part', () => {
    const parts = {
      full: 'Full Part', fullAddress: 'FullAddr Part', locality: 'Town', region: 'Region',
      country: 'Country', postcode: 'PC123', street: 'Main Street',
    };
    for (const [k, v] of Object.entries(parts)) {
      const c = card({ addresses: { a: { [k]: v } } });
      expect(matchesContactFilters(c, f({ location: v.toLowerCase() }))).toBe(true);
    }
    const comp = card({ addresses: { a: { components: [{ kind: 'locality', value: 'Springfield' }] } } });
    expect(matchesContactFilters(comp, f({ location: 'spring' }))).toBe(true);
    expect(matchesContactFilters(comp, f({ location: 'shelby' }))).toBe(false);
  });

  it('matches the email domain with and without @', () => {
    const c = card({ emails: { e: { address: 'Ann@Example.com' } } });
    expect(matchesContactFilters(c, f({ emailDomain: 'example.com' }))).toBe(true);
    expect(matchesContactFilters(c, f({ emailDomain: '@example.com' }))).toBe(true);
    expect(matchesContactFilters(c, f({ emailDomain: 'other.org' }))).toBe(false);
    // The local part is not the domain.
    expect(matchesContactFilters(c, f({ emailDomain: 'ann' }))).toBe(false);
  });

  it('matches the birthday month from ISO, --MM-DD and PartialDate', () => {
    const mk = (date: unknown) => card({ anniversaries: { b: { kind: 'birth', date } } });
    expect(matchesContactFilters(mk('1990-05-01'), f({ birthdayMonth: 5 }))).toBe(true);
    expect(matchesContactFilters(mk('1990-05-31'), f({ birthdayMonth: 6 }))).toBe(false);
    expect(matchesContactFilters(mk('--07-04'), f({ birthdayMonth: 7 }))).toBe(true);
    expect(matchesContactFilters(mk({ '@type': 'PartialDate', month: 12, day: 3 }), f({ birthdayMonth: 12 }))).toBe(true);
    expect(matchesContactFilters(mk({ '@type': 'PartialDate', month: 12 }), f({ birthdayMonth: 1 }))).toBe(false);
    expect(matchesContactFilters(mk({ '@type': 'Timestamp', utc: '2000-03-15T12:00:00Z' }), f({ birthdayMonth: 3 }))).toBe(true);
  });

  it('only counts birth anniversaries', () => {
    const c = card({ anniversaries: { b: { kind: 'wedding', date: '2000-05-01' } } });
    expect(matchesContactFilters(c, f({ birthdayMonth: 5 }))).toBe(false);
  });

  it('applies the tri-state filters in both polarities', () => {
    const rich = card({
      emails: { e: { address: 'a@b.c' } },
      phones: { p: { number: '1' } },
      media: { m: { kind: 'photo', uri: 'https://x/y.png' } },
    });
    const bare = card({});
    for (const key of ['hasEmail', 'hasPhone', 'hasPhoto'] as const) {
      expect(matchesContactFilters(rich, f({ [key]: true }))).toBe(true);
      expect(matchesContactFilters(bare, f({ [key]: true }))).toBe(false);
      expect(matchesContactFilters(rich, f({ [key]: false }))).toBe(false);
      expect(matchesContactFilters(bare, f({ [key]: false }))).toBe(true);
    }
  });

  it('ands the filters together', () => {
    const c = card({ organizations: { o: { name: 'Acme' } }, titles: { t: { name: 'CEO' } } });
    expect(matchesContactFilters(c, f({ organization: 'acme', jobTitle: 'ceo' }))).toBe(true);
    expect(matchesContactFilters(c, f({ organization: 'acme', jobTitle: 'cto' }))).toBe(false);
  });
});

describe('malformed cards', () => {
  it('never throws on non-string fields', () => {
    const bad = card({
      name: { full: 42 },
      organizations: { o: { name: 7, units: [{ name: {} }] } },
      titles: { t: { name: null } },
      addresses: { a: { full: 1, locality: [], components: [{ value: 3 }] } },
      emails: { e: { address: 5 } },
      anniversaries: { b: { kind: 'birth', date: '--ab' }, c: { kind: 'birth', date: 12 } },
    });
    const all = f({
      organization: 'a', jobTitle: 'a', location: 'a', emailDomain: 'a', birthdayMonth: 1,
    });
    expect(matchesContactFilters(bad, all)).toBe(false);
    for (const key of ['organization', 'jobTitle', 'location', 'emailDomain'] as const) {
      expect(matchesContactFilters(bad, f({ [key]: 'a' }))).toBe(false);
    }
    expect(matchesContactFilters(bad, f({ birthdayMonth: 1 }))).toBe(false);
  });
});

describe('cycleTri', () => {
  it('goes null, true, false, null', () => {
    expect(cycleTri(null)).toBe(true);
    expect(cycleTri(true)).toBe(false);
    expect(cycleTri(false)).toBe(null);
  });
});

describe('countActiveFilters', () => {
  it('is zero when empty', () => {
    expect(countActiveFilters(EMPTY_CONTACT_FILTERS)).toBe(0);
  });
  it('counts each active filter, ignoring blank text', () => {
    expect(countActiveFilters(f({ organization: 'x', jobTitle: '   ', hasEmail: false, hasPhoto: true }))).toBe(3);
  });
  it('counts all eight', () => {
    expect(countActiveFilters({
      organization: 'a', jobTitle: 'b', location: 'c', emailDomain: 'd',
      birthdayMonth: 1, hasEmail: true, hasPhone: false, hasPhoto: true,
    })).toBe(8);
  });
});
