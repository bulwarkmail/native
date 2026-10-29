import { describe, it, expect } from 'vitest';
import { contactFromWire, contactToWire } from '../contact-wire';
import { parseVCard } from '../vcard';
import type { ContactCard } from '../../api/types';

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
