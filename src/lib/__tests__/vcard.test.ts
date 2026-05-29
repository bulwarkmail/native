import { describe, it, expect } from 'vitest';
import {
  parseVCard,
  generateVCard,
  contactToVCard,
  detectDuplicates,
} from '../vcard';
import type { ContactCard } from '../../api/types';

describe('parseVCard', () => {
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
