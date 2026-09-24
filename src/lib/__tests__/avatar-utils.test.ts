import { describe, it, expect } from 'vitest';
import { getContactPhotoForEmail, getContactPhotoIndex } from '../avatar-utils';
import type { ContactCard } from '../../api/types';

function card(id: string, emails: string[], photo?: string, mediaType?: string): ContactCard {
  return {
    id,
    addressBookIds: { ab1: true },
    emails: Object.fromEntries(emails.map((address, i) => [`e${i}`, { address }])),
    ...(photo ? { media: { m0: { kind: 'photo', uri: photo, ...(mediaType ? { mediaType } : {}) } } } : {}),
  };
}

describe('contact photo avatars (#54)', () => {
  it('finds the photo of the contact that holds the sender address, case-insensitively', () => {
    const contacts = [
      card('bob', ['bob@example.org']),
      card('alice', ['Alice.Nguyen@Example.com', 'alice@home.example'], 'data:image/png;base64,AAAA'),
    ];
    expect(getContactPhotoForEmail(contacts, 'alice.nguyen@example.com')).toBe('data:image/png;base64,AAAA');
    expect(getContactPhotoForEmail(contacts, ' ALICE@home.example ')).toBe('data:image/png;base64,AAAA');
    expect(getContactPhotoForEmail(contacts, 'bob@example.org')).toBeUndefined();
    expect(getContactPhotoForEmail(contacts, 'nobody@example.org')).toBeUndefined();
    expect(getContactPhotoForEmail(contacts, undefined)).toBeUndefined();
    expect(getContactPhotoForEmail(contacts, '')).toBeUndefined();
  });

  it('normalizes the malformed data URIs Stalwart emits (#307)', () => {
    const contacts = [card('a', ['a@x.org'], 'data:base64,AAAA', 'image/png')];
    expect(getContactPhotoForEmail(contacts, 'a@x.org')).toBe('data:image/png;base64,AAAA');
  });

  it('lets the first contact with a photo win when an address is on several cards', () => {
    const contacts = [
      card('no-photo', ['dup@x.org']),
      card('first', ['dup@x.org'], 'https://x.org/first.jpg'),
      card('second', ['dup@x.org'], 'https://x.org/second.jpg'),
    ];
    expect(getContactPhotoForEmail(contacts, 'dup@x.org')).toBe('https://x.org/first.jpg');
  });

  it('builds the index once per contacts array', () => {
    const contacts = [card('a', ['a@x.org'], 'https://x.org/a.jpg')];
    const index = getContactPhotoIndex(contacts);
    expect(getContactPhotoIndex(contacts)).toBe(index);

    // A store update hands out a new array, which gets a fresh index.
    const updated = [...contacts, card('b', ['b@x.org'], 'https://x.org/b.jpg')];
    const next = getContactPhotoIndex(updated);
    expect(next).not.toBe(index);
    expect(next.get('b@x.org')).toBe('https://x.org/b.jpg');
    expect(index.has('b@x.org')).toBe(false);
  });
});
