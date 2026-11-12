import { describe, it, expect } from 'vitest';
import { blankForm, contactToForm, formToPatch } from '../contact-form';
import { mediaForFormSave } from '../contact-media';
import type { ContactCard } from '../../api/types';

const JPEG_URI = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
const PNG_URI = 'data:image/png;base64,iVBORw0KGgo=';

// The same card as ContactCard/get returns it (live-checked): 0.16.23 keeps
// the data: URIs it was saved with, 1.0 returns each entry as a blob.
const base: ContactCard = {
  id: 'm',
  uid: 'urn:uuid:5f0b',
  addressBookIds: { b: true },
  name: { components: [{ kind: 'given', value: 'Carol' }, { kind: 'surname', value: 'Jones' }], isOrdered: true, full: 'Carol Jones' },
  phones: { p1: { number: '+1000' } },
};
const CARDS: Array<[string, ContactCard]> = [
  ['0.16', {
    ...base,
    media: {
      photo: { uri: JPEG_URI, kind: 'photo', mediaType: 'image/jpeg' },
      logo: { uri: PNG_URI, kind: 'logo', mediaType: 'image/png' },
    },
  }],
  ['1.0', {
    ...base,
    media: {
      photo: { blobId: 'iavlkor1rcdskxqjivvejt930lsiajj9ck1ejx02jimk31fltxo3qbilbq', kind: 'photo', mediaType: 'image/jpeg' },
      logo: { blobId: 'icnkwsrhxxr97hhh2kzjw9qbv97pji70mbf92wjmbrtkr2hnkcchybilbq', kind: 'logo', mediaType: 'image/png' },
    },
  }],
];

describe('contact form save', () => {
  // RFC 9553 has "mobile"; "cell" is what older versions of the form wrote.
  it('reads a "cell" phone as mobile and leaves it as stored while untouched', () => {
    const card: ContactCard = { ...base, phones: { p1: { number: '+1000', features: { cell: true } } } };
    const form = contactToForm(card, []);
    expect(form.phones[0].feature).toBe('mobile');
    form.phones = [...form.phones, { number: '+2000', context: '', feature: 'mobile' }];
    expect(formToPatch(form, card, false, [card]).phones).toEqual({
      p1: { number: '+1000', features: { cell: true } },
      p2: { number: '+2000', features: { mobile: true } },
    });
  });

  it.each(CARDS)('a phone-only edit leaves the photo alone on Stalwart %s', (_version, card) => {
    const form = contactToForm(card, []);
    form.phones = [{ number: '+2000', context: '', feature: '' }];

    const patch = formToPatch(form, card, false, [card]);

    expect(patch.phones).toEqual({ p1: { number: '+2000' } });
    // Absent, not null: an update without `media` keeps every entry, where
    // the old form sent the map without the photo, or `media: null`.
    expect('media' in patch).toBe(false);
    expect(mediaForFormSave(card.media, null, form.photo)).toBeNull();
  });

  it.each(CARDS)('a new photo replaces the old one and keeps the logo on Stalwart %s', (_version, card) => {
    const form = contactToForm(card, []);
    form.photo = { kind: 'new', uri: PNG_URI, mediaType: 'image/png' };

    const edit = mediaForFormSave(card.media, { media: card.media }, form.photo);

    expect(edit?.photoKey).toBe('photo');
    expect(edit?.media).toEqual({
      photo: { kind: 'photo', uri: PNG_URI, mediaType: 'image/png' },
      logo: card.media!.logo,
    });
  });

  it.each(CARDS)('removing the photo keeps the logo on Stalwart %s', (_version, card) => {
    const form = contactToForm(card, []);
    form.photo = { kind: 'removed' };
    expect(mediaForFormSave(card.media, { media: card.media }, form.photo)).toEqual({ media: { logo: card.media!.logo } });
  });

  it('removing the only photo deletes the media', () => {
    const card: ContactCard = { ...base, media: { photo: { blobId: 'b', kind: 'photo' } } };
    expect(mediaForFormSave(card.media, { media: card.media }, { kind: 'removed' })).toEqual({ media: null });
  });

  it('a new contact gets its photo under "photo"', () => {
    const form = blankForm();
    form.given = 'Dan';
    form.photo = { kind: 'new', uri: JPEG_URI, mediaType: 'image/jpeg' };
    expect('media' in formToPatch(form, undefined, false, [])).toBe(false);
    expect(mediaForFormSave(undefined, null, form.photo)).toEqual({
      media: { photo: { kind: 'photo', uri: JPEG_URI, mediaType: 'image/jpeg' } },
      photoKey: 'photo',
    });
  });

  // #1515: a save rebuilt every list under new keys with only the form's fields.
  const rich: ContactCard = {
    ...base,
    emails: {
      home: { address: 'carol@example.org', contexts: { private: true, x: true }, label: 'Personal', pref: 1 },
    },
    phones: {
      car: { number: '+49 30 1', contexts: { car: true }, features: { voice: true } },
      ab: { number: '+49 30 2', label: 'Boat', features: { voice: true, text: true }, pref: 1 },
      w: { number: '+49 30 3', contexts: { work: true, private: true }, features: { mobile: true, video: true } },
    },
    addresses: {
      office: {
        components: [
          { kind: 'name', value: 'Hauptstraße' }, { kind: 'separator', value: ' ' }, { kind: 'number', value: '1' },
          { kind: 'apartment', value: '3. OG' },
          { kind: 'postcode', value: '10115' }, { kind: 'separator', value: ' ' }, { kind: 'locality', value: 'Berlin' },
          { kind: 'district', value: 'Mitte' },
          { kind: 'country', value: 'Germany' },
        ],
        isOrdered: true,
        defaultSeparator: '\n',
        countryCode: 'DE',
        contexts: { work: true },
        pref: 2,
        timeZone: 'Europe/Berlin',
      },
    },
    notes: { nt: { note: 'Met at FOSDEM', created: '2025-02-01T10:00:00Z' } },
  };

  it('leaves every untouched entry out when only the name changes', () => {
    const form = contactToForm(rich, []);
    form.given = 'Caroline';

    const patch = formToPatch(form, rich, false, [rich]);

    expect(patch.name?.components).toContainEqual({ kind: 'given', value: 'Caroline' });
    for (const key of ['emails', 'phones', 'addresses', 'notes', 'nicknames', 'organizations', 'titles']) {
      expect(key in patch).toBe(false);
    }
  });

  it('sends an untouched entry back as the card had it, under its key', () => {
    const form = contactToForm(rich, []);
    form.phones = [...form.phones, { number: '+1 555', context: '', feature: 'mobile' }];

    const patch = formToPatch(form, rich, false, [rich]);

    expect(patch.phones).toEqual({ ...rich.phones, p1: { number: '+1 555', features: { mobile: true } } });
  });

  it('shows a custom phone context and its label, and keeps them', () => {
    const form = contactToForm(rich, []);
    expect(form.phones.map((p) => [p.context, p.feature])).toEqual([['car', 'voice'], ['', '#label'], ['work', 'mobile']]);
  });

  it('builds an edited entry on the card entry, so what the form does not show stays', () => {
    const form = contactToForm(rich, []);
    form.phones[1] = { ...form.phones[1], number: '+49 30 22' };
    form.emails[0] = { ...form.emails[0], address: 'caroline@example.org' };

    const patch = formToPatch(form, rich, false, [rich]);

    expect(patch.phones!.ab).toEqual({ number: '+49 30 22', label: 'Boat', features: { voice: true, text: true }, pref: 1 });
    expect(patch.emails).toEqual({
      home: { address: 'caroline@example.org', contexts: { private: true, x: true }, label: 'Personal', pref: 1 },
    });
  });

  it('picking another phone type replaces the features and drops the label', () => {
    const form = contactToForm(rich, []);
    form.phones[1] = { ...form.phones[1], feature: 'fax' };
    expect(formToPatch(form, rich, false, [rich]).phones!.ab).toEqual({ number: '+49 30 2', features: { fax: true }, pref: 1 });
  });

  it('an edited address keeps the parts and properties the form does not show', () => {
    const form = contactToForm(rich, []);
    form.addresses[0] = { ...form.addresses[0], locality: 'Potsdam' };

    const office = formToPatch(form, rich, false, [rich]).addresses!.office;

    expect(office.components).toEqual([
      { kind: 'name', value: 'Hauptstraße' }, { kind: 'separator', value: ' ' }, { kind: 'number', value: '1' },
      { kind: 'apartment', value: '3. OG' },
      { kind: 'postcode', value: '10115' }, { kind: 'separator', value: ' ' }, { kind: 'locality', value: 'Potsdam' },
      { kind: 'district', value: 'Mitte' },
      { kind: 'country', value: 'Germany' },
    ]);
    expect(office).toMatchObject({ defaultSeparator: '\n', countryCode: 'DE', contexts: { work: true }, pref: 2, timeZone: 'Europe/Berlin' });
  });

  it('removing an entry still clears it and keeps the others as stored', () => {
    const form = contactToForm(rich, []);
    form.phones = form.phones.filter((p) => p.key !== 'car');
    expect(formToPatch(form, rich, false, [rich]).phones).toEqual({ ab: rich.phones!.ab, w: rich.phones!.w });
    form.phones = [];
    expect(formToPatch(form, rich, false, [rich]).phones).toBeNull();
  });

  it('starts every form with the photo unchanged', () => {
    expect(blankForm().photo).toEqual({ kind: 'unchanged' });
    expect(contactToForm(CARDS[1][1], []).photo).toEqual({ kind: 'unchanged' });
  });
});
