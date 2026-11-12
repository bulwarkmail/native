import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { ContactCard } from '../../api/types';
import { addPickedRecipients, contactEntries, pickedEntries, pickerKey } from '../compose-recipient-picker';

// A picker to tick recipients from the contacts and the directory (webmail
// directory-picker-dialog.tsx); the app had only the suggestions while typing.

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '..', '..', rel), 'utf8');

const contacts = [
  { id: 'c1', name: { full: 'Ann Lee' }, emails: { a: { address: 'ann@x.org' }, b: { address: ' ann@work.org ' } } },
  { id: 'c2', name: { full: 'Bob' }, emails: { a: { address: 'ANN@x.org' } } },
  { id: 'g1', kind: 'group', name: { full: 'Team' }, members: { c1: true } },
  { id: 'c3', emails: { a: { address: 'solo@x.org' } } },
] as unknown as ContactCard[];

describe('recipient picker', () => {
  it('lists every address of the contacts once, without groups', () => {
    const entries = contactEntries(contacts);
    expect(entries.map((e) => e.email)).toEqual(['ann@x.org', 'ann@work.org', 'solo@x.org']);
    expect(entries[0].name).toBe('Ann Lee');
    expect(entries[2].name).toBe('solo@x.org');
  });

  it('takes the ticked entries of both tabs in list order, each address once', () => {
    const own = contactEntries(contacts);
    const directory = [{ name: 'Carol', email: 'carol@x.org' }, { name: 'Ann', email: 'Ann@x.org' }];
    const selected = new Set([pickerKey({ email: 'carol@x.org' }), pickerKey({ email: 'ann@x.org' })]);
    expect(pickedEntries(selected, [own, directory]).map((e) => e.email)).toEqual(['ann@x.org', 'carol@x.org']);
  });

  it('adds them to a field after what it has, without an address twice', () => {
    const prev = [{ name: '', email: 'carol@x.org' }];
    const next = addPickedRecipients(prev, [
      { name: 'Carol', email: 'Carol@x.org' }, { name: 'Dan', email: 'dan@x.org' }, { name: 'eve@x.org', email: 'eve@x.org' },
    ], (e) => ({ name: e.name, email: e.email }));
    expect(next).toEqual([{ name: '', email: 'carol@x.org' }, { name: 'Dan', email: 'dan@x.org' }, { name: '', email: 'eve@x.org' }]);
  });

  // No RN renderer in the suite: the wiring, read from the source.
  it('opens from the To row and adds to the field picked', () => {
    const src = read('screens/ComposeScreen.tsx');
    expect(src).toMatch(/\{field === 'to' && \(hasContacts \|\| directoryAvailable\) && \(\s+<Pressable\s+onPress=\{\(\) => setRecipientSheetOpen\(true\)\}/);
    expect(src).toMatch(/<RecipientPickerSheet\s+visible=\{recipientSheetOpen\}[\s\S]{0,120}onAdd=\{addPickedToField\}/);
    expect(src).toMatch(/setterFor\(field\)\(\(prev\) => addPickedRecipients\(prev, entries,/);
    const sheet = read('components/compose/RecipientPickerSheet.tsx');
    expect(sheet).toMatch(/\{hasDirectory && \(\s+<View style=\{styles\.tabs\} accessibilityRole="tablist">/);
    expect(sheet).toMatch(/accessibilityRole="checkbox"/);
    expect(sheet).toMatch(/const entries = pickedEntries\(selected, \[ownEntries, directory\]\);/);
  });
});
