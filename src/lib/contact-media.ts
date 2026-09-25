// Contact media that live as blobs, and writing a newly picked photo. Port
// of the webmail's lib/contact-media.ts.
//
// Stalwart 1.0 returns every embedded PHOTO, LOGO and SOUND as
// `{kind, blobId, mediaType}`; 0.16 returns data: URIs and refuses a blobId in
// `media` ("blobIds in media is not supported.").

import { getBlobsAsBase64, uploadBytes } from '../api/blob';
import { getContactsAccountId } from '../api/contacts';
import { jmapClient } from '../api/jmap-client';
import { JMAPMethodError, jmapErrorProperties } from '../api/jmap-result';
import { CAPABILITIES } from '../api/types';
import type { ContactCard, ContactMedia } from '../api/types';
import { findContactPhotoEntry } from './contact-utils';
import { bytesToBase64, dataUriToBytes } from './data-uri';

/** What the user did to the photo in the contact form. */
export type PhotoEdit =
  | { kind: 'unchanged' }
  | { kind: 'new'; uri: string; mediaType: string }
  | { kind: 'removed' };

/** Options for saving a card from the contact form. */
export interface ContactSaveOptions {
  /** Key of the `media` entry holding a photo the user just picked, as a data: URI. */
  photoKey?: string;
}

type BlobMedia = ContactMedia & { blobId: string };

function isBlobOnly(entry: ContactMedia | null | undefined): entry is BlobMedia {
  return !!entry?.blobId && !entry.uri;
}

export function hasBlobMedia(media: Record<string, ContactMedia> | null | undefined): boolean {
  return Object.values(media ?? {}).some(isBlobOnly);
}

/** The account a card's blobs live in: the owner's for a shared book. */
function mediaAccountId(contact: Pick<ContactCard, 'isShared' | 'accountId'>): string {
  return contact.isShared && contact.accountId ? contact.accountId : getContactsAccountId();
}

/** A `media` key for a new photo that no other entry uses. */
function freeMediaKey(media: Record<string, ContactMedia>): string {
  let key = 'photo';
  for (let n = 1; key in media; n++) key = `photo${n}`;
  return key;
}

/**
 * The `media` map to send for a photo edit, built on `base`: the card's media
 * as the server has it now when it could be read, else the form's copy
 * (`known`). `shownKey` is the photo the form showed.
 *
 * - A new photo takes the shown one's key and place, with its `pref`,
 *   `label` and `contexts`, so on a card with several photos it is still the
 *   one shown (the lowest pref wins).
 * - Removing the photo removes every photo the form's copy had, not only the
 *   shown one: the next would otherwise take its place after the save, while
 *   the form showed none. Logos and sounds stay; so do photos added elsewhere
 *   since.
 *
 * The other entries go back as the server returned them: a data: URI on 0.16,
 * a blobId on 1.0, which resolves it again. A map replaces every entry on the
 * server, and `null` (nothing left) deletes them all.
 */
export function mediaForPhotoEdit(
  base: Record<string, ContactMedia>,
  known: Record<string, ContactMedia>,
  shownKey: string | undefined,
  edit: Exclude<PhotoEdit, { kind: 'unchanged' }>,
): { media: Record<string, ContactMedia> | null; photoKey?: string } {
  if (edit.kind === 'removed') {
    const others = Object.fromEntries(Object.entries(base).filter(
      ([key, entry]) => !(entry?.kind === 'photo' && known[key]?.kind === 'photo'),
    ));
    return { media: Object.keys(others).length > 0 ? others : null };
  }
  const shown = shownKey ? (base[shownKey]?.kind === 'photo' ? base[shownKey] : known[shownKey]) : undefined;
  const photoKey = shownKey && (!base[shownKey] || base[shownKey]?.kind === 'photo') ? shownKey : freeMediaKey(base);
  const photo: ContactMedia = {
    kind: 'photo',
    uri: edit.uri,
    mediaType: edit.mediaType,
    ...(shown?.pref !== undefined ? { pref: shown.pref } : {}),
    ...(shown?.label !== undefined ? { label: shown.label } : {}),
    ...(shown?.contexts !== undefined ? { contexts: shown.contexts } : {}),
  };
  const media: Record<string, ContactMedia> = {};
  for (const [key, entry] of Object.entries(base)) media[key] = key === photoKey ? photo : entry;
  media[photoKey] = photo;
  return { media, photoKey };
}

/**
 * A new photo for a card on the server that neither the form nor a fresh read
 * knows the media of: a `media` map built from nothing would delete the
 * card's other entries - a logo, other photos - since a map replaces them all.
 */
export class ContactMediaUnreadError extends Error {
  constructor() {
    super("The contact's photos could not be read");
    this.name = 'ContactMediaUnreadError';
  }
}

/**
 * What the contact form saves in `media`, and the key of a newly picked
 * photo; null when `media` stays out of the save, which keeps every entry on
 * the server (an unchanged photo).
 *
 * `known` is the card's media as the form got it, `current` as the server has
 * it now (null when it couldn't be read, or for a new card). The contacts
 * cache is stored without media, so a card opened from it before a refresh
 * knows none: a new photo then replaces the photo the server has, and
 * removing one the form never showed changes nothing. When the server's copy
 * of such a card (`onServer`) couldn't be read either, a new photo throws
 * ContactMediaUnreadError instead of replacing every entry.
 */
export function mediaForFormSave(
  known: Record<string, ContactMedia> | undefined,
  current: Pick<ContactCard, 'media'> | null,
  edit: PhotoEdit,
  onServer = false,
): { media: Record<string, ContactMedia> | null; photoKey?: string } | null {
  if (edit.kind === 'unchanged') return null;
  if (edit.kind === 'new' && onServer && known === undefined && current === null) throw new ContactMediaUnreadError();
  const formCopy = edit.kind === 'new' ? known ?? current?.media ?? {} : known ?? {};
  const shownKey = findContactPhotoEntry({ media: formCopy })?.[0];
  if (edit.kind === 'removed' && !shownKey) return null;
  return mediaForPhotoEdit(current ? current.media ?? {} : formCopy, formCopy, shownKey, edit);
}

// Accounts (per server) whose ContactCard/set refused a blobId in media
// although the blob capability suggested it takes one.
const blobMediaRefused = new Set<string>();

function refusalKey(accountId: string): string {
  return `${jmapClient.serverUrl ?? ''}|${accountId}`;
}

/**
 * Whether ContactCard/set in the account takes a `media` entry that carries
 * a blobId. Stalwart 1.0 embeds contact media as blobs and lists ContactCard
 * among the blob capability's supportedTypeNames (RFC 9404); 0.16 lists only
 * Email, Thread and SieveScript, and refuses such an entry. A refusal seen at
 * runtime wins for the rest of the session.
 */
export function supportsContactBlobMedia(accountId: string): boolean {
  if (blobMediaRefused.has(refusalKey(accountId))) return false;
  const blob = jmapClient.getAccountCapability(CAPABILITIES.BLOB, accountId) as
    | { supportedTypeNames?: unknown }
    | undefined;
  return Array.isArray(blob?.supportedTypeNames) && blob.supportedTypeNames.includes('ContactCard');
}

/**
 * The server refused a blobId inside `media`: invalidProperties naming
 * `media` or an entry below it. 0.16 answers so ("blobIds in media is not
 * supported.", properties `["media"]`). 1.0's "The following blobIds do not
 * exist or are not accessible" names no property and is a different problem.
 */
export function isBlobMediaRejection(error: unknown): boolean {
  return error instanceof JMAPMethodError && error.type === 'invalidProperties'
    && jmapErrorProperties(error).some((p) => p === 'media' || p.startsWith('media/'));
}

/**
 * Saves a card whose `media[photoKey]` is a photo the user just picked, as a
 * data: URI, through `write` (a ContactCard/set create or update in
 * `accountId`, the contacts account when undefined).
 *
 * Where the account's cards carry blobs (supportsContactBlobMedia), the photo
 * is uploaded and sent as `{kind, blobId, mediaType}`. The upload goes into
 * the user's own account whichever account the card is written to: Stalwart
 * 1.0 resolves an uploaded blob only for members of the account it was
 * uploaded to, so one uploaded into the owner's account of a shared address
 * book would not resolve for a sharee, while the user's own always does.
 *
 * Otherwise, and when the upload fails, the data: URI goes out as it is. If
 * the server still refuses the blobId the way 0.16 does, the same write is
 * sent once more with the data: URI, and the account gets no more uploads for
 * the rest of the session.
 */
export async function writeContactWithNewPhoto<T>(
  accountId: string | undefined,
  card: Partial<ContactCard>,
  photoKey: string,
  write: (card: Partial<ContactCard>) => Promise<T>,
): Promise<T> {
  const photo = card.media?.[photoKey];
  const targetAccountId = accountId || getContactsAccountId();
  if (!photo?.uri || !supportsContactBlobMedia(targetAccountId)) return write(card);
  const decoded = dataUriToBytes(photo.uri, photo.mediaType);
  if (!decoded) return write(card);

  let blobId: string;
  try {
    ({ blobId } = await uploadBytes(decoded.bytes, decoded.type, getContactsAccountId()));
  } catch (err) {
    console.warn('[contacts] photo upload failed, saving it inline', err);
    return write(card);
  }

  const { uri: _uri, ...entry } = photo;
  const withBlob: ContactMedia = { ...entry, mediaType: photo.mediaType ?? decoded.type, blobId };
  try {
    return await write({ ...card, media: { ...card.media, [photoKey]: withBlob } });
  } catch (err) {
    if (!isBlobMediaRejection(err)) throw err;
    blobMediaRefused.add(refusalKey(targetAccountId));
    return write(card);
  }
}

/** `media` with each blob entry replaced by a data: URI from `uriOf`, or dropped/kept when it has none. */
async function withInlineBlobs(
  media: Record<string, ContactMedia>,
  uriOf: (entry: BlobMedia) => Promise<string | null>,
  onFailure: 'drop' | 'keep',
): Promise<Record<string, ContactMedia>> {
  const out: Record<string, ContactMedia> = {};
  // One entry at a time: a card has a few, and each may be a download.
  for (const [key, entry] of Object.entries(media)) {
    if (!entry?.blobId) {
      out[key] = entry;
      continue;
    }
    const { blobId: _blobId, ...rest } = entry;
    if (entry.uri) {
      out[key] = rest;
      continue;
    }
    const uri = await uriOf(entry as BlobMedia);
    if (uri) out[key] = { ...rest, uri };
    else if (onFailure === 'keep') out[key] = entry;
  }
  return out;
}

async function downloadAsDataUri(entry: BlobMedia, accountId: string): Promise<string | null> {
  try {
    const type = entry.mediaType || 'application/octet-stream';
    const buffer = await jmapClient.fetchBlobArrayBuffer(entry.blobId, entry.kind, type, accountId);
    return `data:${type};base64,${bytesToBase64(new Uint8Array(buffer))}`;
  } catch (err) {
    console.warn('[contacts] media download failed', err);
    return null;
  }
}

/**
 * `media` of `contact` with every blob entry turned into a data: URI of its
 * bytes, for a copy of the card written elsewhere (duplicate, move to another
 * account), which cannot count on the source card's blobId resolving. An
 * entry whose download fails is dropped, or with `onFailure: 'keep'` sent on
 * as it is.
 */
export async function inlineContactMedia(
  contact: Pick<ContactCard, 'media' | 'isShared' | 'accountId'>,
  onFailure: 'drop' | 'keep',
): Promise<Record<string, ContactMedia> | undefined> {
  const { media } = contact;
  if (!media || !hasBlobMedia(media)) return media ?? undefined;
  const accountId = mediaAccountId(contact);
  return withInlineBlobs(media, (entry) => downloadAsDataUri(entry, accountId), onFailure);
}

/**
 * The cards with their blob media turned into data: URIs, for a vCard export,
 * which carries the bytes themselves.
 *
 * The blobs of all cards of one account come through a few batched Blob/get
 * requests (getBlobsAsBase64): one download each would hit Stalwart's limit of
 * 1000 requests a minute on a large address book, and a 429 stops every other
 * request for a while. What the batch can't deliver (no blob capability, a
 * refused request) is downloaded one by one; a blob that can't be downloaded
 * at all is left out of the export. Never rejects.
 */
export async function inlineContactMediaForExport(contacts: ContactCard[]): Promise<ContactCard[]> {
  const byAccount = new Map<string, Map<string, BlobMedia>>();
  for (const contact of contacts) {
    if (!hasBlobMedia(contact.media)) continue;
    const accountId = mediaAccountId(contact);
    let entries = byAccount.get(accountId);
    if (!entries) {
      entries = new Map();
      byAccount.set(accountId, entries);
    }
    for (const entry of Object.values(contact.media ?? {})) {
      if (isBlobOnly(entry)) entries.set(entry.blobId, entry);
    }
  }

  const uris = new Map<string, string>();
  for (const [accountId, entries] of byAccount) {
    let oneByOne = [...entries.values()];
    const batch = await getBlobsAsBase64([...entries.keys()], accountId).catch((err: unknown) => {
      console.warn('[contacts] batched download of contact media failed', err);
      return null;
    });
    if (batch) {
      for (const [blobId, base64] of batch.data) {
        const entry = entries.get(blobId);
        if (entry) uris.set(`${accountId}|${blobId}`, `data:${entry.mediaType || 'application/octet-stream'};base64,${base64}`);
      }
      const failed = new Set(batch.failed);
      oneByOne = oneByOne.filter((entry) => failed.has(entry.blobId));
    }
    for (const entry of oneByOne) {
      const uri = await downloadAsDataUri(entry, accountId);
      if (uri) uris.set(`${accountId}|${entry.blobId}`, uri);
    }
  }

  const out: ContactCard[] = [];
  for (const contact of contacts) {
    if (!contact.media || !hasBlobMedia(contact.media)) {
      out.push(contact);
      continue;
    }
    const accountId = mediaAccountId(contact);
    const media = await withInlineBlobs(
      contact.media,
      async (entry) => uris.get(`${accountId}|${entry.blobId}`) ?? null,
      'drop',
    );
    out.push({ ...contact, media });
  }
  return out;
}

/** Forgets the accounts that refused blob media (tests). */
export function resetContactBlobMediaRefusals(): void {
  blobMediaRefused.clear();
}
