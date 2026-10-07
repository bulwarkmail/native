import { describe, it, expect } from 'vitest';
import type { ContactCard } from '../../api/types';
import { canSaveContactForm, contactFormSeed } from '../contact-form-seed';

const card: ContactCard = {
  id: 'C9',
  addressBookIds: { book2: true },
  name: { components: [{ kind: 'given', value: 'Ann' }, { kind: 'surname', value: 'Lee' }] },
  emails: { e1: { address: 'ann@example.com', contexts: { work: true } } },
  phones: { p1: { number: '+1 555', features: { cell: true } } },
  notes: { n1: { note: 'Met at the fair' } },
  keywords: { friends: true },
} as ContactCard;

describe('canSaveContactForm', () => {
  it('never saves an edit form before its contact has loaded', () => {
    // A blank form saved as an edit nulls every collection the card has.
    expect(canSaveContactForm({ isEdit: true, existing: undefined })).toBe(false);
  });

  it('saves an edit form once its contact is there, and a new contact any time', () => {
    expect(canSaveContactForm({ isEdit: true, existing: card })).toBe(true);
    expect(canSaveContactForm({ isEdit: false, existing: undefined })).toBe(true);
  });
});

describe('contactFormSeed', () => {
  it('seeds an edit form from the card, not a blank one', () => {
    const form = contactFormSeed(card, undefined);
    expect(form.given).toBe('Ann');
    expect(form.surname).toBe('Lee');
    expect(form.emails).toEqual([{ address: 'ann@example.com', context: 'work' }]);
    expect(form.phones).toEqual([{ number: '+1 555', context: '', feature: 'cell' }]);
    expect(form.notes).toEqual([{ note: 'Met at the fair' }]);
    expect(form.keywords).toEqual(['friends']);
    expect(form.addressBookId).toBe('book2');
  });

  it('keeps the card\'s book over the one a new contact would go in', () => {
    expect(contactFormSeed(card, undefined, { addressBookId: 'book1' }).addressBookId).toBe('book2');
    expect(contactFormSeed(card, undefined, { memberIds: ['M1'] }).members).toEqual(['M1']);
  });

  it('starts a new contact blank in the given book with the pre-selected members', () => {
    const form = contactFormSeed(undefined, undefined, { addressBookId: 'book1', memberIds: ['M1', 'M2'] });
    expect(form.given).toBe('');
    expect(form.emails).toEqual([{ address: '', context: '' }]);
    expect(form.addressBookId).toBe('book1');
    expect(form.members).toEqual(['M1', 'M2']);
  });

  it('splits an email prefill\'s name into given and surname', () => {
    const form = contactFormSeed(undefined, { email: 'a@b.co', name: 'Ann Marie Lee' });
    expect(form.emails).toEqual([{ address: 'a@b.co', context: '' }]);
    expect(form.given).toBe('Ann');
    expect(form.surname).toBe('Marie Lee');
  });

  it('never lets a mailbox-shaped name through (#672)', () => {
    const form = contactFormSeed(undefined, { email: 'a@b.co', name: 'Ann Lee <a@b.co>' });
    expect(form.given).toBe('Ann');
    expect(form.surname).toBe('Lee');
  });

  it('handles a name-only prefill', () => {
    const form = contactFormSeed(undefined, { name: 'Ann Lee' });
    expect(form.given).toBe('Ann');
    expect(form.surname).toBe('Lee');
    expect(form.emails).toEqual([{ address: '', context: '' }]);
    const single = contactFormSeed(undefined, { name: ' Ann ' });
    expect(single.given).toBe('Ann');
    expect(single.surname).toBe('');
    // A pasted mailbox as the name keeps only the name.
    expect(contactFormSeed(undefined, { name: '"Ann Lee" <a@b.co>' }).given).toBe('Ann');
  });
});
