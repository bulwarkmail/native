import { describe, it, expect } from 'vitest';
import {
  parseVCard,
  generateVCard,
  contactToVCard,
  detectDuplicates,
} from '../vcard';
import type { ContactCard } from '../../api/types';

describe('parseVCard', () => {
  it('keeps FN as name.full so the written card carries the mandatory FN (#430)', () => {
    const fnOnly = parseVCard('BEGIN:VCARD\r\nVERSION:3.0\r\nFN:John Doe\r\nEND:VCARD');
    expect(fnOnly[0].name?.full).toBe('John Doe');

    // FN before N: N replaces the components but must keep full.
    const fnFirst = parseVCard('BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Dr. John Doe Jr.\r\nN:Doe;John;;;\r\nEND:VCARD');
    expect(fnFirst[0].name?.full).toBe('Dr. John Doe Jr.');

    // N before FN: FN fills full on the existing name.
    const nFirst = parseVCard('BEGIN:VCARD\r\nVERSION:3.0\r\nN:Doe;John;;;\r\nFN:Dr. John Doe Jr.\r\nEND:VCARD');
    expect(nFirst[0].name?.full).toBe('Dr. John Doe Jr.');
    expect(nFirst[0].name?.components?.find((c) => c.kind === 'given')?.value).toBe('John');
  });

  it('derives name.full from N when a card has no FN (#430)', () => {
    const [card] = parseVCard('BEGIN:VCARD\r\nVERSION:3.0\r\nN:Doe;John;Q;Dr.;Jr.\r\nEND:VCARD');
    expect(card.name?.full).toBe('Dr. John Q Doe Jr.');
  });

  it('parses a basic 3.0 card with name, email, and phone', () => {
    const vcf = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'FN:Jane Doe',
      'N:Doe;Jane;;;',
      'EMAIL;TYPE=WORK:jane@example.com',
      'TEL;TYPE=CELL:+1-555-0100',
      'END:VCARD',
    ].join('\r\n');

    const [card] = parseVCard(vcf);
    expect(card).toBeTruthy();
    const emails = Object.values(card.emails ?? {});
    expect(emails[0].address).toBe('jane@example.com');
    expect(emails[0].contexts).toEqual({ work: true });
    const phones = Object.values(card.phones ?? {});
    expect(phones[0].number).toBe('+1-555-0100');
    expect(phones[0].features).toEqual({ cell: true });
    const given = card.name?.components?.find((c) => c.kind === 'given')?.value;
    const surname = card.name?.components?.find((c) => c.kind === 'surname')?.value;
    expect(given).toBe('Jane');
    expect(surname).toBe('Doe');
  });

  it('parses multiple cards in one file', () => {
    const vcf = [
      'BEGIN:VCARD', 'VERSION:3.0', 'FN:A', 'EMAIL:a@x.com', 'END:VCARD',
      'BEGIN:VCARD', 'VERSION:3.0', 'FN:B', 'EMAIL:b@x.com', 'END:VCARD',
    ].join('\r\n');
    expect(parseVCard(vcf)).toHaveLength(2);
  });

  it('unfolds folded lines and decodes escaped values', () => {
    const vcf = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'FN:Long Name',
      'NOTE:line one\\nline two\\, still going',
      'END:VCARD',
    ].join('\r\n');
    const [card] = parseVCard(vcf);
    const note = Object.values(card.notes ?? {})[0]?.note;
    expect(note).toBe('line one\nline two, still going');
  });

  it('parses CATEGORIES into keywords', () => {
    const vcf = 'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Tagged\r\nEMAIL:t@x.com\r\nCATEGORIES:Friends,VIP\r\nEND:VCARD';
    const [card] = parseVCard(vcf);
    expect(card.keywords).toEqual({ Friends: true, VIP: true });
  });

  it('skips cards with neither a name nor an email', () => {
    const vcf = 'BEGIN:VCARD\r\nVERSION:3.0\r\nNOTE:orphan\r\nEND:VCARD';
    expect(parseVCard(vcf)).toHaveLength(0);
  });

  it('strips mailto:/tel: URI schemes', () => {
    const vcf = 'BEGIN:VCARD\r\nVERSION:4.0\r\nFN:U\r\nEMAIL:mailto:u@x.com\r\nTEL:tel:+15550111\r\nEND:VCARD';
    const [card] = parseVCard(vcf);
    expect(Object.values(card.emails ?? {})[0].address).toBe('u@x.com');
    expect(Object.values(card.phones ?? {})[0].number).toBe('+15550111');
  });
});

describe('generateVCard', () => {
  it('round-trips name and email through parse → generate → parse', () => {
    const original = 'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Jane Doe\r\nN:Doe;Jane;;;\r\nEMAIL;TYPE=WORK:jane@example.com\r\nEND:VCARD';
    const [parsed] = parseVCard(original);
    const generated = generateVCard([parsed]);
    expect(generated).toContain('FN:Jane Doe');
    expect(generated).toContain('EMAIL;TYPE=WORK:jane@example.com');

    const [reparsed] = parseVCard(generated);
    expect(Object.values(reparsed.emails ?? {})[0].address).toBe('jane@example.com');
  });

  it('contactToVCard emits a single BEGIN/END block', () => {
    const card: ContactCard = {
      id: 'c1',
      addressBookIds: {},
      name: { full: 'Solo', components: [{ kind: 'given', value: 'Solo' }] },
      emails: { e0: { address: 'solo@x.com' } },
    };
    const out = contactToVCard(card);
    expect(out.match(/BEGIN:VCARD/g)).toHaveLength(1);
    expect(out.match(/END:VCARD/g)).toHaveLength(1);
  });
});

describe('detectDuplicates', () => {
  const existing: ContactCard[] = [
    { id: 'x1', addressBookIds: {}, emails: { e0: { address: 'dupe@x.com' } } },
  ];

  it('flags an incoming contact that shares an email (case-insensitive)', () => {
    const incoming: ContactCard[] = [
      { id: 'i0', addressBookIds: {}, emails: { e0: { address: 'fresh@x.com' } } },
      { id: 'i1', addressBookIds: {}, emails: { e0: { address: 'DUPE@x.com' } } },
    ];
    const dupes = detectDuplicates(existing, incoming);
    expect(dupes.has(0)).toBe(false);
    expect(dupes.get(1)).toBe('x1');
  });

  it('returns an empty map when nothing overlaps', () => {
    const incoming: ContactCard[] = [
      { id: 'i0', addressBookIds: {}, emails: { e0: { address: 'new@x.com' } } },
    ];
    expect(detectDuplicates(existing, incoming).size).toBe(0);
  });
});

describe('anniversary dates (issue #224)', () => {
  const parseOne = (...props: string[]) =>
    parseVCard(['BEGIN:VCARD', 'VERSION:4.0', 'FN:Test Person', ...props, 'END:VCARD'].join('\r\n'))[0];

  it('parses BDAY into a structured PartialDate, not a raw string', () => {
    // JSContact rejects a string date, which is why imported birthdays used
    // to disappear once they reached the server.
    const card = parseOne('BDAY:19850412');
    const birth = Object.values(card.anniversaries || {}).find((a) => a.kind === 'birth');
    expect(birth?.date).toEqual({ year: 1985, month: 4, day: 12 });
  });

  it.each([
    ['BDAY:1985-04-12', { year: 1985, month: 4, day: 12 }],
    ['BDAY:19850412T232050Z', { year: 1985, month: 4, day: 12 }],
    ['BDAY:1985-04-12T00:00:00Z', { year: 1985, month: 4, day: 12 }],
    ['BDAY:--0412', { month: 4, day: 12 }],
    ['BDAY:--04-12', { month: 4, day: 12 }],
    ['BDAY:--04', { month: 4 }],
    ['BDAY:---12', { day: 12 }],
    ['BDAY:1985-04', { year: 1985, month: 4 }],
    ['BDAY:1985', { year: 1985 }],
  ])('parses %s', (prop, expected) => {
    const card = parseOne(prop);
    expect(Object.values(card.anniversaries || {})[0]?.date).toEqual(expected);
  });

  it.each([
    'BDAY;VALUE=text:circa 1800',
    'BDAY:not-a-date',
    'BDAY:1985-13-01',
    'BDAY:',
  ])('drops the unrepresentable date in %s', (prop) => {
    expect(parseOne(prop).anniversaries).toBeUndefined();
  });

  it('keeps BDAY and ANNIVERSARY side by side instead of overwriting', () => {
    const card = parseOne('ANNIVERSARY:20100601', 'BDAY:19850412');
    const kinds = Object.values(card.anniversaries || {}).map((a) => a.kind);
    expect(kinds).toEqual(expect.arrayContaining(['wedding', 'birth']));
    expect(Object.keys(card.anniversaries || {})).toHaveLength(2);
  });

  it('round-trips a birthday through generateVCard', () => {
    const exported = generateVCard([parseOne('BDAY:19850412')]);
    expect(exported).toContain('BDAY:1985-04-12');
    const reparsed = parseVCard(exported)[0];
    expect(Object.values(reparsed.anniversaries || {})[0]?.date).toEqual({
      year: 1985, month: 4, day: 12,
    });
  });

  it('round-trips a day/month-only birthday', () => {
    const exported = generateVCard([parseOne('BDAY:--0412')]);
    expect(exported).toContain('BDAY:--04-12');
    expect(Object.values(parseVCard(exported)[0].anniversaries || {})[0]?.date)
      .toEqual({ month: 4, day: 12 });
  });

  it('exports an unclassified anniversary as X-ABDATE and reads it back', () => {
    const card: ContactCard = {
      id: 'c-other',
      addressBookIds: {},
      name: { components: [{ kind: 'given', value: 'Ann' }] },
      anniversaries: { a0: { kind: 'other', date: { year: 2015, month: 9, day: 20 } } },
    };
    const exported = generateVCard([card]);
    expect(exported).toContain('X-ABDATE:2015-09-20');
    const reparsed = parseVCard(exported)[0];
    expect(Object.values(reparsed.anniversaries || {})).toEqual([
      { kind: 'other', date: { year: 2015, month: 9, day: 20 } },
    ]);
  });
});

describe('vendor extensions (issue #224)', () => {
  const parseOne = (...props: string[]) =>
    parseVCard(['BEGIN:VCARD', 'VERSION:3.0', 'FN:Test Person', ...props, 'END:VCARD'].join('\r\n'))[0];

  it('imports X-ANDROID-CUSTOM nicknames', () => {
    const card = parseOne('X-ANDROID-CUSTOM:vnd.android.cursor.item/nickname;Bobby;1;;;;;;;;;;;;;');
    expect(Object.values(card.nicknames || {})).toEqual([{ name: 'Bobby' }]);
  });

  it('keeps every NICKNAME instead of overwriting the first', () => {
    const card = parseOne('NICKNAME:JD', 'NICKNAME:Johnny');
    expect(Object.values(card.nicknames || {})).toEqual([{ name: 'JD' }, { name: 'Johnny' }]);
  });

  it('imports X-ANDROID-CUSTOM contact events as anniversaries', () => {
    const card = parseOne(
      'X-ANDROID-CUSTOM:vnd.android.cursor.item/contact_event;1985-04-12;3;;;;;;;;;;;;;',
      'X-ANDROID-CUSTOM:vnd.android.cursor.item/contact_event;2010-06-01;1;;;;;;;;;;;;;',
    );
    expect(Object.values(card.anniversaries || {})).toEqual([
      { kind: 'birth', date: { year: 1985, month: 4, day: 12 } },
      { kind: 'wedding', date: { year: 2010, month: 6, day: 1 } },
    ]);
  });

  it('imports X-ANDROID-CUSTOM relations', () => {
    const card = parseOne('X-ANDROID-CUSTOM:vnd.android.cursor.item/relation;Jane Doe;14;;;;;;;;;;;;;');
    expect(card.relatedTo?.['Jane Doe']).toEqual({ relation: { spouse: true } });
  });

  it('imports Apple grouped X-ABDATE with its X-ABLABEL', () => {
    const card = parseOne(
      'item1.X-ABDATE:2010-06-01',
      'item1.X-ABLABEL:_$!<Anniversary>!$_',
      'item2.X-ABDATE:2015-09-20',
      'item2.X-ABLABEL:First day at work',
    );
    expect(Object.values(card.anniversaries || {})).toEqual([
      { kind: 'wedding', date: { year: 2010, month: 6, day: 1 } },
      { kind: 'other', date: { year: 2015, month: 9, day: 20 } },
    ]);
  });

  it('applies a grouped X-ABLABEL to the property it labels', () => {
    const card = parseOne(
      'item1.TEL;TYPE=VOICE:+1-555-0100',
      'item1.X-ABLABEL:Ski cabin',
      'item2.EMAIL:side@example.com',
      'item2.X-ABLABEL:_$!<Other>!$_',
    );
    expect(card.phones?.p0?.label).toBe('Ski cabin');
    expect(card.emails?.e0?.label).toBe('Other');
  });

  it('still parses grouped properties that carry no label', () => {
    const card = parseOne('item1.EMAIL;TYPE=INTERNET:grouped@example.com');
    expect(card.emails?.e0?.address).toBe('grouped@example.com');
    expect(card.emails?.e0?.label).toBeUndefined();
  });

  it('imports X-ABRELATEDNAMES and X-SPOUSE as relations', () => {
    const card = parseOne(
      'item1.X-ABRELATEDNAMES:Sam Smith',
      'item1.X-ABLABEL:_$!<Brother>!$_',
      'X-SPOUSE:Alex Smith',
    );
    expect(card.relatedTo?.['Sam Smith']).toEqual({ relation: { sibling: true } });
    expect(card.relatedTo?.['Alex Smith']).toEqual({ relation: { spouse: true } });
  });

  it('imports X- instant-messaging handles as online services', () => {
    const card = parseOne('X-SKYPE-USERNAME:jdoe', 'X-TWITTER:https://twitter.com/jdoe');
    const services = Object.values(card.onlineServices || {});
    expect(services).toEqual(expect.arrayContaining([
      expect.objectContaining({ service: 'Skype', uri: 'jdoe', user: 'jdoe' }),
      expect.objectContaining({ service: 'Twitter', uri: 'https://twitter.com/jdoe' }),
    ]));
    expect(services.find((s) => s.service === 'Twitter')?.user).toBeUndefined();
  });

  it('imports X-GENDER and round-trips X-MAIDENNAME', () => {
    const card = parseOne('N:Smith;Jane;;;', 'X-GENDER:Female', 'X-MAIDENNAME:Brown');
    expect(card.speakToAs?.grammaticalGender).toBe('feminine');
    expect(card.name?.components).toEqual(
      expect.arrayContaining([{ kind: 'surname2', value: 'Brown' }]),
    );

    const reparsed = parseVCard(generateVCard([card]))[0];
    expect(reparsed.name?.components).toEqual(
      expect.arrayContaining([{ kind: 'surname2', value: 'Brown' }]),
    );
  });

  it('leaves unknown X- properties alone', () => {
    const card = parseOne('X-SOMETHING-ELSE:whatever');
    expect(card.onlineServices).toBeUndefined();
    expect(card.notes).toBeUndefined();
  });
});

describe('organization-only cards (issue #701)', () => {
  it('keeps a vCard that has only an organization name', () => {
    const parsed = parseVCard([
      'BEGIN:VCARD',
      'VERSION:4.0',
      'KIND:org',
      'ORG:Acme Corp',
      'TEL:+1-555-0100',
      'END:VCARD',
    ].join('\r\n'));

    expect(parsed).toHaveLength(1);
    expect(parsed[0].kind).toBe('org');
    expect(parsed[0].organizations?.o0.name).toBe('Acme Corp');
  });

  it('uses the organization name as FN for organization cards', () => {
    const contact: ContactCard = {
      id: 'c4',
      addressBookIds: {},
      kind: 'org',
      organizations: { o0: { name: 'Acme Corp' } },
    };
    const vcf = generateVCard([contact]);
    expect(vcf).toContain('KIND:org');
    expect(vcf).toContain('FN:Acme Corp');
    expect(vcf).toContain('ORG:Acme Corp');
    expect(parseVCard(vcf)).toHaveLength(1);
  });
});
