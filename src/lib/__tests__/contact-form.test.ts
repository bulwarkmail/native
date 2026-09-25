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

  it('starts every form with the photo unchanged', () => {
    expect(blankForm().photo).toEqual({ kind: 'unchanged' });
    expect(contactToForm(CARDS[1][1], []).photo).toEqual({ kind: 'unchanged' });
  });
});
