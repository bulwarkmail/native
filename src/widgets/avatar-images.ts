// Pictures for the widgets' avatars, in the webmail Avatar's order: the
// sender's contact photo, then the logo of the sender's domain (when "sender
// favicons" is on and the domain is not a personal mail provider), else the
// initials. A widget draws from the stored snapshot and cannot fetch while it
// draws (offline it would come out blank), so the pictures are fetched when
// the snapshot is built and kept in it as small data URIs.

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ContactCard } from '../api/types';
import { getContactPhotoForEmail, getFaviconDomain, getFaviconUrl } from '../lib/avatar-utils';
import type { AvatarImages } from './snapshot';

const CACHE_KEY = 'widgets:favicons:v1';
/** A logo is fetched again after a week, a domain without one after a day. */
const HIT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MISS_TTL_MS = 24 * 60 * 60 * 1000;
/** Pictures bigger than this stay out of the snapshot (it is read on every draw). */
const MAX_BYTES = 40 * 1024;
const MAX_DOMAINS = 24;
const FETCH_TIMEOUT_MS = 4000;

type FaviconCache = Record<string, { data: string | null; at: number }>;

async function loadCache(): Promise<FaviconCache> {
  try {
    const raw = await AsyncStorage.getItem(CACHE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? (parsed as FaviconCache) : {};
  } catch {
    return {};
  }
}

/** The image type of `bytes` when BitmapFactory can draw it, from its first bytes. */
export function imageType(bytes: Uint8Array): string | null {
  const b = (i: number) => bytes[i];
  if (bytes.length < 8) return null;
  if (b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47) return 'image/png';
  if (b(0) === 0x00 && b(1) === 0x00 && b(2) === 0x01 && b(3) === 0x00) return 'image/x-icon';
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return 'image/jpeg';
  if (b(0) === 0x47 && b(1) === 0x49 && b(2) === 0x46) return 'image/gif';
  if (b(0) === 0x52 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x46 && b(8) === 0x57) return 'image/webp';
  return null;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=';
    out += i + 2 < bytes.length ? B64[n & 63] : '=';
  }
  return out;
}

/** The domain's logo as a data URI; null when there is none; undefined when it could not be asked (offline). */
async function fetchFavicon(domain: string): Promise<string | null | undefined> {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = setTimeout(() => controller?.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(getFaviconUrl(domain), controller ? { signal: controller.signal } : undefined);
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    const type = imageType(bytes);
    if (!type || bytes.length > MAX_BYTES) return null;
    return `data:${type};base64,${toBase64(bytes)}`;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** Contact photos small enough to carry, embedded ones only (a hosted photo needs the account's credentials). */
function contactPhoto(contacts: readonly ContactCard[], email: string): string | null {
  const photo = getContactPhotoForEmail(contacts, email);
  const uri = photo && 'uri' in photo ? photo.uri : null;
  if (!uri || !uri.startsWith('data:image') || uri.length > (MAX_BYTES * 4) / 3 + 64) return null;
  return uri;
}

/**
 * Pictures for `emails`: contact photos by address, logos by domain. Logos
 * come from a cache of their own, fetched for at most a few domains a run.
 */
export async function resolveAvatarImages(
  emails: readonly string[],
  opts: { contacts: readonly ContactCard[]; favicons: boolean; now?: number },
): Promise<AvatarImages> {
  const now = opts.now ?? Date.now();
  const photos: Record<string, string> = {};
  const domains = new Set<string>();
  for (const raw of emails) {
    const email = raw.trim().toLowerCase();
    if (!email || photos[email]) continue;
    const photo = contactPhoto(opts.contacts, email);
    if (photo) {
      photos[email] = photo;
      continue;
    }
    const domain = opts.favicons ? getFaviconDomain(email) : null;
    if (domain) domains.add(domain);
  }

  const favicons: Record<string, string> = {};
  if (domains.size > 0) {
    const cache = await loadCache();
    let changed = false;
    const wanted = [...domains].slice(0, MAX_DOMAINS);
    const stale = wanted.filter((d) => {
      const hit = cache[d];
      return !hit || now - hit.at > (hit.data ? HIT_TTL_MS : MISS_TTL_MS);
    });
    for (let i = 0; i < stale.length; i += 4) {
      await Promise.all(stale.slice(i, i + 4).map(async (domain) => {
        const data = await fetchFavicon(domain);
        if (data === undefined) return; // offline: keep what we had
        cache[domain] = { data, at: now };
        changed = true;
      }));
    }
    for (const domain of wanted) {
      const data = cache[domain]?.data;
      if (data) favicons[domain] = data;
    }
    if (changed) {
      try {
        await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(cache));
      } catch {
        // the next refresh asks again
      }
    }
  }
  return { photos, favicons };
}

/** The picture for `email` in `images`, and whether it is a logo (drawn on white). */
export function avatarImageFor(
  images: AvatarImages | undefined,
  email: string | undefined,
): { src: string; logo: boolean } | null {
  if (!images || !email) return null;
  const key = email.trim().toLowerCase();
  const photo = images.photos[key];
  if (photo) return { src: photo, logo: false };
  const domain = getFaviconDomain(key);
  const logo = domain ? images.favicons[domain] : undefined;
  return logo ? { src: logo, logo: true } : null;
}
