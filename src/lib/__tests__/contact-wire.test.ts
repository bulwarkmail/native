import { describe, it, expect } from 'vitest';
import { contactFromWire, contactToWire, linksToPatch } from '../contact-wire';
import { contactToForm, formToPatch } from '../contact-form';
import { parseVCard } from '../vcard';
import type { ContactCard } from '../../api/types';

// A card with more calendar and scheduling entries than the form shows, each
// with properties the form has no field for (#110).
const CALENDARS = {
  'work-cal': { '@type': 'Calendar', kind: 'calendar', uri: 'https://cal.example/work', label: 'Work', pref: 1, mediaType: 'text/calendar', contexts: { work: true } },
  'home-cal': { '@type': 'Calendar', kind: 'calendar', uri: 'https://cal.example/home', label: 'Home', pref: 2 },
  'work-busy': { '@type': 'Calendar', kind: 'freeBusy', uri: 'https://cal.example/work-busy', label: 'Office hours' },
  'home-busy': { '@type': 'Calendar', kind: 'freeBusy', uri: 'https://cal.example/home-busy' },
} as const;
const SCHEDULING = {
  'itip-work': { '@type': 'SchedulingAddress', uri: 'mailto:work@example.com', label: 'Work', pref: 1, contexts: { work: true } },
  'itip-home': { '@type': 'SchedulingAddress', uri: 'mailto:home@example.com', pref: 2 },
} as const;
const linked = (): ContactCard => contactFromWire({
  id: 'c',
  addressBookIds: { b: true },
  name: { components: [{ kind: 'given', value: 'Casey' }], isOrdered: true, full: 'Casey' },
  calendars: { ...CALENDARS },
  schedulingAddresses: { ...SCHEDULING },
});

/** What ContactCard/set receives when the form is saved after `edit`. */
function saveForm(card: ContactCard, edit: Partial<Record<'calendarUri' | 'freeBusyUri' | 'schedulingUri', string>> = {}) {
  const patch = formToPatch({ ...contactToForm(card, []), ...edit }, card, false, []);
  return { patch, wire: contactToWire(patch, 'update') };
}

describe('contactToWire', () => {
  // Stalwart refuses a card with calendarUri / schedulingUri / freeBusyUri
  // as properties ("Invalid property.").
  it('writes the calendar, scheduling and free/busy links as RFC 9553 entries', () => {
    const wire = contactToWire({
      name: { full: 'A' },
      calendarUri: 'https://cal.example/a',
      freeBusyUri: 'https://cal.example/a/fb',
      schedulingUri: 'mailto:a@example.com',
    }, 'create');
    expect(wire).not.toHaveProperty('calendarUri');
    expect(wire).not.toHaveProperty('freeBusyUri');
    expect(wire).not.toHaveProperty('schedulingUri');
    expect(wire.calendars).toEqual({
      cal: { '@type': 'Calendar', kind: 'calendar', uri: 'https://cal.example/a' },
      fb: { '@type': 'Calendar', kind: 'freeBusy', uri: 'https://cal.example/a/fb' },
    });
    expect(wire.schedulingAddresses).toEqual({ sched: { '@type': 'SchedulingAddress', uri: 'mailto:a@example.com' } });
  });

  it('clears the links on an update that empties them', () => {
    const wire = contactToWire({ calendarUri: null as never, schedulingUri: null as never }, 'update');
    expect(wire.calendars).toBeNull();
    expect(wire.schedulingAddresses).toBeNull();
  });

  it('leaves the links alone on an update that does not name them', () => {
    const wire = contactToWire({ name: { full: 'B' } }, 'update');
    expect(wire).not.toHaveProperty('calendars');
    expect(wire).not.toHaveProperty('schedulingAddresses');
  });

  // Duplicating a contact, or moving it to another account, creates the copy
  // from the whole card: the maps and the flat links read from them.
  it('writes the entries of a card that carries them, not the flat links', () => {
    const wire = contactToWire(linked(), 'create');
    expect(wire.calendars).toEqual(CALENDARS);
    expect(wire.schedulingAddresses).toEqual(SCHEDULING);
    expect(wire).not.toHaveProperty('calendarUri');
    expect(wire).not.toHaveProperty('freeBusyUri');
    expect(wire).not.toHaveProperty('schedulingUri');
  });

  it('builds the entries from the flat links when the card has the key without a map', () => {
    const wire = contactToWire({ calendars: undefined, schedulingAddresses: undefined, calendarUri: 'https://cal', schedulingUri: 'mailto:s@x' }, 'create');
    expect(wire.calendars).toEqual({ cal: { '@type': 'Calendar', kind: 'calendar', uri: 'https://cal' } });
    expect(wire.schedulingAddresses).toEqual({ sched: { '@type': 'SchedulingAddress', uri: 'mailto:s@x' } });
  });

  it('never clears id, uid or the address books', () => {
    const wire = contactToWire({ uid: undefined, addressBookIds: null as never, notes: undefined }, 'update');
    expect(wire).toEqual({ notes: null });
  });

  // vCard import: flat ADR fields, LABEL, SOURCE and BIRTHPLACE.
  it('writes what a vCard import holds as RFC 9553 has it', () => {
    const [card] = parseVCard([
      'BEGIN:VCARD',
      'VERSION:3.0',
      'FN:Max Muster',
      'ADR;TYPE=HOME;LABEL="Hauptstr. 1, Berlin":;;Hauptstr. 1;Berlin;;10115;Germany',
      'SOURCE:https://dir.example/max.vcf',
      'BDAY:19800102',
      'BIRTHPLACE:Hamburg',
      'END:VCARD',
    ].join('\r\n'));
    const { id: _id, addressBookIds: _b, ...data } = card;
    const wire = contactToWire(data, 'create');
    const address = Object.values(wire.addresses as Record<string, Record<string, unknown>>)[0];
    for (const flat of ['street', 'locality', 'region', 'postcode', 'country', 'fullAddress']) {
      expect(address).not.toHaveProperty(flat);
    }
    expect(address.components).toEqual([
      { kind: 'name', value: 'Hauptstr. 1' },
      { kind: 'locality', value: 'Berlin' },
      { kind: 'postcode', value: '10115' },
      { kind: 'country', value: 'Germany' },
    ]);
    expect(address.full).toBe('Hauptstr. 1, Berlin');
    expect(wire).not.toHaveProperty('source');
    expect(wire.directories).toEqual({ source: { '@type': 'Directory', kind: 'entry', uri: 'https://dir.example/max.vcf' } });
    const birth = Object.values(wire.anniversaries as Record<string, { place?: Record<string, unknown> }>)[0];
    expect(birth.place).toEqual({ full: 'Hamburg' });
  });

  it('drops the client-only account fields', () => {
    const wire = contactToWire({ originalId: 'x', accountId: 'a', accountName: 'n', isShared: true, name: { full: 'C' } }, 'create');
    expect(wire).toEqual({ name: { full: 'C' } });
  });
});

describe('contactFromWire', () => {
  it('fills the flat links from what the server stores', () => {
    const card = contactFromWire({
      id: 'c',
      addressBookIds: {},
      calendars: { x: { kind: 'calendar', uri: 'https://cal' }, y: { kind: 'freeBusy', uri: 'https://fb' } },
      schedulingAddresses: { s: { uri: 'mailto:s@x' } },
      directories: { d: { kind: 'entry', uri: 'https://src' } },
    } as ContactCard);
    expect(card).toMatchObject({
      calendarUri: 'https://cal', freeBusyUri: 'https://fb', schedulingUri: 'mailto:s@x', source: 'https://src',
    });
  });

  it('round-trips through the wire form', () => {
    const app = { calendarUri: 'https://cal', freeBusyUri: 'https://fb', schedulingUri: 'mailto:s@x' };
    const back = contactFromWire({ id: 'c', addressBookIds: {}, ...contactToWire(app, 'create') } as ContactCard);
    expect(back).toMatchObject(app);
  });
});

describe('linksToPatch', () => {
  const shown = { calendarUri: CALENDARS['work-cal'].uri, freeBusyUri: CALENDARS['work-busy'].uri, schedulingUri: SCHEDULING['itip-work'].uri };

  it('sends nothing for links that still read as stored', () => {
    expect(linksToPatch(linked(), shown)).toEqual({});
  });

  it('changes only the uri of the entry an edited link was read from', () => {
    expect(linksToPatch(linked(), { ...shown, calendarUri: 'https://cal.example/moved' })).toEqual({
      calendars: { ...CALENDARS, 'work-cal': { ...CALENDARS['work-cal'], uri: 'https://cal.example/moved' } },
      calendarUri: 'https://cal.example/moved',
      freeBusyUri: shown.freeBusyUri,
    });
    expect(linksToPatch(linked(), { ...shown, freeBusyUri: 'https://cal.example/moved-busy' }).calendars).toEqual({
      ...CALENDARS, 'work-busy': { ...CALENDARS['work-busy'], uri: 'https://cal.example/moved-busy' },
    });
    expect(linksToPatch(linked(), { ...shown, schedulingUri: 'mailto:moved@example.com' })).toEqual({
      schedulingAddresses: { ...SCHEDULING, 'itip-work': { ...SCHEDULING['itip-work'], uri: 'mailto:moved@example.com' } },
      schedulingUri: 'mailto:moved@example.com',
    });
  });

  it('keeps the order of the entries, so the edited one is still the one shown', () => {
    const patch = linksToPatch(linked(), { ...shown, calendarUri: 'https://cal.example/moved' });
    expect(Object.keys(patch.calendars!)).toEqual(Object.keys(CALENDARS));
  });

  it('removes only the entry of an emptied link, and shows the next of its kind', () => {
    const { 'work-cal': _gone, ...rest } = CALENDARS;
    expect(linksToPatch(linked(), { ...shown, calendarUri: '' })).toEqual({
      calendars: rest,
      calendarUri: CALENDARS['home-cal'].uri,
      freeBusyUri: shown.freeBusyUri,
    });
    expect(linksToPatch(linked(), { ...shown, schedulingUri: '' })).toEqual({
      schedulingAddresses: { 'itip-home': SCHEDULING['itip-home'] },
      schedulingUri: SCHEDULING['itip-home'].uri,
    });
  });

  it('clears a map when its last entry goes', () => {
    const card = contactFromWire({
      id: 'c', addressBookIds: {},
      calendars: { x: { kind: 'calendar', uri: 'https://cal' } },
      schedulingAddresses: { s: { uri: 'mailto:s@x' } },
    } as ContactCard);
    expect(linksToPatch(card, { calendarUri: '', freeBusyUri: '', schedulingUri: '' })).toEqual({
      calendars: null, calendarUri: null, schedulingAddresses: null, schedulingUri: null,
    });
  });

  it('adds a new link beside the stored entries', () => {
    const card = contactFromWire({
      id: 'c', addressBookIds: {},
      calendars: { busy: { kind: 'freeBusy', uri: 'https://fb', label: 'Availability' } },
    } as ContactCard);
    expect(linksToPatch(card, { calendarUri: 'https://cal', freeBusyUri: 'https://fb', schedulingUri: 'mailto:s@x' })).toEqual({
      calendars: {
        busy: { kind: 'freeBusy', uri: 'https://fb', label: 'Availability' },
        cal: { '@type': 'Calendar', kind: 'calendar', uri: 'https://cal' },
      },
      calendarUri: 'https://cal',
      freeBusyUri: 'https://fb',
      schedulingAddresses: { sched: { '@type': 'SchedulingAddress', uri: 'mailto:s@x' } },
      schedulingUri: 'mailto:s@x',
    });
  });

  it('reads a stored link with spaces around it as unchanged', () => {
    const card = contactFromWire({
      id: 'c', addressBookIds: {},
      calendars: { x: { kind: 'calendar', uri: ' https://cal ' } },
      schedulingAddresses: { s: { uri: ' mailto:s@x ' } },
    } as ContactCard);
    expect(saveForm(card).patch).not.toHaveProperty('calendars');
    expect(saveForm(card).patch).not.toHaveProperty('schedulingAddresses');
  });

  it('does not reuse a key another entry has', () => {
    const card = contactFromWire({
      id: 'c', addressBookIds: {},
      calendars: { cal: { kind: 'freeBusy', uri: 'https://fb' } },
    } as ContactCard);
    const patch = linksToPatch(card, { calendarUri: 'https://cal', freeBusyUri: 'https://fb', schedulingUri: '' });
    expect(Object.keys(patch.calendars!)).toEqual(['cal', 'cal2']);
    expect(patch.calendars!.cal).toEqual({ kind: 'freeBusy', uri: 'https://fb' });
  });

  it('gives a new contact the entries for its links', () => {
    expect(linksToPatch(undefined, { calendarUri: 'https://cal', freeBusyUri: '', schedulingUri: '' })).toEqual({
      calendars: { cal: { '@type': 'Calendar', kind: 'calendar', uri: 'https://cal' } },
      calendarUri: 'https://cal',
    });
    expect(linksToPatch(undefined, { calendarUri: '', freeBusyUri: '', schedulingUri: '' })).toEqual({});
  });

  // A create whose re-fetch failed leaves the store with the flat links only;
  // the server then holds the `cal` and `fb` the app wrote for them.
  it('builds on the entries the app wrote when the copy has no map', () => {
    const card = { id: 'c', addressBookIds: {}, calendarUri: 'https://cal', freeBusyUri: 'https://fb' } as ContactCard;
    expect(linksToPatch(card, { calendarUri: 'https://moved', freeBusyUri: 'https://fb', schedulingUri: '' }).calendars).toEqual({
      cal: { '@type': 'Calendar', kind: 'calendar', uri: 'https://moved' },
      fb: { '@type': 'Calendar', kind: 'freeBusy', uri: 'https://fb' },
    });
  });
});

// The whole save path: the card as fetched, through the form, to the patch
// ContactCard/set receives.
describe('saving the contact form', () => {
  it('sends no calendar or scheduling entries when no link was touched', () => {
    const { wire } = saveForm(linked());
    expect(wire).not.toHaveProperty('calendars');
    expect(wire).not.toHaveProperty('schedulingAddresses');
  });

  it('sends the stored entries with one uri changed when a link was edited', () => {
    const { wire } = saveForm(linked(), { calendarUri: ' https://cal.example/moved ' });
    expect(wire.calendars).toEqual({ ...CALENDARS, 'work-cal': { ...CALENDARS['work-cal'], uri: 'https://cal.example/moved' } });
    expect(wire).not.toHaveProperty('schedulingAddresses');
    expect(wire).not.toHaveProperty('calendarUri');
    expect(wire).not.toHaveProperty('freeBusyUri');
  });

  it('keeps the flat links of the patch in step with its entries', () => {
    const { patch } = saveForm(linked(), { calendarUri: '', schedulingUri: 'mailto:moved@example.com' });
    // What a fresh fetch would show for the entries the patch stores.
    const fetched = contactFromWire({
      id: 'c', addressBookIds: {}, calendars: patch.calendars, schedulingAddresses: patch.schedulingAddresses,
    } as ContactCard);
    expect(patch.calendarUri).toBe(CALENDARS['home-cal'].uri);
    expect(patch).toMatchObject({
      calendarUri: fetched.calendarUri, freeBusyUri: fetched.freeBusyUri, schedulingUri: fetched.schedulingUri,
    });
  });
});
