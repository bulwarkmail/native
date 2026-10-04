import { describe, it, expect } from 'vitest';
import { contactFromWire, contactLinkPatch, contactToWire, mergeContactLinks } from '../contact-wire';
import type { ContactCard } from '../../api/types';

describe('contactToWire', () => {
  it('drops client-only fields, which ContactCard/set rejects', () => {
    const wire = contactToWire({
      name: { full: 'A' },
      originalId: 'x', accountId: 'a', accountName: 'n', isShared: true, localAccountId: 'l',
    }, 'create');
    expect(wire).toEqual({ name: { full: 'A' } });
  });

  it('writes the calendar URIs as RFC 9553 calendars and schedulingAddresses', () => {
    const wire = contactToWire({
      calendarUri: 'https://x.test/cal',
      freeBusyUri: 'https://x.test/fb',
      schedulingUri: 'mailto:a@x.test',
    }, 'create');
    expect(wire).toEqual({
      calendars: {
        cal: { '@type': 'Calendar', kind: 'calendar', uri: 'https://x.test/cal' },
        fb: { '@type': 'Calendar', kind: 'freeBusy', uri: 'https://x.test/fb' },
      },
      schedulingAddresses: { sched: { '@type': 'SchedulingAddress', uri: 'mailto:a@x.test' } },
    });
  });

  it('sends null for cleared fields on update, but omits them on create', () => {
    const cleared: Partial<ContactCard> = { nicknames: undefined, calendarUri: undefined, schedulingUri: undefined };
    expect(contactToWire(cleared, 'update')).toEqual({ nicknames: null, calendars: null, schedulingAddresses: null });
    expect(contactToWire(cleared, 'create')).toEqual({});
  });

  it('leaves calendar links alone when the update does not mention them', () => {
    expect(contactToWire({ keywords: { vip: true } }, 'update')).toEqual({ keywords: { vip: true } });
  });

  it('converts flat vCard addresses to components and SOURCE to a directory entry', () => {
    const wire = contactToWire({
      addresses: { a0: { street: 'Main St 1', locality: 'Town', country: 'DE', fullAddress: 'Main St 1, Town', contexts: { work: true } } },
      source: 'https://x.test/card.vcf',
    }, 'create');
    expect(wire.addresses).toEqual({
      a0: {
        components: [
          { kind: 'name', value: 'Main St 1' },
          { kind: 'locality', value: 'Town' },
          { kind: 'country', value: 'DE' },
        ],
        isOrdered: true,
        defaultSeparator: ', ',
        full: 'Main St 1, Town',
        contexts: { work: true },
      },
    });
    expect(wire.directories).toEqual({ source: { '@type': 'Directory', kind: 'entry', uri: 'https://x.test/card.vcf' } });
  });
});

describe('contactFromWire', () => {
  it('fills the flat URI fields from the server card', () => {
    const card = contactFromWire({
      id: 'c1',
      addressBookIds: {},
      calendars: { k: { kind: 'calendar', uri: 'https://x.test/cal' }, f: { kind: 'freeBusy', uri: 'https://x.test/fb' } },
      schedulingAddresses: { s: { uri: 'mailto:a@x.test' } },
      directories: { d: { kind: 'entry', uri: 'https://x.test/card.vcf' } },
    });
    expect(card).toMatchObject({
      calendarUri: 'https://x.test/cal',
      freeBusyUri: 'https://x.test/fb',
      schedulingUri: 'mailto:a@x.test',
      source: 'https://x.test/card.vcf',
    });
  });

  it('returns a card without links unchanged', () => {
    const card: ContactCard = { id: 'c1', addressBookIds: {} };
    expect(contactFromWire(card)).toBe(card);
  });
});

const serverCard: ContactCard = {
  id: 'c1',
  addressBookIds: {},
  calendars: {
    k1: { kind: 'calendar', uri: 'https://x.test/A', mediaType: 'text/calendar', pref: 1 },
    k2: { kind: 'calendar', uri: 'https://x.test/B' },
    f: { kind: 'freeBusy', uri: 'https://x.test/C' },
  },
  schedulingAddresses: { s1: { uri: 'mailto:a@x.test' }, s2: { uri: 'mailto:b@x.test' } },
  directories: { d1: { kind: 'entry', uri: 'https://x.test/1.vcf' }, d2: { kind: 'entry', uri: 'https://x.test/2.vcf' } },
};

describe('links kept intact', () => {
  it('keeps the wire maps when the flat fields match them (move, duplicate)', () => {
    const wire = contactToWire(contactFromWire(serverCard), 'create');
    expect(wire.calendars).toBe(serverCard.calendars);
    expect(wire.schedulingAddresses).toBe(serverCard.schedulingAddresses);
    expect(wire.directories).toBe(serverCard.directories);
    expect(wire).not.toHaveProperty('calendarUri');
    expect(wire).not.toHaveProperty('source');
  });

  it('rebuilds the maps when a flat field differs and there is no map', () => {
    const wire = contactToWire({ calendarUri: 'https://x.test/new' }, 'update');
    expect(wire.calendars).toEqual({ cal: { '@type': 'Calendar', kind: 'calendar', uri: 'https://x.test/new' } });
  });
});

describe('mergeContactLinks', () => {
  it('replaces only the first calendar entry uri', () => {
    const merged = mergeContactLinks(serverCard, { calendarUri: 'https://x.test/new' });
    expect(merged.calendars).toEqual({
      ...serverCard.calendars,
      k1: { kind: 'calendar', uri: 'https://x.test/new', mediaType: 'text/calendar', pref: 1 },
    });
    expect(merged).not.toHaveProperty('schedulingAddresses');
  });

  it('removes the entry when the value is emptied', () => {
    const merged = mergeContactLinks(serverCard, { freeBusyUri: '' });
    expect(Object.keys(merged.calendars ?? {})).toEqual(['k1', 'k2']);
  });

  it('adds a missing entry under the webmail key', () => {
    expect(mergeContactLinks({ id: 'c', addressBookIds: {} }, { calendarUri: 'u' }).calendars)
      .toEqual({ cal: { '@type': 'Calendar', kind: 'calendar', uri: 'u' } });
  });

  it('replaces the first scheduling address and keeps the rest', () => {
    expect(mergeContactLinks(serverCard, { schedulingUri: 'mailto:z@x.test' }).schedulingAddresses)
      .toEqual({ s1: { uri: 'mailto:z@x.test' }, s2: { uri: 'mailto:b@x.test' } });
  });

  it('returns null for a map that ends up empty', () => {
    const only = { id: 'c', addressBookIds: {}, calendars: { k: { kind: 'calendar', uri: 'u' } } };
    expect(mergeContactLinks(only, { calendarUri: '' }).calendars).toBeNull();
  });
});

describe('contactLinkPatch', () => {
  const form = { calendarUri: 'https://x.test/A', freeBusyUri: 'https://x.test/C', schedulingUri: 'mailto:a@x.test' };
  const existing = contactFromWire(serverCard);

  it('sends no link keys for an edit that did not touch them', () => {
    expect(contactLinkPatch(existing, form)).toEqual({});
  });

  it('merges only the changed field on edit', () => {
    const patch = contactLinkPatch(existing, { ...form, calendarUri: 'https://x.test/new' });
    expect(Object.keys(patch).sort()).toEqual(['calendarUri', 'calendars']);
  });

  it('sends non-empty flat fields for a new card', () => {
    expect(contactLinkPatch(undefined, { calendarUri: 'u', freeBusyUri: '', schedulingUri: '' })).toEqual({ calendarUri: 'u' });
  });
});

describe('edited links stay consistent in the local card', () => {
  const form = { calendarUri: 'https://x.test/A', freeBusyUri: 'https://x.test/C', schedulingUri: 'mailto:a@x.test' };
  const loaded = contactFromWire(serverCard);

  it('returns the merged map and the new flat value for a changed field', () => {
    const patch = contactLinkPatch(loaded, { ...form, calendarUri: ' https://x.test/new ' });
    expect(patch.calendarUri).toBe('https://x.test/new');
    expect((patch.calendars as Record<string, unknown>).k1).toMatchObject({ uri: 'https://x.test/new' });
  });

  it('returns null and a map without the entry for a cleared field', () => {
    const patch = contactLinkPatch(loaded, { ...form, freeBusyUri: '' });
    expect(patch.freeBusyUri).toBeNull();
    expect(Object.keys(patch.calendars as object)).toEqual(['k1', 'k2']);
  });

  it('survives the store merge and a move or duplicate', () => {
    const edited = { ...loaded, ...contactLinkPatch(loaded, { ...form, calendarUri: 'https://x.test/new', freeBusyUri: '' }) } as ContactCard;
    const wire = contactToWire(edited, 'create') as { calendars: Record<string, any> };
    expect(wire.calendars.k1).toEqual({ kind: 'calendar', uri: 'https://x.test/new', mediaType: 'text/calendar', pref: 1 });
    expect(wire.calendars.k2.uri).toBe('https://x.test/B');
    expect(wire.calendars.f).toBeUndefined();
    expect(wire).not.toHaveProperty('calendarUri');
  });

  it('does not send a null map on create when every calendar was cleared', () => {
    const only = contactFromWire({ id: 'c', addressBookIds: {}, calendars: { k: { kind: 'calendar', uri: 'u' } } });
    const edited = { ...only, ...contactLinkPatch(only, { calendarUri: '', freeBusyUri: '', schedulingUri: '' }) } as ContactCard;
    expect(contactToWire(edited, 'create')).not.toHaveProperty('calendars');
  });

  it('sends no link keys for a name-only edit when the stored URI has whitespace', () => {
    const padded = { id: 'c', addressBookIds: {}, calendarUri: ' https://x.test/A ' } as ContactCard;
    expect(contactLinkPatch(padded, { calendarUri: 'https://x.test/A', freeBusyUri: '', schedulingUri: '' })).toEqual({});
  });
});
