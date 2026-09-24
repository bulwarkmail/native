import { describe, it, expect } from 'vitest';
import {
  deriveFullName,
  getContactDisplayName,
  getContactSortName,
  getCustomFullName,
  getContactPhotoUri,
  normalizeContactPhotoUri,
  partialDateToString,
  stringToPartialDate,
} from '../contact-utils';
import type { ContactCard } from '../../api/types';

describe('getContactDisplayName', () => {
  it('joins given + surname only, like the webmail', () => {
    const c: ContactCard = {
      id: 'c',
      addressBookIds: {},
      name: { components: [{ kind: 'given', value: 'Jane' }, { kind: 'middle', value: 'Q' }, { kind: 'surname', value: 'Doe' }] },
    };
    expect(getContactDisplayName(c)).toBe('Jane Doe');
  });
});

describe('normalizeContactPhotoUri (#307)', () => {
  it('adds a media type to data URIs that lack one', () => {
    expect(normalizeContactPhotoUri('data:base64,AAAA')).toBe('data:image/jpeg;base64,AAAA');
    expect(normalizeContactPhotoUri('data:;base64,AAAA', 'image/png')).toBe('data:image/png;base64,AAAA');
  });

  it('leaves well-formed URIs alone', () => {
    expect(normalizeContactPhotoUri('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
    expect(normalizeContactPhotoUri('https://x/y.jpg')).toBe('https://x/y.jpg');
  });

  it('is applied by getContactPhotoUri', () => {
    const c: ContactCard = { id: 'c', addressBookIds: {}, media: { m: { kind: 'photo', uri: 'data:base64,AAAA' } } };
    expect(getContactPhotoUri(c)).toBe('data:image/jpeg;base64,AAAA');
  });
});

describe('partialDateToString', () => {
  it.each([
    [{ year: 1990, month: 5, day: 4 }, '1990-05-04'],
    [{ year: 1990, month: 5 }, '1990-05'],
    [{ year: 1990 }, '1990'],
    [{ month: 5, day: 4 }, '--05-04'],
    [{ month: 5 }, '--05'],
    [{ day: 4 }, '---04'],
  ])('is lossless for %j', (pd, expected) => {
    expect(partialDateToString(pd)).toBe(expected);
  });

  it('handles timestamps and strings', () => {
    expect(partialDateToString({ '@type': 'Timestamp', utc: '2020-01-02T03:04:05Z' })).toBe('2020-01-02');
    expect(partialDateToString('1999-12-31')).toBe('1999-12-31');
    expect(partialDateToString(undefined)).toBe('');
  });
});

describe('stringToPartialDate', () => {
  it.each([
    ['1990-05-04', { year: 1990, month: 5, day: 4 }],
    ['19900504', { year: 1990, month: 5, day: 4 }],
    ['1990-05-04T00:00:00Z', { year: 1990, month: 5, day: 4 }],
    ['1990-05', { year: 1990, month: 5 }],
    ['1990', { year: 1990 }],
    ['--05-04', { month: 5, day: 4 }],
    ['--0504', { month: 5, day: 4 }],
    ['--05', { month: 5 }],
    ['---04', { day: 4 }],
  ])('parses %s', (input, expected) => {
    expect(stringToPartialDate(input)).toEqual(expected);
  });

  it.each(['May 5', '1990-13-01', 'circa 1800', '', '   '])('rejects %s', (input) => {
    expect(stringToPartialDate(input)).toBeNull();
  });

  it('round-trips through partialDateToString', () => {
    for (const s of ['1990-05-04', '1990-05', '1990', '--05-04', '--05', '---04']) {
      expect(partialDateToString(stringToPartialDate(s)!)).toBe(s);
    }
  });
});

describe('name.full for the vCard FN (#430)', () => {
  const person = (full: string | undefined, components: Array<{ kind: string; value: string }>): ContactCard => ({
    id: 'c',
    addressBookIds: {},
    name: { components, isOrdered: true, ...(full !== undefined ? { full } : {}) },
  });

  it('joins the name components in display order, like the webmail form', () => {
    expect(deriveFullName([
      { kind: 'surname', value: 'Doe' },
      { kind: 'generation', value: 'Jr.' },
      { kind: 'given', value: ' John ' },
      { kind: 'title', value: 'Dr.' },
      { kind: 'given2', value: 'Q' },
    ])).toBe('Dr. John Q Doe Jr.');
    // Legacy vCard-style kinds count too.
    expect(deriveFullName([{ kind: 'prefix', value: 'Ms.' }, { kind: 'given', value: 'Ann' }])).toBe('Ms. Ann');
    expect(deriveFullName(undefined)).toBe('');
    expect(deriveFullName([])).toBe('');
  });

  it('treats a full that repeats the components as derived, so an edit cannot leave it stale', () => {
    const card = person('John Doe', [{ kind: 'given', value: 'John' }, { kind: 'surname', value: 'Doe' }]);
    expect(getCustomFullName(card)).toBe('');
  });

  it('keeps a display name of its own', () => {
    const card = person('Johnny D', [{ kind: 'given', value: 'John' }, { kind: 'surname', value: 'Doe' }]);
    expect(getCustomFullName(card)).toBe('Johnny D');
    expect(getCustomFullName(person('Solo', []))).toBe('Solo');
    expect(getCustomFullName(person(undefined, [{ kind: 'given', value: 'A' }]))).toBe('');
  });

  it('treats an organization card whose full is the organization name as derived', () => {
    const org = person('Acme Corp', []);
    expect(getCustomFullName(org, 'Acme Corp')).toBe('');
    expect(getCustomFullName(org, 'Acme Inc')).toBe('Acme Corp');
  });
});

describe('getContactSortName (#963)', () => {
  const make = (overrides: Partial<ContactCard>): ContactCard => ({ id: 'c1', addressBookIds: {}, ...overrides });
  const structured = make({
    name: {
      components: [
        { kind: 'given', value: 'Alice' },
        { kind: 'middle', value: 'Jane' },
        { kind: 'surname', value: 'Smith' },
      ],
      isOrdered: true,
    },
  });

  it('returns the display name when not sorting by last name', () => {
    expect(getContactSortName(structured, false)).toBe('Alice Smith');
  });

  it('leads with the surname when sorting by last name', () => {
    expect(getContactSortName(structured, true)).toBe('Smith, Alice Jane');
  });

  it('returns just the surname when no given name exists', () => {
    const c = make({ name: { components: [{ kind: 'surname', value: 'Smith' }], isOrdered: true } });
    expect(getContactSortName(c, true)).toBe('Smith');
  });

  it('uses the last word of name.full when there are no components', () => {
    expect(getContactSortName(make({ name: { full: 'Jean Pierre Dupont' } }), true)).toBe('Dupont, Jean Pierre');
  });

  it('keeps a single-word name.full as-is', () => {
    expect(getContactSortName(make({ name: { full: 'Madonna' } }), true)).toBe('Madonna');
  });

  it('does not split organization or email fallbacks into a surname', () => {
    expect(getContactSortName(make({ organizations: { o1: { name: 'Acme Corp' } } }), true)).toBe('Acme Corp');
    expect(getContactSortName(make({ emails: { e0: { address: 'someone@example.com' } } }), true)).toBe('someone@example.com');
  });

  it('falls back to the display name for a given-only name (e.g. a group)', () => {
    const c = make({ kind: 'group', name: { components: [{ kind: 'given', value: 'Team' }], isOrdered: true } });
    expect(getContactSortName(c, true)).toBe('Team');
  });
});
