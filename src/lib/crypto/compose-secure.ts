// Signing / encrypting from the composer (#58): which keys a send needs,
// whether every recipient has one, and turning the composer's outgoing
// message into the raw signed/encrypted blob that sendEmail imports. The
// plugins' onComposeSend (repos/plugins/bulwark-gpg/src/index.js,
// repos/plugins/smime/src/index.js) do the same with host.jmap.sendRaw.

import type { OutgoingEmail } from '../../api/email';
import type { ContactCard } from '../../api/types';
import { useCryptoKeysStore, keysForEmail, isRecordCurrent, type CryptoKeyRecord, type PgpKeyRecord, type SmimeCertRecord } from '../../stores/crypto-keys-store';
import { messagePriorityHeaders } from '../message-priority';
import { base64Decode, formatHeader, encodeHeaderWords, type MimeAttachment, type MimeMessageInput } from './mime';
import { buildSecureMessage, type SecureMode } from './secure-send';
import { ownKeyFor, unlockedPgpKey, unlockedSmimeKey } from './keyring';

export interface SecureChoice {
  mode: SecureMode;
  sign: boolean;
  encrypt: boolean;
}

export const NO_SECURE_CHOICE: SecureChoice = Object.freeze({ mode: 'pgp', sign: false, encrypt: false }) as SecureChoice;

export function isSecureChoice(choice: SecureChoice | null | undefined): choice is SecureChoice {
  return !!choice && (choice.sign || choice.encrypt);
}

/** A recipient key found in a contact card (JSContact cryptoKeys, vCard KEY). */
function keysFromContacts(kind: SecureMode, email: string, contacts: ContactCard[]): Array<string | Uint8Array> {
  const e = email.toLowerCase();
  const out: Array<string | Uint8Array> = [];
  for (const card of contacts) {
    const emails = Object.values(card.emails ?? {}).map((m) => (m.address ?? '').toLowerCase());
    if (!emails.includes(e)) continue;
    for (const key of Object.values(card.cryptoKeys ?? {})) {
      const decoded = decodeDataUri(key.uri);
      if (!decoded) continue;
      const type = (key.mediaType || decoded.type).toLowerCase();
      const text = new TextDecoder('utf-8', { fatal: false }).decode(decoded.bytes);
      if (kind === 'pgp' && (type.includes('pgp') || text.includes('BEGIN PGP PUBLIC KEY BLOCK'))) {
        if (text.includes('BEGIN PGP PUBLIC KEY BLOCK')) out.push(text);
      } else if (kind === 'smime' && (type.includes('pkix') || type.includes('x509') || type.includes('x-x509') || text.includes('BEGIN CERTIFICATE'))) {
        out.push(text.includes('BEGIN CERTIFICATE') ? base64Decode(text.replace(/-----[^-]+-----/g, '')) : decoded.bytes);
      }
    }
  }
  return out;
}

function decodeDataUri(uri: string | undefined): { type: string; bytes: Uint8Array } | null {
  const m = /^data:([^;,]*)((?:;[^,]*)*?),(.*)$/s.exec(uri ?? '');
  if (!m) return null;
  const isBase64 = /;base64/i.test(m[2]);
  try {
    const bytes = isBase64 ? base64Decode(decodeURIComponent(m[3])) : new TextEncoder().encode(decodeURIComponent(m[3]));
    return { type: m[1] || 'application/octet-stream', bytes };
  } catch {
    return null;
  }
}

export interface RecipientKeys {
  /** Armored PGP keys or DER certificates, one or more per found recipient. */
  found: Array<string | Uint8Array>;
  missing: string[];
}

/** Public keys for every recipient: the stored keys first, then contact cards. */
export function resolveRecipientKeys(kind: SecureMode, emails: string[], contacts: ContactCard[] = []): RecipientKeys {
  const keys = useCryptoKeysStore.getState().keys;
  const found: Array<string | Uint8Array> = [];
  const missing: string[] = [];
  for (const email of [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))]) {
    const stored = keysForEmail(keys, email).filter((k): k is CryptoKeyRecord => k.kind === kind && isRecordCurrent(k));
    const usable = kind === 'smime' ? stored.filter((k) => (k as SmimeCertRecord).canEncrypt) : stored;
    if (usable.length) {
      for (const k of usable) found.push(k.kind === 'pgp' ? (k as PgpKeyRecord).publicKeyArmored : base64Decode((k as SmimeCertRecord).certificate));
      continue;
    }
    const fromContacts = keysFromContacts(kind, email, contacts);
    if (fromContacts.length) found.push(...fromContacts);
    else missing.push(email);
  }
  return { found, missing };
}

export interface SecureReadiness {
  /** Your own key for the From address (needed to sign, and to keep Sent readable). */
  ownKey?: CryptoKeyRecord;
  /** Recipients without a key (encrypt only). */
  missingRecipients: string[];
}

export function secureReadiness(choice: SecureChoice, fromEmail: string, recipients: string[], contacts: ContactCard[] = []): SecureReadiness {
  const ownKey = ownKeyFor(choice.mode, fromEmail);
  const missingRecipients = choice.encrypt ? resolveRecipientKeys(choice.mode, recipients, contacts).missing : [];
  return { ownKey, missingRecipients };
}

/** Header lines the composer's options add (priority, read receipt, Reply-To). */
function extraHeaders(outgoing: OutgoingEmail): string[] {
  const lines: string[] = [];
  if (outgoing.replyTo?.length) {
    lines.push(formatHeader('Reply-To', outgoing.replyTo.map((a) => (a.name ? `${encodeHeaderWords(a.name)} <${a.email}>` : a.email)).join(', ')));
  }
  for (const [prop, value] of Object.entries(messagePriorityHeaders(outgoing.priority))) {
    const name = /^header:([^:]+):/.exec(prop)?.[1];
    if (name) lines.push(formatHeader(name, value));
  }
  if (outgoing.requestReadReceipt && outgoing.from[0]?.email) lines.push(formatHeader('Disposition-Notification-To', outgoing.from[0].email));
  return lines;
}

export class SecureSendError extends Error {
  code: 'no-own-key' | 'locked' | 'missing-recipients';
  detail?: string[];
  constructor(code: SecureSendError['code'], message: string, detail?: string[]) {
    super(message);
    this.name = 'SecureSendError';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Build the signed/encrypted message for `outgoing` and upload it; returns
 * the blob id for sendEmail's `rawBlobId`. The own key must be unlocked
 * first when signing (the composer asks for the passphrase).
 */
export async function prepareSecureSend(
  outgoing: OutgoingEmail,
  choice: SecureChoice,
  deps: {
    contacts?: ContactCard[];
    fetchBlob: (blobId: string, name: string, type: string) => Promise<Uint8Array>;
    upload: (bytes: Uint8Array) => Promise<string>;
  },
): Promise<string> {
  const fromEmail = outgoing.from[0]?.email ?? '';
  const own = ownKeyFor(choice.mode, fromEmail);
  if (!own) throw new SecureSendError('no-own-key', `No ${choice.mode === 'pgp' ? 'PGP key' : 'S/MIME certificate'} of yours for ${fromEmail}`);
  const recipients = [...outgoing.to, ...(outgoing.cc ?? []), ...(outgoing.bcc ?? [])].map((r) => r.email);

  const attachments: MimeAttachment[] = [];
  for (const a of outgoing.attachments ?? []) {
    attachments.push({
      filename: a.name || 'attachment',
      contentType: a.type || 'application/octet-stream',
      content: await deps.fetchBlob(a.blobId, a.name || 'attachment', a.type || 'application/octet-stream'),
      cid: a.disposition === 'inline' ? a.cid : undefined,
    });
  }
  const input: MimeMessageInput = {
    from: outgoing.from[0],
    to: outgoing.to,
    cc: outgoing.cc,
    subject: outgoing.subject,
    textBody: outgoing.textBody,
    htmlBody: outgoing.htmlBody,
    attachments,
    inReplyTo: outgoing.inReplyTo,
    references: outgoing.references,
    messageId: outgoing.messageId,
    extraHeaders: extraHeaders(outgoing),
  };

  let raw: Uint8Array;
  if (choice.mode === 'pgp') {
    const record = own as PgpKeyRecord;
    const signingKey = choice.sign ? unlockedPgpKey(record.id) : null;
    if (choice.sign && !signingKey) throw new SecureSendError('locked', 'Unlock your PGP key to sign');
    let encryptionKeys: string[] | undefined;
    if (choice.encrypt) {
      const r = resolveRecipientKeys('pgp', recipients, deps.contacts);
      if (r.missing.length) throw new SecureSendError('missing-recipients', `No public key for ${r.missing.join(', ')}`, r.missing);
      // Encrypted to yourself too, so Sent stays readable.
      encryptionKeys = [...(r.found as string[]), record.publicKeyArmored];
    }
    raw = await buildSecureMessage(input, choice, { pgp: { signingKey, encryptionKeys } });
  } else {
    const record = own as SmimeCertRecord;
    const unlocked = choice.sign ? unlockedSmimeKey(record.id) : undefined;
    if (choice.sign && !unlocked) throw new SecureSendError('locked', 'Unlock your S/MIME key to sign');
    let recipientCerts: Uint8Array[] | undefined;
    if (choice.encrypt) {
      const r = resolveRecipientKeys('smime', recipients, deps.contacts);
      if (r.missing.length) throw new SecureSendError('missing-recipients', `No certificate for ${r.missing.join(', ')}`, r.missing);
      recipientCerts = r.found as Uint8Array[];
    }
    raw = await buildSecureMessage(input, choice, {
      smime: {
        signer: unlocked ? { pkcs8: unlocked.pkcs8, certificate: base64Decode(record.certificate), chain: record.chain.map(base64Decode), algorithm: record.algorithm } : undefined,
        recipientCerts,
        senderCert: base64Decode(record.certificate),
      },
    });
  }
  return deps.upload(raw);
}
