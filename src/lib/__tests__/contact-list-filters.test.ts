import { describe, expect, it } from 'vitest';
import type { ContactCard } from '../../api/types';
import { countActiveFilters, cycleTri, EMPTY_CONTACT_FILTERS, matchesContactFilters } from '../contact-list-filters';

const ana = {
  id: 'a', name: { full: 'Ana' },
  emails: { e: { address: 'ana@acme.example' } },
  organizations: { o: { name: 'Acme Corp', units: [{ name: 'Design' }] } },
  titles: { t: { name: 'Designer' } },
  addresses: { h: { components: [{ kind: 'locality', value: 'Berlin' }] } },
  anniversaries: { b: { kind: 'birth', date: '1990-03-14' } },
} as unknown as ContactCard;
const ben = { id: 'b', name: { full: 'Ben' }, phones: { p: { number: '+49 1' } } } as unknown as ContactCard;

const only = (f: Partial<typeof EMPTY_CONTACT_FILTERS>) => [ana, ben]
  .filter((c) => matchesContactFilters(c, { ...EMPTY_CONTACT_FILTERS, ...f }))
  .map((c) => c.id);

describe('contact list filters', () => {
  it('keeps every contact without filters', () => {
    expect(only({})).toEqual(['a', 'b']);
  });

  it('filters by company or unit, job title, location, email domain and birthday month', () => {
    expect(only({ organization: 'design' })).toEqual(['a']);
    expect(only({ jobTitle: 'design' })).toEqual(['a']);
    expect(only({ location: 'berl' })).toEqual(['a']);
    expect(only({ emailDomain: '@acme' })).toEqual(['a']);
    expect(only({ birthdayMonth: 3 })).toEqual(['a']);
    expect(only({ birthdayMonth: 4 })).toEqual([]);
  });

  it('filters by having, or not having, an email or a phone', () => {
    expect(only({ hasEmail: true })).toEqual(['a']);
    expect(only({ hasEmail: false })).toEqual(['b']);
    expect(only({ hasPhone: true })).toEqual(['b']);
  });

  it('counts the filters that are set and cycles a toggle off, on, inverted', () => {
    expect(countActiveFilters({ ...EMPTY_CONTACT_FILTERS, location: 'x', hasPhoto: false })).toBe(2);
    expect([cycleTri(null), cycleTri(true), cycleTri(false)]).toEqual([true, false, null]);
  });
});
