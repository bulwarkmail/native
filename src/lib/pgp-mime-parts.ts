// A PGP/MIME message (RFC 3156) is a multipart/encrypted with two parts: an
// application/pgp-encrypted version part and the encrypted payload, usually
// named encrypted.asc. The server lists both as attachments, so a decrypted
// message still showed "Attachment.pgp-encrypted" and "encrypted.asc" chips
// beside the decrypted body's own attachments. As in the webmail OpenPGP
// plugin (repos/plugins/bulwark-gpg/src/index.js onRenderEmailBody, which
// replaces the attachments with the decrypted ones), they are left out once
// the message is decrypted, and while it waits for a key to be unlocked (the
// banner offers Unlock). When it can't be decrypted at all they stay, so the
// payload can still be saved and opened elsewhere.

import type { BodyPart, Email } from '../api/types';
import type { SecureStatus } from './crypto/secure-message';

type PartLike = Pick<BodyPart, 'type'> & { partId?: string | null; blobId?: string | null; subParts?: PartLike[] };

/** An attachment as the server lists it (partId is there, though not in the type). */
export interface AttachmentRef {
  partId?: string | null;
  blobId?: string | null;
  type?: string | null;
}

const base = (type?: string | null) => (type || '').split(';')[0].trim().toLowerCase();

/** The attachments that are a PGP/MIME message's control parts, by blob id or part id. */
export function pgpMimeControlParts(
  email: Pick<Email, 'bodyStructure' | 'attachments'>,
): (att: AttachmentRef) => boolean {
  const ids = new Set<string>();
  const collect = (part: PartLike) => {
    if (part.partId) ids.add(`p:${part.partId}`);
    if (part.blobId) ids.add(`b:${part.blobId}`);
    part.subParts?.forEach(collect);
  };
  const walk = (part: PartLike | undefined) => {
    if (!part) return;
    if (base(part.type) === 'multipart/encrypted') {
      part.subParts?.forEach(collect);
      return;
    }
    part.subParts?.forEach(walk);
  };
  walk(email.bodyStructure as PartLike | undefined);
  if (ids.size > 0) {
    return (att) => (!!att.partId && ids.has(`p:${att.partId}`)) || (!!att.blobId && ids.has(`b:${att.blobId}`));
  }
  // Without the structure: the version part and the payload beside it.
  const all = email.attachments ?? [];
  if (!all.some((a) => base(a.type) === 'application/pgp-encrypted')) return () => false;
  return (att) => base(att.type) === 'application/pgp-encrypted' || base(att.type) === 'application/octet-stream';
}

/** Whether the reader leaves the control parts out: decrypted, being opened, or waiting for an unlock. */
export function hidesPgpMimeControlParts(secure: { loading: boolean; status: SecureStatus | null }): boolean {
  if (secure.loading) return true;
  const status = secure.status;
  if (!status || status.kind !== 'pgp' || !status.encrypted) return false;
  return status.decrypted || (status.lockedKeyIds?.length ?? 0) > 0;
}
