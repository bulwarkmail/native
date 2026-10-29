import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ContactCard } from '../../api/types';
import { avatarImageFor, imageType, resolveAvatarImages, toBase64 } from '../avatar-images';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const ICO = new Uint8Array([0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x10, 0x10, 0, 0]);
const PHOTO = 'data:image/jpeg;base64,/9j/AAAA';

function card(email: string, uri: string): ContactCard {
  return {
    id: email,
    emails: { e1: { address: email } },
    media: { m1: { kind: 'photo', uri } },
  } as unknown as ContactCard;
}

function answer(bytes: Uint8Array | null, ok = true) {
  return {
    ok,
    arrayBuffer: async () => (bytes ?? new Uint8Array()).buffer,
  };
}

const fetchMock = vi.fn();

beforeEach(async () => {
  await AsyncStorage.clear();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('imageType', () => {
  it('names the types BitmapFactory draws', () => {
    expect(imageType(PNG)).toBe('image/png');
    expect(imageType(ICO)).toBe('image/x-icon');
    expect(imageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]))).toBe('image/jpeg');
    expect(imageType(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0]))).toBe('image/gif');
    expect(imageType(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))).toBe('image/webp');
  });

  it('refuses SVG, HTML and short answers', () => {
    expect(imageType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(imageType(new TextEncoder().encode('<!doctype html><html>'))).toBeNull();
    expect(imageType(new Uint8Array([0x89, 0x50]))).toBeNull();
  });
});

describe('toBase64', () => {
  it('matches the standard encoding with padding', () => {
    for (const text of ['', 'f', 'fo', 'foo', 'foob', 'fooba', 'foobar']) {
      expect(toBase64(new TextEncoder().encode(text))).toBe(Buffer.from(text).toString('base64'));
    }
    const all = new Uint8Array(256).map((_, i) => i);
    expect(toBase64(all)).toBe(Buffer.from(all).toString('base64'));
  });
});

describe('resolveAvatarImages', () => {
  it('prefers a contact photo and does not fetch a logo for that sender', async () => {
    const images = await resolveAvatarImages(['Ann@Example.com'], {
      contacts: [card('ann@example.com', PHOTO)],
      favicons: true,
    });
    expect(images.photos['ann@example.com']).toBe(PHOTO);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(avatarImageFor(images, 'ann@example.com')).toEqual({ src: PHOTO, logo: false });
  });

  it('leaves out hosted contact photos (they need the account to load)', async () => {
    fetchMock.mockResolvedValue(answer(null, false));
    const images = await resolveAvatarImages(['ann@example.com'], {
      contacts: [card('ann@example.com', 'https://mail.example.com/jmap/download/x')],
      favicons: true,
    });
    expect(images.photos).toEqual({});
  });

  it('fetches a logo per business domain, not for personal providers', async () => {
    fetchMock.mockResolvedValue(answer(PNG));
    const images = await resolveAvatarImages(['news@shop.acme.io', 'bob@gmail.com', 'eve@acme.io'], {
      contacts: [],
      favicons: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain('acme.io');
    const logo = avatarImageFor(images, 'eve@acme.io');
    expect(logo).toEqual({ src: `data:image/png;base64,${toBase64(PNG)}`, logo: true });
    expect(avatarImageFor(images, 'bob@gmail.com')).toBeNull();
  });

  it('fetches no logos when sender favicons are off', async () => {
    const images = await resolveAvatarImages(['eve@acme.io'], { contacts: [], favicons: false });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(images.favicons).toEqual({});
  });

  it('keeps logos that are not images or too big out', async () => {
    fetchMock
      .mockResolvedValueOnce(answer(new TextEncoder().encode('<!doctype html><html></html>')))
      .mockResolvedValueOnce(answer(new Uint8Array(50 * 1024).fill(0).map((v, i) => (i < 8 ? PNG[i] : v))));
    const images = await resolveAvatarImages(['a@one.dev', 'b@two.dev'], { contacts: [], favicons: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(images.favicons).toEqual({});
  });

  it('asks a domain again only after its cache time', async () => {
    fetchMock.mockResolvedValue(answer(ICO));
    const now = Date.UTC(2026, 9, 1);
    await resolveAvatarImages(['eve@acme.io'], { contacts: [], favicons: true, now });
    await resolveAvatarImages(['eve@acme.io'], { contacts: [], favicons: true, now: now + 6 * 86400000 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await resolveAvatarImages(['eve@acme.io'], { contacts: [], favicons: true, now: now + 8 * 86400000 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps the cached logo when offline', async () => {
    const now = Date.UTC(2026, 9, 1);
    fetchMock.mockResolvedValueOnce(answer(PNG));
    await resolveAvatarImages(['eve@acme.io'], { contacts: [], favicons: true, now });
    fetchMock.mockRejectedValueOnce(new TypeError('Network request failed'));
    const later = await resolveAvatarImages(['eve@acme.io'], { contacts: [], favicons: true, now: now + 30 * 86400000 });
    expect(avatarImageFor(later, 'eve@acme.io')?.logo).toBe(true);
  });

  it('remembers a domain without a logo for a day', async () => {
    const now = Date.UTC(2026, 9, 1);
    fetchMock.mockResolvedValue(answer(null, false));
    await resolveAvatarImages(['eve@acme.io'], { contacts: [], favicons: true, now });
    await resolveAvatarImages(['eve@acme.io'], { contacts: [], favicons: true, now: now + 3600000 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await resolveAvatarImages(['eve@acme.io'], { contacts: [], favicons: true, now: now + 2 * 86400000 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('avatarImageFor', () => {
  it('has nothing without pictures or an address', () => {
    expect(avatarImageFor(undefined, 'eve@acme.io')).toBeNull();
    expect(avatarImageFor({ photos: {}, favicons: {} }, undefined)).toBeNull();
  });
});
