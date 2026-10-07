import { describe, it, expect } from 'vitest';
import type { ContactCard } from '../../api/types';
import {
  canSaveContactForm, contactFormPatchBase, contactFormSeed, formToPatch, shouldSeedContactForm, type FormState,
} from '../contact-form-seed';

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

  it('never saves an edit form not yet seeded from its contact', () => {
    // The card is there, but the render that seeds the form has not happened.
    expect(canSaveContactForm({ isEdit: true, existing: card, seededFrom: undefined })).toBe(false);
    expect(canSaveContactForm({ isEdit: true, existing: card, seededFrom: { ...card, id: 'C1' } })).toBe(false);
  });

  it('saves an edit form once seeded from its contact, and a new contact any time', () => {
    expect(canSaveContactForm({ isEdit: true, existing: card, seededFrom: card })).toBe(true);
    // A newer copy of the same card: the patch stays relative to the seed.
    expect(canSaveContactForm({ isEdit: true, existing: { ...card }, seededFrom: card })).toBe(true);
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

describe('seeding, re-seeding and the patch base', () => {
  // What the screen does on each render and on Save, without React.
  interface Screen { seededFrom: ContactCard | undefined; form: FormState; dirty: boolean }
  const open = (existing: ContactCard | undefined): Screen => ({
    seededFrom: existing, form: contactFormSeed(existing, undefined), dirty: false,
  });
  const render = (screen: Screen, existing: ContactCard | undefined): Screen =>
    shouldSeedContactForm({ seededFrom: screen.seededFrom, existing, dirty: screen.dirty })
      ? { ...screen, seededFrom: existing, form: contactFormSeed(existing, undefined) }
      : screen;
  const type = (screen: Screen, change: Partial<FormState>): Screen =>
    ({ ...screen, form: { ...screen.form, ...change }, dirty: true });
  const save = (screen: Screen) =>
    formToPatch(screen.form, contactFormPatchBase({ isEdit: true, seededFrom: screen.seededFrom }), false, []);

  // The persisted cache keeps no photos; the server's copy has one, and a phone added elsewhere.
  const cached: ContactCard = { ...card };
  const server: ContactCard = {
    ...card,
    media: { photo: { kind: 'photo', uri: 'https://example.com/ann.jpg', mediaType: 'image/jpeg' } },
    phones: { ...card.phones, p2: { number: '+1 777' } },
  } as ContactCard;

  it('keeps the photo the cached card lacked when the server card replaces it after the user typed', () => {
    let screen = open(cached);
    screen = type(screen, { given: 'Anna' });
    screen = render(screen, server);
    expect(screen.seededFrom).toBe(cached);
    const patch = save(screen);
    expect(patch).not.toHaveProperty('media');
    // Patched against the server card, the old code cleared the photo.
    expect(formToPatch(screen.form, server, false, [])).toHaveProperty('media', null);
  });

  it('keeps the user\'s values and the seed card when the server card changes mid-typing', () => {
    let screen = open(server);
    screen = type(screen, { surname: 'Leigh' });
    const newer = { ...server, notes: { n1: { note: 'Changed elsewhere' } } } as ContactCard;
    screen = render(screen, newer);
    expect(screen.form.surname).toBe('Leigh');
    expect(screen.seededFrom).toBe(server);
    expect(contactFormPatchBase({ isEdit: true, seededFrom: screen.seededFrom })).toBe(server);
  });

  it('re-seeds from the server card when it changes before the user types', () => {
    let screen = open(cached);
    screen = render(screen, server);
    expect(screen.seededFrom).toBe(server);
    expect(screen.form.phones).toHaveLength(2);
    expect(screen.form.photoUri).toBe('https://example.com/ann.jpg');
    const patch = save(screen);
    expect(patch.media).toEqual(server.media);
    expect(Object.keys(patch.phones ?? {})).toHaveLength(2);
  });

  it('seeds an edit opened before its card loaded, whatever the dirty flag says', () => {
    expect(shouldSeedContactForm({ seededFrom: undefined, existing: card, dirty: true })).toBe(true);
    expect(shouldSeedContactForm({ seededFrom: card, existing: card, dirty: false })).toBe(false);
    expect(shouldSeedContactForm({ seededFrom: card, existing: undefined, dirty: false })).toBe(false);
  });

  it('has no patch base for a new contact', () => {
    expect(contactFormPatchBase({ isEdit: false, seededFrom: card })).toBeUndefined();
  });
});
