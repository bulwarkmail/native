// OpenPGP for the app (#58): key inspection, encrypt/sign, decrypt/verify
// and PGP detection in incoming mail. Port of the webmail plugin's
// repos/plugins/bulwark-gpg/src/openpgp-engine.js and the detection half of
// pgp-mime.js. openpgp loads on first use (it is a large module).

import type * as OpenPgp from 'openpgp';
import { bytesToBinary, binaryToBytes, decodeBody, findNode, parseEntity, toCrlf, type MimeNode } from './mime';

let mod: typeof OpenPgp | null = null;
async function pgp(): Promise<typeof OpenPgp> {
  if (!mod) mod = await import('openpgp');
  return mod;
}

export interface PgpUserId {
  name: string;
  email: string;
  raw: string;
}

export interface PgpKeyInfo {
  isPrivate: boolean;
  fingerprint: string;
  keyID: string;
  userIDs: PgpUserId[];
  created: string;
  expiration: string | null;
  publicKeyArmored: string;
  algorithm: string;
}

export type PgpSignatureStatus = 'none' | 'valid' | 'invalid' | 'unknown';

export interface PgpSignatureSummary {
  status: PgpSignatureStatus;
  keyID?: string;
  error?: string;
  /** First address of the key that made the signature, when we have it. */
  signerEmail?: string;
  /** Every address on that key. */
  signerEmails?: string[];
}

function describeUserIDs(key: OpenPgp.Key): PgpUserId[] {
  return key.getUserIDs().map((uid) => {
    const m = /^(.*?)\s*<([^>]+)>\s*$/.exec(uid);
    return m ? { name: m[1].trim(), email: m[2].trim().toLowerCase(), raw: uid } : { name: '', email: uid.trim().toLowerCase(), raw: uid };
  });
}

function keyAlgorithm(key: OpenPgp.Key): string {
  try {
    const info = key.getAlgorithmInfo() as { algorithm: string; bits?: number; curve?: string };
    return info.bits ? `${info.algorithm}-${info.bits}` : info.curve || info.algorithm;
  } catch {
    return 'unknown';
  }
}

/** Parse an armored public OR private key block and return its metadata. */
export async function inspectKey(armored: string): Promise<PgpKeyInfo> {
  const openpgp = await pgp();
  const isPrivate = /BEGIN PGP PRIVATE KEY/.test(armored);
  const key: OpenPgp.Key = isPrivate
    ? await openpgp.readPrivateKey({ armoredKey: armored })
    : await openpgp.readKey({ armoredKey: armored });
  let expiration: string | null = null;
  try {
    const exp = await key.getExpirationTime();
    expiration = exp === Infinity || exp == null ? null : new Date(exp as Date).toISOString();
  } catch {
    // some keys throw on expiration lookups; treat as non-expiring
  }
  return {
    isPrivate,
    fingerprint: key.getFingerprint(),
    keyID: key.getKeyID().toHex(),
    userIDs: describeUserIDs(key),
    created: key.getCreationTime().toISOString(),
    expiration,
    publicKeyArmored: isPrivate ? key.toPublic().armor() : armored,
    algorithm: keyAlgorithm(key),
  };
}

/** Thrown for a key protected with Argon2, whose WebAssembly module Hermes can't run. */
export class PgpArgon2UnsupportedError extends Error {
  constructor() {
    super('This key is protected with Argon2, which the app cannot unlock yet. Export it again with the default (iterated) passphrase protection, for example with GnuPG.');
    this.name = 'PgpArgon2UnsupportedError';
  }
}

/** Thrown for a wrong passphrase. */
export class PgpWrongPassphraseError extends Error {
  constructor() {
    super('Wrong passphrase');
    this.name = 'PgpWrongPassphraseError';
  }
}

/** Is the armored private key protected by a passphrase? */
export async function privateKeyNeedsPassphrase(armored: string): Promise<boolean> {
  const openpgp = await pgp();
  const key = await openpgp.readPrivateKey({ armoredKey: armored });
  return !key.isDecrypted();
}

/** Unlock a (possibly passphrase-protected) armored private key. */
export async function unlockPrivateKey(armored: string, passphrase: string): Promise<OpenPgp.PrivateKey> {
  const openpgp = await pgp();
  const privateKey = await openpgp.readPrivateKey({ armoredKey: armored });
  if (privateKey.isDecrypted()) return privateKey;
  const usesArgon2 = privateKey.getKeys().some((k) => (k.keyPacket as { s2k?: { type?: string } }).s2k?.type === 'argon2');
  try {
    return await openpgp.decryptKey({ privateKey, passphrase });
  } catch (err) {
    if (usesArgon2 && typeof (globalThis as { WebAssembly?: unknown }).WebAssembly === 'undefined') throw new PgpArgon2UnsupportedError();
    const msg = err instanceof Error ? err.message : String(err);
    if (/incorrect key passphrase|passphrase/i.test(msg)) throw new PgpWrongPassphraseError();
    throw err;
  }
}

async function readKeys(armoredList: string[]): Promise<OpenPgp.Key[]> {
  const openpgp = await pgp();
  const keys = await Promise.all(armoredList.map((a) => openpgp.readKey({ armoredKey: a }).catch(() => null)));
  return keys.filter((k): k is OpenPgp.Key => !!k);
}

async function summariseSignatures(signatures: OpenPgp.VerifyMessageResult['signatures'] | undefined, keys: OpenPgp.Key[]): Promise<PgpSignatureSummary> {
  if (!signatures || signatures.length === 0) return { status: 'none' };
  const sig = signatures[0];
  // The signing (sub)key's id; the plugin compared primary key ids only.
  const signer = keys.find((k) => k.getKeys(sig.keyID).length > 0);
  const signerEmails = signer ? describeUserIDs(signer).map((u) => u.email).filter((e) => e.includes('@')) : undefined;
  const who = signerEmails?.length ? { signerEmail: signerEmails[0], signerEmails } : {};
  try {
    await sig.verified; // throws if the signature does not validate
    return { status: 'valid', keyID: sig.keyID.toHex(), ...who };
  } catch (err) {
    // "Could not find signing key" still means the bytes were signed; we just
    // lack the public key to confirm who signed it.
    const message = err instanceof Error ? err.message : String(err);
    const unknownKey = !signer || /find signing key|No key/i.test(message);
    return { status: unknownKey ? 'unknown' : 'invalid', keyID: sig.keyID.toHex(), error: message, ...who };
  }
}

/** Encrypt (and optionally sign) bytes to the given public keys. Returns an armored PGP MESSAGE. */
export async function encryptBytes(opts: {
  data: Uint8Array;
  recipientPublicKeysArmored: string[];
  signingKey?: OpenPgp.PrivateKey | null;
}): Promise<string> {
  const openpgp = await pgp();
  const encryptionKeys = await Promise.all(opts.recipientPublicKeysArmored.map((a) => openpgp.readKey({ armoredKey: a })));
  const message = await openpgp.createMessage({ binary: opts.data });
  return (await openpgp.encrypt({
    message,
    encryptionKeys,
    signingKeys: opts.signingKey ?? undefined,
    format: 'armored',
    config: { preferredSymmetricAlgorithm: openpgp.enums.symmetric.aes256 },
  })) as string;
}

/** Detached armored signature over exact bytes (a PGP/MIME signed part). */
export async function detachedSign(data: Uint8Array, signingKey: OpenPgp.PrivateKey): Promise<string> {
  const openpgp = await pgp();
  const message = await openpgp.createMessage({ binary: data });
  return (await openpgp.sign({ message, signingKeys: signingKey, detached: true, format: 'armored' })) as string;
}

/** Decrypt an armored PGP MESSAGE and verify embedded signatures. */
export async function decryptMessage(opts: {
  armoredMessage: string;
  decryptionKeys: OpenPgp.PrivateKey[];
  verificationKeysArmored: string[];
}): Promise<{ data: Uint8Array; signature: PgpSignatureSummary }> {
  const openpgp = await pgp();
  const message = await openpgp.readMessage({ armoredMessage: opts.armoredMessage });
  const verificationKeys = await readKeys(opts.verificationKeysArmored);
  const { data, signatures } = await openpgp.decrypt({
    message,
    decryptionKeys: opts.decryptionKeys,
    verificationKeys,
    expectSigned: false,
    format: 'binary',
  });
  return { data: data as Uint8Array, signature: await summariseSignatures(signatures, verificationKeys) };
}

/** The key ids an encrypted message is addressed to (to pick the key to unlock). */
export async function encryptionKeyIds(armoredMessage: string): Promise<string[]> {
  const openpgp = await pgp();
  const message = await openpgp.readMessage({ armoredMessage });
  return message.getEncryptionKeyIDs().map((id) => id.toHex());
}

/** Do any of the key's (sub)keys have one of these ids? */
export async function keyHasId(armoredKey: string, keyIds: string[]): Promise<boolean> {
  const openpgp = await pgp();
  const key = await openpgp.readKey({ armoredKey });
  const ids = new Set(key.getKeyIDs().map((id) => id.toHex()));
  return keyIds.some((id) => ids.has(id) || id === '0000000000000000');
}

/** Verify a detached signature over the exact bytes it covers. */
export async function verifyDetached(opts: {
  data: Uint8Array;
  armoredSignature: string;
  verificationKeysArmored: string[];
}): Promise<PgpSignatureSummary> {
  const openpgp = await pgp();
  const message = await openpgp.createMessage({ binary: opts.data });
  const signature = await openpgp.readSignature({ armoredSignature: opts.armoredSignature });
  const verificationKeys = await readKeys(opts.verificationKeysArmored);
  const result = await openpgp.verify({ message, signature, verificationKeys });
  return summariseSignatures(result.signatures, verificationKeys);
}

/** Verify a cleartext-signed message ("-----BEGIN PGP SIGNED MESSAGE-----"). */
export async function verifyCleartext(opts: {
  cleartext: string;
  verificationKeysArmored: string[];
}): Promise<{ text: string; signature: PgpSignatureSummary }> {
  const openpgp = await pgp();
  const signedMessage = await openpgp.readCleartextMessage({ cleartextMessage: opts.cleartext });
  const verificationKeys = await readKeys(opts.verificationKeysArmored);
  const result = await openpgp.verify({ message: signedMessage, verificationKeys });
  return { text: signedMessage.getText(), signature: await summariseSignatures(result.signatures, verificationKeys) };
}

// ── detection (incoming) ─────────────────────────────────────────────

const ARMOR_MESSAGE = /-----BEGIN PGP MESSAGE-----[\s\S]+?-----END PGP MESSAGE-----/;
const ARMOR_SIGNED = /-----BEGIN PGP SIGNED MESSAGE-----[\s\S]+?-----END PGP SIGNATURE-----/;
const ARMOR_SIGNATURE = /-----BEGIN PGP SIGNATURE-----[\s\S]+?-----END PGP SIGNATURE-----/;
const ARMOR_PUBKEY = /-----BEGIN PGP PUBLIC KEY BLOCK-----[\s\S]+?-----END PGP PUBLIC KEY BLOCK-----/;

export type PgpDetection =
  | { kind: 'pgp-mime-encrypted'; ciphertext: string }
  | { kind: 'pgp-mime-signed'; signedBytes: Uint8Array; signature: string }
  | { kind: 'inline-encrypted'; ciphertext: string }
  | { kind: 'inline-signed'; cleartext: string }
  | { kind: 'none' };

function extract(re: RegExp, text: string): string {
  const m = re.exec(text || '');
  return m ? m[0] : '';
}

function decodedText(node: MimeNode): string {
  const bytes = decodeBody(node);
  try {
    return new TextDecoder((node.params.charset || 'utf-8').toLowerCase(), { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }
}

/** Classify a raw RFC 5322 message (bytes) for PGP content. */
export function detectPgp(raw: Uint8Array): PgpDetection {
  const root = parseEntity(bytesToBinary(raw));

  const encrypted = findNode(root, (n) => n.type === 'multipart/encrypted' && /pgp-encrypted/i.test(n.params.protocol || ''));
  if (encrypted) {
    const part = encrypted.children.find((p) => ARMOR_MESSAGE.test(p.body)) ?? encrypted.children[1];
    const ciphertext = part ? extract(ARMOR_MESSAGE, part.cte === 'base64' || part.cte === 'quoted-printable' ? bytesToBinary(decodeBody(part)) : part.body) : '';
    if (ciphertext) return { kind: 'pgp-mime-encrypted', ciphertext };
  }

  const signed = findNode(root, (n) => n.type === 'multipart/signed' && /pgp-signature/i.test(n.params.protocol || ''));
  if (signed && signed.children.length >= 2) {
    const sigPart = signed.children.find((p) => p.type === 'application/pgp-signature');
    const signature = sigPart ? extract(ARMOR_SIGNATURE, bytesToBinary(decodeBody(sigPart))) : '';
    if (signature) {
      return { kind: 'pgp-mime-signed', signedBytes: binaryToBytes(signed.children[0].raw), signature };
    }
  }

  // Inline PGP: armor inside a text part (decoded: quoted-printable turns the
  // armor's '=' checksum line into '=3D').
  const texts: string[] = [];
  const collect = (n: MimeNode) => {
    if (n.children.length) n.children.forEach(collect);
    else if (n.type === 'text/plain') texts.push(decodedText(n));
  };
  collect(root);
  for (const text of texts) {
    if (ARMOR_MESSAGE.test(text)) return { kind: 'inline-encrypted', ciphertext: extract(ARMOR_MESSAGE, text) };
    if (ARMOR_SIGNED.test(text)) return { kind: 'inline-signed', cleartext: extract(ARMOR_SIGNED, text) };
  }
  return { kind: 'none' };
}

export function extractPublicKeyBlock(text: string): string {
  return extract(ARMOR_PUBKEY, text || '');
}

/** CRLF-canonical bytes of a signed part (RFC 3156 §5), for a relay that dropped the CRs. */
export function canonicalSignedBytes(bytes: Uint8Array): Uint8Array {
  return binaryToBytes(toCrlf(bytesToBinary(bytes)));
}
