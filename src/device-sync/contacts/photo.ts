/**
 * The contact photo: the card's first `media` entry of kind `photo`
 * (docs/device-sync.md, "Contacts mapping"). Rows get the full-size bytes
 * and DATA_SYNC2 the hash of what was applied; the shadow keeps the hash
 * instead of the bytes (`sha256:<hex>`), so a raw contact row stays small.
 */
import type { ContactMedia } from '../../api/types';
import { normalizeContactPhotoUri } from '../../lib/contact-utils';
import { sha256Hex } from '../../lib/sha256';
import { clone } from '../common/json';
import type { ContactCardWire, ContactsContext } from '../planner';

const HASH_URI = 'sha256:';

/**
 * The largest photo (base64 characters, about 512 KiB of JPEG) written to the
 * device: one applyBatch is one Binder transaction of at most 1 MB, and a
 * contact's rows travel in one op group, which is never split. A larger photo
 * stays on the server only (docs/device-sync.md, "Limits and performance").
 */
export const MAX_PHOTO_BASE64 = 700_000;
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX = new Map([...B64].map((c, i) => [c, i]));

/** Bytes of standard or URL-safe base64 (padding optional); null for anything else. */
export function base64ToBytes(b64: string): Uint8Array | null {
  const clean = b64.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  if (clean.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let value = 0;
  let o = 0;
  for (const ch of clean) {
    const v = B64_INDEX.get(ch);
    if (v === undefined) return null;
    value = (value << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (value >> bits) & 0xff;
    }
  }
  return out.subarray(0, o);
}

/** The base64 payload of a `data:…;base64,` URI (Stalwart may leave out the media type, #307). */
export function dataUriBase64(uri: string): string | null {
  const m = /^data:[^,]*;base64,(.*)$/is.exec(normalizeContactPhotoUri(uri.trim()));
  return m ? m[1].replace(/\s+/g, '') : null;
}

export function hashBase64(b64: string): string | null {
  const bytes = base64ToBytes(b64);
  return bytes ? `${HASH_URI}${sha256Hex(bytes)}` : null;
}

/** The photo entry the device shows: the first `kind: "photo"` entry in map order. */
export function photoEntry(card: ContactCardWire): { key: string; entry: ContactMedia } | null {
  const media = card.media;
  if (!media || typeof media !== 'object') return null;
  for (const [key, entry] of Object.entries(media)) {
    if (entry && typeof entry === 'object' && entry.kind === 'photo' && (entry.uri || (entry as { blobId?: unknown }).blobId)) {
      return { key, entry };
    }
  }
  return null;
}

/**
 * Bytes (base64) and hash of a photo entry; bytes are null for a shadow's
 * hash-only entry and for a photo too large to write (MAX_PHOTO_BASE64).
 */
export function photoPayload(entry: ContactMedia, ctx: Pick<ContactsContext, 'photoBytes'>): { b64: string | null; hash: string } | null {
  const uri = typeof entry.uri === 'string' ? entry.uri : '';
  if (uri.startsWith(HASH_URI)) return { b64: null, hash: uri };
  const b64 = dataUriBase64(uri) ?? ctx.photoBytes(entry as { uri?: string; blobId?: string; mediaType?: string });
  const hash = b64 ? hashBase64(b64) : null;
  if (!b64 || !hash) return null;
  return { b64: b64.length > MAX_PHOTO_BASE64 ? null : b64, hash };
}

/**
 * Set in a shadow whose card's photo has no row on the device because it
 * could not be written (too large, or its bytes could not be fetched), so the
 * missing row is no deletion. Device-only, like `~memberOf`: stripped before
 * any projection or patch.
 */
export const NO_PHOTO = '~noPhoto';

export function isPhotoAbsent(shadow: ContactCardWire | null): boolean {
  return shadow?.[NO_PHOTO] === true;
}

export function withPhotoAbsent(shadow: ContactCardWire, absent: boolean): ContactCardWire {
  return absent ? { ...shadow, [NO_PHOTO]: true } : shadow;
}

/** The shadow of a card: every `data:` photo URI replaced by the hash of its bytes. */
export function shadowOf(card: ContactCardWire): ContactCardWire {
  const out = clone(card);
  const media = out.media;
  if (media && typeof media === 'object') {
    for (const entry of Object.values(media)) {
      if (!entry || typeof entry.uri !== 'string') continue;
      const b64 = dataUriBase64(entry.uri);
      const hash = b64 ? hashBase64(b64) : null;
      if (hash) entry.uri = hash;
    }
  }
  return out;
}

export function isHashUri(uri: unknown): boolean {
  return typeof uri === 'string' && uri.startsWith(HASH_URI);
}

export function jpegDataUri(b64: string): string {
  return `data:image/jpeg;base64,${b64}`;
}
