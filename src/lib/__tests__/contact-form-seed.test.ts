import { describe, it, expect } from 'vitest';
import type { ContactCard } from '../../api/types';
import {
  canSaveContactForm, contactFormMissingState, contactFormPatchBase, contactFormSeed, formToPatch,
  shouldSeedContactForm, type FormState,
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

// App accounts. Card ids repeat across accounts: B has a card C9 of its own.
const A = 'acct-a';
const B = 'acct-b';
const inA = { formAccount: A, shownAccount: A, seededAccount: A };

describe('canSaveContactForm', () => {
  it('never saves an edit form before its contact has loaded', () => {
    // A blank form saved as an edit nulls every collection the card has.
    expect(canSaveContactForm({ isEdit: true, existing: undefined, ...inA })).toBe(false);
  });

  it('never saves an edit form not yet seeded from its contact', () => {
    // The card is there, but the render that seeds the form has not happened.
    expect(canSaveContactForm({ isEdit: true, existing: card, seededFrom: undefined, ...inA })).toBe(false);
    expect(canSaveContactForm({ isEdit: true, existing: card, seededFrom: { ...card, id: 'C1' }, ...inA })).toBe(false);
  });

  it('saves an edit form once seeded from its contact, and a new contact any time', () => {
    expect(canSaveContactForm({ isEdit: true, existing: card, seededFrom: card, ...inA })).toBe(true);
    // A newer copy of the same card: the patch stays relative to the seed.
    expect(canSaveContactForm({ isEdit: true, existing: { ...card }, seededFrom: card, ...inA })).toBe(true);
    expect(canSaveContactForm({ isEdit: false, existing: undefined, ...inA })).toBe(true);
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
  interface Screen {
    seededFrom: ContactCard | undefined;
    seededAccount: string;
    formAccount: string;
    form: FormState;
    dirty: boolean;
  }
  const open = (existing: ContactCard | undefined, account = A): Screen => ({
    seededFrom: existing, seededAccount: account, formAccount: account,
    form: contactFormSeed(existing, undefined), dirty: false,
  });
  // `existing` is the shown account's card with the form's id.
  const render = (screen: Screen, existing: ContactCard | undefined, shownAccount = screen.formAccount): Screen =>
    shouldSeedContactForm({ ...screen, existing, shownAccount })
      ? { ...screen, seededFrom: existing, seededAccount: shownAccount, form: contactFormSeed(existing, undefined) }
      : screen;
  const canSave = (screen: Screen, existing: ContactCard | undefined, shownAccount = screen.formAccount) =>
    canSaveContactForm({ ...screen, isEdit: true, existing, shownAccount });
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
    expect(shouldSeedContactForm({ seededFrom: undefined, existing: card, dirty: true, ...inA })).toBe(true);
    expect(shouldSeedContactForm({ seededFrom: card, existing: card, dirty: false, ...inA })).toBe(false);
    expect(shouldSeedContactForm({ seededFrom: card, existing: undefined, dirty: false, ...inA })).toBe(false);
  });

  it('has no patch base for a new contact', () => {
    expect(contactFormPatchBase({ isEdit: false, seededFrom: card })).toBeUndefined();
  });

  describe('after an account switch (card ids repeat across accounts)', () => {
    const cardOfB = {
      ...card,
      name: { components: [{ kind: 'given', value: 'Bob' }] },
      emails: { e1: { address: 'bob@b.example' } },
    } as ContactCard;

    it("never re-seeds an open form from another account's card with the same id", () => {
      let screen = open(card);
      screen = render(screen, cardOfB, B);
      expect(screen.seededFrom).toBe(card);
      expect(screen.form.given).toBe('Ann');
    });

    it('a seed from account B never passes save for form account A', () => {
      const seededFromB: Screen = { ...open(cardOfB, B), formAccount: A };
      // Back on A, before the render that re-seeds: A's card has the seed's id.
      expect(canSave(seededFromB, card, A)).toBe(false);
      // While B is shown, A's form saves nothing at all.
      expect(canSave(open(card), cardOfB, B)).toBe(false);
      expect(canSave(open(card), card, B)).toBe(false);
    });

    it("re-seeds from the form account's own card once it is shown again", () => {
      const seededFromB: Screen = { ...open(cardOfB, B), formAccount: A, dirty: true };
      const screen = render(seededFromB, card, A);
      expect(screen.seededFrom).toBe(card);
      expect(screen.seededAccount).toBe(A);
      expect(canSave(screen, card, A)).toBe(true);
    });
  });
});

describe('contactFormMissingState', () => {
  const base = {
    formAccountShown: true, lookedUp: true, liveCards: false, online: true, connected: true, loadFailed: false,
  };

  it('says the card belongs to another account while that one is shown', () => {
    expect(contactFormMissingState({ ...base, formAccountShown: false, lookedUp: false })).toBe('switched');
  });

  it('waits for the lookup', () => {
    expect(contactFormMissingState({ ...base, lookedUp: false })).toBe('loading');
  });

  it('says the card is gone once live cards lack it', () => {
    expect(contactFormMissingState({ ...base, liveCards: true })).toBe('not_found');
  });

  it('asks for a connection when offline or not connected', () => {
    expect(contactFormMissingState({ ...base, online: false })).toBe('needs_connection');
    expect(contactFormMissingState({ ...base, connected: false, loadFailed: true })).toBe('needs_connection');
  });

  it("says the load failed, apart from needing a connection, when the server answered with an error", () => {
    expect(contactFormMissingState({ ...base, loadFailed: true })).toBe('load_failed');
  });
});
