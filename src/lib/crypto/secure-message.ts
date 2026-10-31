// Reading PGP and S/MIME mail (#58): detect, decrypt, verify, and hand the
// reader a body and a status for the banner. Port of the plugins' render
// hooks: onRenderEmailBody in repos/plugins/bulwark-gpg/src/index.js and
// repos/plugins/smime/src/index.js. The raw message comes from the JMAP blob
// download of the email's blobId (the plugins' host.jmap.fetchBlob).

import type * as OpenPgp from 'openpgp';
import type { BodyPart, Email } from '../../api/types';
import { binaryToBytes, bytesToBinary, decodeBody, findNode, parseEntity, type MimeNode } from './mime';
import {
  detectPgp, decryptMessage, verifyDetached, verifyCleartext, encryptionKeyIds, keyHasId, canonicalSignedBytes,
  extractPublicKeyBlock, PgpArgon2UnsupportedError, type PgpSignatureSummary,
} from './pgp';
import type { SmimeKeyMaterial, SmimeSignatureStatus } from './smime/cms';

export type SecureKind = 'pgp' | 'smime';
export type SignatureState = 'none' | 'valid' | 'invalid' | 'unknown';

export interface SecureStatus {
  kind: SecureKind;
  encrypted: boolean;
  decrypted: boolean;
  /** Encrypted to a key of ours that is locked: ids of the keys to unlock. */
  lockedKeyIds?: string[];
  signature: SignatureState;
  signerEmail?: string;
  /** The signer's address differs from From. */
  signerMismatch?: boolean;
  /** S/MIME: self-signed signer certificate (not checked against a CA). */
  selfSigned?: boolean;
  /** Why the signature is invalid, or why decryption failed. */
  error?: string;
  /** Encrypted with an algorithm the app can't read (named). */
  unsupportedAlgorithm?: string;
  /** No key of ours can decrypt it. */
  noKey?: boolean;
}

export interface SecureAttachment {
  name: string;
  type: string;
  size: number;
  bytes: Uint8Array;
}

export interface SecureResult {
  status: SecureStatus;
  /** The decrypted/verified body, or null when there is none to show (locked, failed). */
  body: { html: string | null; text: string | null } | null;
  attachments: SecureAttachment[];
}

/** What the reader needs from the key store; injected so tests need no SecureStore. */
export interface SecureKeyAccess {
  /** Unlocked private PGP keys. */
  pgpDecryptionKeys(): OpenPgp.PrivateKey[];
  /** Own PGP keys (unlocked or not): id + armored public key. */
  pgpOwnKeys(): Array<{ id: string; publicKeyArmored: string; unlocked: boolean }>;
  /** Every known PGP public key, to verify signatures. */
  pgpPublicKeys(): string[];
  /** Own S/MIME keys; `pkcs8` set when unlocked. */
  smimeKeys(): SmimeKeyMaterial[];
  rememberPgpKey?(armored: string): Promise<void>;
  rememberCertificate?(der: Uint8Array): Promise<void>;
}

type PartLike = Pick<BodyPart, 'type'> & { subParts?: PartLike[] };

/**
 * Cheap check on the email object (no download): could this be PGP or
 * S/MIME? multipart/encrypted, multipart/signed with a pgp/pkcs7 signature,
 * pkcs7-mime parts, or inline armor in the preview or text body.
 */
export function secureKindHint(email: Pick<Email, 'bodyStructure' | 'attachments' | 'preview' | 'textBody' | 'bodyValues'>): SecureKind | null {
  const types: string[] = [];
  const collect = (part: PartLike | undefined) => {
    if (!part) return;
    if (part.type) types.push(part.type.toLowerCase());
    part.subParts?.forEach(collect);
  };
  collect(email.bodyStructure as PartLike | undefined);
  (email.attachments ?? []).forEach((a) => types.push((a.type || '').toLowerCase()));
  if (types.some((t) => t.includes('pkcs7-mime') || t.includes('pkcs7-signature'))) return 'smime';
  if (types.some((t) => t === 'multipart/encrypted' || t === 'application/pgp-encrypted' || t === 'application/pgp-signature')) return 'pgp';
  const text = [
    email.preview ?? '',
    ...((email.textBody ?? []).map((p) => (p.partId ? email.bodyValues?.[p.partId]?.value ?? '' : ''))),
  ].join('\n');
  if (/-----BEGIN PGP (MESSAGE|SIGNED MESSAGE)-----/.test(text)) return 'pgp';
  return null;
}

/** A decrypted payload: a MIME entity, or (inline PGP) plain text. */
async function renderPayload(bytes: Uint8Array): Promise<{ body: SecureResult['body']; attachments: SecureAttachment[] }> {
  const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 512));
  const looksLikeMime = /^(?:[A-Za-z][A-Za-z0-9-]*:[^\r\n]*\r?\n(?:[ \t][^\r\n]*\r?\n)*)+\r?\n/.test(head) || /^content-type:/i.test(head);
  if (!looksLikeMime) {
    return { body: { html: null, text: new TextDecoder('utf-8', { fatal: false }).decode(bytes) }, attachments: [] };
  }
  const { default: PostalMime } = await import('postal-mime');
  const parsed = await PostalMime.parse(bytes, { attachmentEncoding: 'arraybuffer' });
  let html = parsed.html ?? null;
  const attachments: SecureAttachment[] = [];
  for (const att of parsed.attachments ?? []) {
    const data = typeof att.content === 'string' ? new TextEncoder().encode(att.content) : new Uint8Array(att.content as ArrayBuffer);
    const cid = att.contentId?.replace(/^<|>$/g, '');
    if (cid && html && html.includes(`cid:${cid}`)) {
      html = html.split(`cid:${cid}`).join(`data:${att.mimeType || 'application/octet-stream'};base64,${btoa(bytesToBinary(data))}`);
      if (att.disposition === 'inline') continue;
    }
    attachments.push({ name: att.filename || 'attachment', type: att.mimeType || 'application/octet-stream', size: data.byteLength, bytes: data });
  }
  let text = parsed.text ?? null;
  // Non-MIME content signed or encrypted by OpenSSL and older clients:
  // never show a blank message.
  if (!html && !(text && text.trim()) && attachments.length === 0) {
    text = new TextDecoder('utf-8', { fatal: false }).decode(bytes).trim();
  }
  return { body: { html, text }, attachments };
}

function applyPgpSignature(status: SecureStatus, sig: PgpSignatureSummary, fromEmail?: string): void {
  status.signature = sig.status;
  if (sig.signerEmail) {
    status.signerEmail = sig.signerEmail;
    if (fromEmail && sig.status === 'valid' && sig.signerEmails && !sig.signerEmails.includes(fromEmail.toLowerCase())) status.signerMismatch = true;
  }
  if (sig.status === 'invalid' && sig.error) status.error = sig.error;
}

async function openPgp(raw: Uint8Array, fromEmail: string | undefined, keys: SecureKeyAccess): Promise<SecureResult | null> {
  const info = detectPgp(raw);
  if (info.kind === 'none') return null;
  const status: SecureStatus = { kind: 'pgp', encrypted: false, decrypted: false, signature: 'none' };
  const verificationKeys = keys.pgpPublicKeys();
  try {
    if (info.kind === 'pgp-mime-encrypted' || info.kind === 'inline-encrypted') {
      status.encrypted = true;
      const decryptionKeys = keys.pgpDecryptionKeys();
      const ids = await encryptionKeyIds(info.ciphertext);
      const own = keys.pgpOwnKeys();
      const addressed: typeof own = [];
      for (const k of own) if (await keyHasId(k.publicKeyArmored, ids)) addressed.push(k);
      if (addressed.length === 0) {
        status.noKey = true;
        status.error = 'No PGP key of yours can decrypt this message';
        return { status, body: null, attachments: [] };
      }
      if (!addressed.some((k) => k.unlocked) || decryptionKeys.length === 0) {
        status.lockedKeyIds = addressed.map((k) => k.id);
        return { status, body: null, attachments: [] };
      }
      const dec = await decryptMessage({ armoredMessage: info.ciphertext, decryptionKeys, verificationKeysArmored: verificationKeys });
      status.decrypted = true;
      // PGP/MIME may sign the inner entity again (multipart/signed inside).
      let payload = dec.data;
      let sig = dec.signature;
      if (sig.status === 'none') {
        const inner = detectPgp(dec.data);
        if (inner.kind === 'pgp-mime-signed') {
          sig = await verifySignedPart(inner.signedBytes, inner.signature, verificationKeys);
          payload = inner.signedBytes;
        }
      }
      applyPgpSignature(status, sig, fromEmail);
      const rendered = await renderPayload(payload);
      await maybeRememberEmbeddedKey(rendered.body?.text, keys);
      return { status, ...rendered };
    }
    if (info.kind === 'pgp-mime-signed') {
      applyPgpSignature(status, await verifySignedPart(info.signedBytes, info.signature, verificationKeys), fromEmail);
      return { status, ...(await renderPayload(info.signedBytes)) };
    }
    // inline-signed
    const v = await verifyCleartext({ cleartext: info.cleartext, verificationKeysArmored: verificationKeys });
    applyPgpSignature(status, v.signature, fromEmail);
    await maybeRememberEmbeddedKey(v.text, keys);
    return { status, body: { html: null, text: v.text }, attachments: [] };
  } catch (err) {
    status.error = err instanceof PgpArgon2UnsupportedError ? err.message : err instanceof Error ? err.message : String(err);
    if (status.encrypted) status.decrypted = false;
    else if (status.signature === 'none') status.signature = 'invalid';
    return { status, body: null, attachments: [] };
  }
}

async function verifySignedPart(signed: Uint8Array, signature: string, verificationKeys: string[]): Promise<PgpSignatureSummary> {
  const first = await verifyDetached({ data: signed, armoredSignature: signature, verificationKeysArmored: verificationKeys });
  if (first.status !== 'invalid') return first;
  // A relay that dropped the CRs: check the canonical form too.
  const canonical = canonicalSignedBytes(signed);
  if (canonical.length === signed.length) return first;
  const retry = await verifyDetached({ data: canonical, armoredSignature: signature, verificationKeysArmored: verificationKeys });
  return retry.status === 'valid' ? retry : first;
}

async function maybeRememberEmbeddedKey(text: string | null | undefined, keys: SecureKeyAccess): Promise<void> {
  const block = extractPublicKeyBlock(text ?? '');
  if (block && keys.rememberPgpKey) await keys.rememberPgpKey(block);
}

function applySmimeSignature(status: SecureStatus, sig: SmimeSignatureStatus): void {
  status.signature = sig.signatureValid ? 'valid' : 'invalid';
  status.signerEmail = sig.signerEmail;
  status.selfSigned = sig.selfSigned;
  if (sig.signerEmailMatch === false) status.signerMismatch = true;
  if (!sig.signatureValid && sig.signatureError) status.error = sig.signatureError;
}

async function openSmime(raw: Uint8Array, fromEmail: string | undefined, keys: SecureKeyAccess): Promise<SecureResult | null> {
  const root = parseEntity(bytesToBinary(raw));
  const isDetached = (n: MimeNode) => n.type === 'multipart/signed' && /pkcs7-signature/i.test(n.params.protocol || '');
  const isOpaque = (n: MimeNode) => n.type === 'application/pkcs7-mime' || n.type === 'application/x-pkcs7-mime';
  const node = findNode(root, (n) => isDetached(n) || isOpaque(n));
  if (!node) return null;

  const cms = await import('./smime/cms');
  const status: SecureStatus = { kind: 'smime', encrypted: false, decrypted: false, signature: 'none' };
  try {
    if (isDetached(node)) {
      const sigPart = node.children.find((c) => /^application\/(x-)?pkcs7-signature$/.test(c.type));
      const signed = node.children[0];
      if (!sigPart || !signed || signed === sigPart) {
        status.signature = 'invalid';
        status.error = 'Malformed multipart/signed message';
        return { status, body: null, attachments: [] };
      }
      const entity = binaryToBytes(signed.raw);
      const sig = await cms.smimeVerifyDetached(decodeBody(sigPart), entity, fromEmail);
      applySmimeSignature(status, sig);
      if (sig.signatureValid && sig.signerCertificate) await keys.rememberCertificate?.(sig.signerCertificate);
      return { status, ...(await renderPayload(entity)) };
    }

    const der = decodeBody(node);
    if (cms.isSignedData(der)) {
      const v = await cms.smimeVerifyOpaque(der, fromEmail);
      applySmimeSignature(status, v.status);
      if (v.status.signatureValid && v.status.signerCertificate) await keys.rememberCertificate?.(v.status.signerCertificate);
      return { status, ...(await renderPayload(v.mimeBytes)) };
    }

    status.encrypted = true;
    const material = keys.smimeKeys();
    let decrypted: Uint8Array;
    try {
      decrypted = (await cms.smimeDecrypt(der, material)).mimeBytes;
    } catch (err) {
      if (err instanceof cms.SmimeKeyLockedError) {
        status.lockedKeyIds = cms.matchingKeyIds(der, material).filter((id) => !material.find((m) => m.id === id)?.pkcs8);
        return { status, body: null, attachments: [] };
      }
      if (err instanceof cms.SmimeNoMatchingKeyError) {
        status.noKey = true;
        status.error = err.message;
        return { status, body: null, attachments: [] };
      }
      if (err instanceof cms.UnsupportedAlgorithmError) {
        status.unsupportedAlgorithm = err.algorithm;
        status.error = err.message;
        return { status, body: null, attachments: [] };
      }
      throw err;
    }
    status.decrypted = true;

    // Sign-then-encrypt: the decrypted content is a signed CMS, nested as a
    // MIME entity (RFC 8551, Thunderbird/Outlook) or, rarely, raw DER.
    let payload = decrypted;
    const inner = parseEntity(bytesToBinary(decrypted.subarray(0, Math.min(decrypted.length, 1 << 20))));
    const innerSigned = inner.type === 'application/pkcs7-mime' || inner.type === 'application/x-pkcs7-mime'
      ? decodeBody(parseEntity(bytesToBinary(decrypted)))
      : decrypted[0] === 0x30 ? decrypted : null;
    if (innerSigned && cms.isSignedData(innerSigned)) {
      const v = await cms.smimeVerifyOpaque(innerSigned, fromEmail);
      applySmimeSignature(status, v.status);
      if (v.status.signatureValid && v.status.signerCertificate) await keys.rememberCertificate?.(v.status.signerCertificate);
      payload = v.mimeBytes;
    } else if (inner.type === 'multipart/signed' && /pkcs7-signature/i.test(inner.params.protocol || '')) {
      const full = parseEntity(bytesToBinary(decrypted));
      const sigPart = full.children.find((c) => /^application\/(x-)?pkcs7-signature$/.test(c.type));
      const signed = full.children[0];
      if (sigPart && signed) {
        const entity = binaryToBytes(signed.raw);
        const sig = await cms.smimeVerifyDetached(decodeBody(sigPart), entity, fromEmail);
        applySmimeSignature(status, sig);
        payload = entity;
      }
    }
    return { status, ...(await renderPayload(payload)) };
  } catch (err) {
    status.error = err instanceof Error ? err.message : String(err);
    if (!status.encrypted && status.signature === 'none') status.signature = 'invalid';
    return { status, body: null, attachments: [] };
  }
}

/** Open a raw message: PGP or S/MIME result, or null for an ordinary message. */
export async function openSecureMessage(raw: Uint8Array, fromEmail: string | undefined, keys: SecureKeyAccess): Promise<SecureResult | null> {
  return (await openPgp(raw, fromEmail, keys)) ?? (await openSmime(raw, fromEmail, keys));
}
