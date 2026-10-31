import { describe, expect, it } from 'vitest';

// Ported from the webmail's lib/__tests__/recipient-mentions.test.ts, plus
// the app's own helpers at the end.
import {
  addMentionedRecipient, buildMentionCandidates, filterMentionCandidates, mentionHref, mentionLabel, mentionSuggestions,
} from '../recipient-mentions';

describe('mentionLabel', () => {
  it('takes the first name from a display name', () => {
    expect(mentionLabel('Max Mustermann', 'mm@dornig.de')).toBe('Max');
    expect(mentionLabel('Mustermann, Max', 'mm@dornig.de')).toBe('Max');
    expect(mentionLabel('Dr. Max Mustermann', 'mm@dornig.de')).toBe('Max');
    expect(mentionLabel('Prof. Dr.-Ing. Max Mustermann', 'mm@dornig.de')).toBe('Max');
    expect(mentionLabel('Jürgen Müller', 'jm@dornig.de')).toBe('Jürgen');
    expect(mentionLabel("'Max Mustermann'", 'mm@dornig.de')).toBe('Max');
  });

  it('takes the first name from a firstname.lastname address when no name is known', () => {
    expect(mentionLabel(undefined, 'max.mustermann@dornig.de')).toBe('Max');
    expect(mentionLabel('', 'anna-lena.schmidt@dornig.de')).toBe('Anna-Lena');
    expect(mentionLabel(undefined, 'max.mustermann+rechnungen@dornig.de')).toBe('Max');
    expect(mentionLabel(undefined, 'juergen.mueller@dornig.de')).toBe('Juergen');
    expect(mentionLabel(undefined, 'info@dornig.de')).toBe('Info');
  });

  it('lets a firstname.lastname address tell which word of the name is the first name', () => {
    expect(mentionLabel('Mustermann Max', 'max.mustermann@dornig.de')).toBe('Max');
    expect(mentionLabel('Müller Jürgen', 'juergen.mueller@dornig.de')).toBe('Jürgen');
    expect(mentionLabel('Dornig GmbH - Max Mustermann', 'max.mustermann@dornig.de')).toBe('Max');
    // A one-part mailbox name confirms nothing: it may be the last name.
    expect(mentionLabel('Max Mustermann', 'mustermann@dornig.de')).toBe('Max');
  });

  it('treats a display name that is an address or mailbox name like the address', () => {
    expect(mentionLabel('max.mustermann@dornig.de', 'max.mustermann@dornig.de')).toBe('Max');
    expect(mentionLabel('max.mustermann', 'mm@dornig.de')).toBe('Max');
  });

  it('keeps the whole mailbox name when the first name is a bare initial', () => {
    expect(mentionLabel(undefined, 'm.mustermann@dornig.de')).toBe('m.mustermann');
    expect(mentionLabel(undefined, 'm.mustermann+news@dornig.de')).toBe('m.mustermann');
    expect(mentionLabel('M. Mustermann', 'm.mustermann@dornig.de')).toBe('m.mustermann');
    // The address may know more than the display name.
    expect(mentionLabel('M. Mustermann', 'max.mustermann@dornig.de')).toBe('Max');
  });

  it('stays fast on a crafted display name from an incoming message', () => {
    // Uncapped, trimming this token takes seconds (quadratic backtracking).
    const crafted = `a${'!'.repeat(100_000)}b`;
    const started = performance.now();
    expect(mentionLabel(crafted, 'max.mustermann@dornig.de')).toBe('Max');
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('buildMentionCandidates', () => {
  it('offers To and Cc recipients in order, each address once', () => {
    const candidates = buildMentionCandidates(
      [{ name: 'Max Mustermann', email: 'max.mustermann@dornig.de' }, { email: 'anna.schmidt@dornig.de' }],
      [{ email: 'MAX.MUSTERMANN@dornig.de' }, { name: 'Eva Weber', email: 'eva.weber@dornig.de' }],
    );
    expect(candidates).toEqual([
      { label: 'Max', name: 'Max Mustermann', email: 'max.mustermann@dornig.de' },
      { label: 'Anna', name: undefined, email: 'anna.schmidt@dornig.de' },
      { label: 'Eva', name: 'Eva Weber', email: 'eva.weber@dornig.de' },
    ]);
  });

  it('expands contact groups into their members and skips entries without an address', () => {
    const candidates = buildMentionCandidates(
      [{
        name: 'Team',
        email: '',
        group: { members: [{ name: 'Max Mustermann', email: 'max.mustermann@dornig.de' }, { email: 'eva.weber@dornig.de' }] },
      }],
      [{ email: 'not-an-address' }],
    );
    expect(candidates.map((c) => c.label)).toEqual(['Max', 'Eva']);
  });

  it('tells apart recipients who would share a first name', () => {
    const labels = (to: Array<{ name?: string; email: string }>) => buildMentionCandidates(to, []).map((c) => c.label);
    expect(labels([
      { name: 'Max Mustermann', email: 'a@dornig.de' },
      { name: 'Mueller, Max', email: 'b@dornig.de' },
      { name: 'Eva Weber', email: 'c@dornig.de' },
    ])).toEqual(['Max Mustermann', 'Max Mueller', 'Eva']);
    expect(labels([
      { name: 'Max Mustermann', email: 'max.mustermann@dornig.de' },
      { email: 'max.mueller@dornig.de' },
    ])).toEqual(['Max Mustermann', 'max.mueller']);
    expect(labels([
      { name: 'Max Mustermann', email: 'max.mustermann@dornig.de' },
      { name: 'Max Mustermann', email: 'max.mustermann2@dornig.de' },
    ])).toEqual(['max.mustermann', 'max.mustermann2']);
  });
});

describe('filterMentionCandidates', () => {
  const candidates = buildMentionCandidates(
    [
      { name: 'Max Mustermann', email: 'max.mustermann@dornig.de' },
      { name: 'Jürgen Müller', email: 'juergen.mueller@dornig.de' },
      { email: 'anna-lena.schmidt@dornig.de' },
    ],
    [],
  );
  const labels = (query: string) => filterMentionCandidates(candidates, query).map((c) => c.label);

  it('offers everyone for a bare @', () => {
    expect(labels('')).toEqual(['Max', 'Jürgen', 'Anna-Lena']);
  });

  it('matches the start of the label, a name word or a mailbox part, ignoring case', () => {
    expect(labels('ma')).toEqual(['Max']);
    expect(labels('MUSTER')).toEqual(['Max']);
    expect(labels('lena')).toEqual(['Anna-Lena']);
    expect(labels('schm')).toEqual(['Anna-Lena']);
    expect(labels('xyz')).toEqual([]);
  });

  it('finds umlaut names typed either way', () => {
    expect(labels('jü')).toEqual(['Jürgen']);
    expect(labels('jue')).toEqual(['Jürgen']);
    expect(labels('mül')).toEqual(['Jürgen']);
  });
});

describe('mentionSuggestions', () => {
  const recipients = buildMentionCandidates(
    [{ name: 'Max Mustermann', email: 'max.mustermann@dornig.de' }],
    [{ name: 'Eva Weber', email: 'eva.weber@dornig.de' }],
  );
  const shown = (list: ReturnType<typeof mentionSuggestions>) => list.map((c) => `${c.label} ${c.email} ${c.addsTo ?? '-'}`);

  it('offers matching recipients first, then contacts marked with the field they go to', () => {
    const contacts = [{ name: 'Marta Klein', email: 'marta@dornig.de' }];
    expect(shown(mentionSuggestions(recipients, contacts, 'ma', 'to'))).toEqual([
      'Max max.mustermann@dornig.de -',
      'Marta marta@dornig.de to',
    ]);
    expect(mentionSuggestions(recipients, contacts, 'ma', 'cc')[1].addsTo).toBe('cc');
  });

  it('leaves out contacts who are already recipients', () => {
    const contacts = [{ name: 'Eva W.', email: 'Eva.Weber@dornig.de' }];
    expect(shown(mentionSuggestions(recipients, contacts, 'ev', 'to'))).toEqual(['Eva eva.weber@dornig.de -']);
  });

  it('drops contacts that only matched in the middle of a word', () => {
    // The address autocomplete matches anywhere; an @ matches word starts.
    const contacts = [{ name: 'Thomas Bauer', email: 'thomas@dornig.de' }];
    expect(mentionSuggestions(recipients, contacts, 'ma', 'to').map((c) => c.email)).toEqual(['max.mustermann@dornig.de']);
  });

  it('skips groups and entries without a usable address', () => {
    const contacts = [{ name: 'Marketing', email: '' }, { name: 'Mara', email: 'mara' }];
    expect(mentionSuggestions([], contacts, 'ma', 'to')).toEqual([]);
  });

  it('renames a contact who shares a first name with a recipient, not the recipient', () => {
    const contacts = [{ name: 'Max Müller', email: 'max.mueller@dornig.de' }];
    expect(shown(mentionSuggestions(recipients, contacts, 'max', 'to'))).toEqual([
      'Max max.mustermann@dornig.de -',
      'Max Müller max.mueller@dornig.de to',
    ]);
    // The recipient list itself keeps its labels.
    expect(recipients[0].label).toBe('Max');
  });

  it('caps the contacts it offers', () => {
    const contacts = Array.from({ length: 20 }, (_, i) => ({ name: `Mia ${i}`, email: `mia${i}@dornig.de` }));
    expect(mentionSuggestions([], contacts, 'mia', 'to')).toHaveLength(8);
  });
});

describe('mentionHref', () => {
  it('addresses only the one mailbox, whatever the address carries', () => {
    expect(mentionHref('max@dornig.de')).toBe('mailto:max@dornig.de');
    expect(mentionHref('a?cc=evil@x.de#f@dornig.de')).toBe('mailto:a%3Fcc=evil@x.de%23f@dornig.de');
  });
});

describe('addMentionedRecipient', () => {
  const make = (c: { name?: string; email: string }): { name?: string; email: string } => ({ name: c.name, email: c.email });

  it('adds a contact who is not on the message yet', () => {
    const next = addMentionedRecipient<{ name?: string; email: string }>([{ email: 'eva@dornig.de' }], { label: 'Max', name: 'Max M', email: 'max@dornig.de', addsTo: 'to' }, make);
    expect(next).toEqual([{ email: 'eva@dornig.de' }, { name: 'Max M', email: 'max@dornig.de' }]);
  });

  it('leaves the field alone when the address is there already, also inside a group', () => {
    const list = [{ name: 'Team', email: '', group: { members: [{ email: 'MAX@dornig.de' }] } }];
    expect(addMentionedRecipient(list, { label: 'Max', email: 'max@dornig.de', addsTo: 'to' }, make)).toBe(list);
  });
});
