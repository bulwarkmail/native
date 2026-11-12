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
  it('reads a "cell" phone as mobile and saves it as the RFC 9553 feature', () => {
    const card: ContactCard = { ...base, phones: { p1: { number: '+1000', features: { cell: true } } } };
    const form = contactToForm(card, []);
    expect(form.phones[0].feature).toBe('mobile');
    expect(formToPatch(form, card, false, [card]).phones).toEqual({ p1: { number: '+1000', features: { mobile: true } } });
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

  it('starts every form with the photo unchanged', () => {
    expect(blankForm().photo).toEqual({ kind: 'unchanged' });
    expect(contactToForm(CARDS[1][1], []).photo).toEqual({ kind: 'unchanged' });
  });
});

// A save changes only what the user edited: everything the form has no field
// for stays on the card (#108, as the webmail does since webmail #1515).
describe('contact form save keeps what the form does not show', () => {
  const rich: ContactCard = {
    id: 'm',
    uid: 'urn:uuid:5f0b',
    addressBookIds: { b: true },
    kind: 'individual',
    name: {
      components: [{ kind: 'given', value: 'Casey' }, { kind: 'surname', value: 'Preserve' }],
      isOrdered: true,
      full: 'Casey Preserve',
      sortAs: { surname: 'Preserve' },
    } as ContactCard['name'],
    nicknames: { k1: { name: 'Case', contexts: { private: true } } },
    emails: {
      home: { address: 'casey.home@example.org', contexts: { private: true }, label: 'Cottage', pref: 1 },
      work: { address: 'casey.work@example.org', contexts: { work: true }, label: 'Office', pref: 2 },
    },
    phones: {
      boat: { number: '+1 555 010 0101', features: { voice: true, mobile: true }, contexts: { private: true }, label: 'Boat', pref: 1 },
    },
    addresses: {
      a1: {
        components: [
          { kind: 'number', value: '12' }, { kind: 'name', value: 'Lake Road' }, { kind: 'apartment', value: 'Unit 4' },
          { kind: 'locality', value: 'Springfield' }, { kind: 'postcode', value: 'A1A 1A1' }, { kind: 'country', value: 'Canada' },
        ],
        isOrdered: true,
        defaultSeparator: ', ',
        countryCode: 'CA',
        contexts: { private: true },
      },
      po: { full: 'PO Box 9, Springfield' },
    },
    organizations: { o1: { name: 'Example Co', units: [{ name: 'Lending' }, { name: 'Branch 7' }] } },
    titles: { t1: { name: 'Manager', kind: 'title', organizationId: 'o1' } } as ContactCard['titles'],
    speakToAs: { pronouns: { k1: { pronouns: 'they/them', pref: 1 }, k2: { pronouns: 'she/her', pref: 2 } } } as ContactCard['speakToAs'],
    anniversaries: {
      an1: { kind: 'birth', date: { year: 1990, month: 4, day: 2 }, place: { full: 'Springfield' } },
    } as ContactCard['anniversaries'],
    onlineServices: { os1: { uri: 'https://example.org/@casey', service: 'Mastodon', user: 'casey', pref: 1 } },
    personalInfo: { pi1: { kind: 'hobby', value: 'Sailing', level: 'high', label: 'Summer' } } as ContactCard['personalInfo'],
    notes: { n1: { note: 'Met at the regatta.', created: '2026-01-02T03:04:05Z', author: { name: 'Sam' } } },
    keywords: { friends: true },
  };
  const edit = (change: (form: ReturnType<typeof contactToForm>) => void) => {
    const form = contactToForm(rich, []);
    change(form);
    return formToPatch(form, rich, false, [rich]);
  };

  it('sends nothing when nothing was edited', () => {
    expect(edit(() => {})).toEqual({});
  });

  it('sends only the note when the note was edited, with its date and author', () => {
    const patch = edit((form) => { form.notes[0] = { ...form.notes[0], note: 'Met at the regatta. Sails a Laser.' }; });
    expect(patch).toEqual({ notes: { n1: { ...rich.notes!.n1, note: 'Met at the regatta. Sails a Laser.' } } });
  });

  it('builds an edited email on the stored one and leaves the other alone', () => {
    const patch = edit((form) => { form.emails[1] = { ...form.emails[1], address: 'casey.new@example.org' }; });
    expect(patch).toEqual({
      emails: { home: rich.emails!.home, work: { ...rich.emails!.work, address: 'casey.new@example.org' } },
    });
  });

  it('replaces the contexts only when another one is picked', () => {
    const patch = edit((form) => { form.emails[0] = { ...form.emails[0], context: 'work' }; });
    expect(patch.emails!.home).toEqual({ ...rich.emails!.home, contexts: { work: true } });
  });

  it('keeps a phone\'s features and label when only its number changes', () => {
    const patch = edit((form) => { form.phones[0] = { ...form.phones[0], number: '+1 555 010 0199' }; });
    expect(patch).toEqual({ phones: { boat: { ...rich.phones!.boat, number: '+1 555 010 0199' } } });
  });

  it('replaces a phone\'s features and drops its label when another type is picked', () => {
    const patch = edit((form) => { form.phones[0] = { ...form.phones[0], feature: 'fax' }; });
    expect(patch.phones).toEqual({
      boat: { number: '+1 555 010 0101', features: { fax: true }, contexts: { private: true }, pref: 1 },
    });
  });

  it('changes one part of an address and keeps the parts the form does not show', () => {
    const patch = edit((form) => { form.addresses[0] = { ...form.addresses[0], locality: 'Shelbyville', region: 'ON' }; });
    expect(patch).toEqual({
      addresses: {
        a1: {
          ...rich.addresses!.a1,
          components: [
            { kind: 'number', value: '12' }, { kind: 'name', value: 'Lake Road' }, { kind: 'apartment', value: 'Unit 4' },
            { kind: 'locality', value: 'Shelbyville' }, { kind: 'region', value: 'ON' },
            { kind: 'postcode', value: 'A1A 1A1' }, { kind: 'country', value: 'Canada' },
          ],
        },
        po: rich.addresses!.po,
      },
    });
  });

  it('drops the country code when the country changes, and rewrites an edited street', () => {
    const patch = edit((form) => { form.addresses[0] = { ...form.addresses[0], street: '3 Hill Lane', country: 'Ireland' }; });
    const saved = patch.addresses!.a1;
    expect(saved.countryCode).toBeUndefined();
    expect(saved.components).toEqual([
      { kind: 'name', value: '3 Hill Lane' }, { kind: 'apartment', value: 'Unit 4' },
      { kind: 'locality', value: 'Springfield' }, { kind: 'postcode', value: 'A1A 1A1' }, { kind: 'country', value: 'Ireland' },
    ]);
  });

  it('keeps further units and the title\'s link when the organization is renamed', () => {
    const patch = edit((form) => { form.orgs[0] = { ...form.orgs[0], name: 'Example Inc' }; });
    expect(patch).toEqual({ organizations: { o1: { ...rich.organizations!.o1, name: 'Example Inc' } } });
  });

  it('builds an edited title on the stored one', () => {
    const patch = edit((form) => { form.orgs[0] = { ...form.orgs[0], jobTitle: 'Director' }; });
    expect(patch).toEqual({ titles: { t1: { name: 'Director', kind: 'title', organizationId: 'o1' } } });
  });

  it('unlinks a title whose organization was removed', () => {
    const patch = edit((form) => { form.orgs[0] = { ...form.orgs[0], name: '', department: '' }; });
    expect(patch).toEqual({ organizations: null, titles: { t1: { name: 'Manager', kind: 'title' } } });
  });

  it('edits the first pronouns and keeps the others', () => {
    const patch = edit((form) => { form.pronouns = 'he/him'; });
    expect(patch).toEqual({
      speakToAs: { pronouns: { k1: { pronouns: 'he/him', pref: 1 }, k2: { pronouns: 'she/her', pref: 2 } } },
    });
  });

  it('keeps the hidden properties of an edited nickname, online service, interest and anniversary', () => {
    const patch = edit((form) => {
      form.nicknames[0] = { ...form.nicknames[0], name: 'Cas' };
      form.online[0] = { ...form.online[0], uri: 'https://example.org/@cas' };
      form.personalInfo[0] = { ...form.personalInfo[0], value: 'Rowing' };
      form.anniversaries[0] = { ...form.anniversaries[0], date: '1991-04-02' };
    });
    expect(patch).toEqual({
      nicknames: { k1: { name: 'Cas', contexts: { private: true } } },
      onlineServices: { os1: { ...rich.onlineServices!.os1, uri: 'https://example.org/@cas' } },
      personalInfo: { pi1: { ...rich.personalInfo!.pi1, value: 'Rowing' } },
      anniversaries: { an1: { ...rich.anniversaries!.an1, date: { year: 1991, month: 4, day: 2 } } },
    });
  });

  it('gives a new row a key no stored entry uses, and drops a removed row', () => {
    const patch = edit((form) => {
      form.emails = [form.emails[1], { address: 'third@example.org', context: '' }];
    });
    expect(patch).toEqual({ emails: { work: rich.emails!.work, e1: { address: 'third@example.org' } } });
  });

  it('clears a collection the user emptied', () => {
    expect(edit((form) => { form.phones = []; })).toEqual({ phones: null });
  });

  it('rebuilds the name when it is edited', () => {
    const patch = edit((form) => { form.given = 'Kasey'; });
    expect(patch).toEqual({
      name: {
        components: [{ kind: 'given', value: 'Kasey' }, { kind: 'surname', value: 'Preserve' }],
        isOrdered: true,
        full: 'Kasey Preserve',
      },
    });
  });

  it('clears every pronouns entry when the field is emptied', () => {
    expect(edit((form) => { form.pronouns = ''; })).toEqual({ speakToAs: null });
  });

  it('keeps an address\'s text copy when only its context changes', () => {
    const patch = edit((form) => { form.addresses[1] = { ...form.addresses[1], context: 'work' }; });
    expect(patch).toEqual({
      addresses: { a1: rich.addresses!.a1, po: { full: 'PO Box 9, Springfield', contexts: { work: true } } },
    });
  });

  it('leaves one separator where an address part was removed', () => {
    const card: ContactCard = {
      ...rich,
      addresses: {
        a1: {
          components: [
            { kind: 'number', value: '12' }, { kind: 'separator', value: ' ' }, { kind: 'name', value: 'Lake Road' },
            { kind: 'separator', value: ', ' }, { kind: 'locality', value: 'Springfield' },
            { kind: 'separator', value: ', ' }, { kind: 'country', value: 'Canada' },
          ],
          isOrdered: true,
        },
      },
    };
    const form = contactToForm(card, []);
    form.addresses[0] = { ...form.addresses[0], street: '3 Hill Lane', country: '' };
    expect(formToPatch(form, card, false, [card]).addresses!.a1.components).toEqual([
      { kind: 'name', value: '3 Hill Lane' }, { kind: 'separator', value: ', ' }, { kind: 'locality', value: 'Springfield' },
    ]);
  });

  it('never gives a new organization a removed one\'s key, which a title may point at', () => {
    const card: ContactCard = {
      ...rich,
      organizations: { o1: { name: 'A' }, o2: { name: 'B' } },
      titles: { t1: { name: 'CTO', kind: 'title', organizationId: 'o2' } } as ContactCard['titles'],
    };
    const form = contactToForm(card, []);
    form.orgs = [form.orgs[0], { name: 'C', department: '', jobTitle: '', role: '' }];
    expect(formToPatch(form, card, false, [card])).toEqual({
      organizations: { o1: { name: 'A' }, o3: { name: 'C' } },
      titles: { t1: { name: 'CTO', kind: 'title' } },
    });
  });

  it('sends the calendar and free/busy links together, or neither', () => {
    const card: ContactCard = { ...rich, calendarUri: 'https://example.org/cal', freeBusyUri: 'https://example.org/fb' };
    const save = (change: (form: ReturnType<typeof contactToForm>) => void) => {
      const form = contactToForm(card, []);
      change(form);
      return formToPatch(form, card, false, [card]);
    };
    expect(save(() => {})).toEqual({});
    expect(save((form) => { form.freeBusyUri = 'https://example.org/fb2'; }))
      .toEqual({ calendarUri: 'https://example.org/cal', freeBusyUri: 'https://example.org/fb2' });
    expect(save((form) => { form.calendarUri = ''; }))
      .toEqual({ calendarUri: null, freeBusyUri: 'https://example.org/fb' });
  });

  it('compares rows with the form as it was filled, not with a card refreshed since', () => {
    const filled = contactToForm(rich, []);
    const form = contactToForm(rich, []);
    form.emails[1] = { ...form.emails[1], address: 'casey.new@example.org' };
    // Meanwhile another client relabelled the home email.
    const refreshed: ContactCard = {
      ...rich,
      emails: { ...rich.emails!, home: { ...rich.emails!.home, label: 'Lake house' } },
    };
    expect(formToPatch(form, refreshed, false, [refreshed], filled)).toEqual({
      emails: { home: refreshed.emails!.home, work: { ...rich.emails!.work, address: 'casey.new@example.org' } },
    });
  });

  it('numbers a new contact\'s entries from 1', () => {
    const form = blankForm();
    form.given = 'New';
    form.emails = [{ address: 'new@example.org', context: 'work' }];
    form.nicknames = [{ name: 'Newbie' }];
    const patch = formToPatch(form, undefined, false, []);
    expect(patch.emails).toEqual({ e1: { address: 'new@example.org', contexts: { work: true } } });
    expect(patch.nicknames).toEqual({ n1: { name: 'Newbie' } });
  });
});
