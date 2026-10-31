// Key management for PGP and S/MIME (#58): import, export, delete, unlock
// for the session, and recipient lookup. Ports the key handling of the
// webmail plugins (repos/plugins/bulwark-gpg/src/index.js SettingsSection,
// repos/plugins/smime/src/ui.js + pkcs12.js) onto SecureStore.
//
// Unlocked keys stay in memory for the app session only (the plugins keep
// them until reload/logout); passphrases are never stored.

import type * as OpenPgp from 'openpgp';
import { useCryptoKeysStore, upsertRecord, keysForEmail, isRecordCurrent, type CryptoKeyRecord, type PgpKeyRecord, type SmimeCertRecord } from '../../stores/crypto-keys-store';
import { setSecret, getSecret, deleteSecret } from './secret-store';
import { inspectKey, unlockPrivateKey, privateKeyNeedsPassphrase, type PgpKeyInfo } from './pgp';
import { base64Decode, base64Encode } from './mime';

const pgpSecretId = (id: string) => `pgp.${id}`;
const smimeSecretId = (id: string) => `smime.${id}`;

// ── session (memory only) ────────────────────────────────────────────

const unlockedPgp = new Map<string, OpenPgp.PrivateKey>();
const unlockedSmime = new Map<string, { pkcs8: Uint8Array }>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

/** Subscribe to lock/unlock changes (the reader re-tries a locked message). */
export function onUnlockChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function isUnlocked(record: CryptoKeyRecord): boolean {
  return record.kind === 'pgp' ? unlockedPgp.has(record.id) : unlockedSmime.has(record.id);
}

/** Forget every unlocked key (Settings > Encryption > Lock). */
export function lockAll(): void {
  unlockedPgp.clear();
  unlockedSmime.clear();
  notify();
}

export function unlockedPgpKeys(): OpenPgp.PrivateKey[] {
  return [...unlockedPgp.values()];
}

export function unlockedPgpKey(id: string): OpenPgp.PrivateKey | undefined {
  return unlockedPgp.get(id);
}

export function unlockedSmimeKey(id: string): { pkcs8: Uint8Array } | undefined {
  return unlockedSmime.get(id);
}

function records(): CryptoKeyRecord[] {
  return useCryptoKeysStore.getState().keys;
}

function upsert(record: CryptoKeyRecord): void {
  useCryptoKeysStore.setState({ keys: upsertRecord(records(), record) });
}

/** Does this private key need a passphrase to unlock? (A key without one unlocks silently.) */
export async function needsPassphrase(record: CryptoKeyRecord): Promise<boolean> {
  if (isUnlocked(record)) return false;
  if (record.kind === 'smime') return true;
  const armored = await getSecret(pgpSecretId(record.id));
  if (!armored) throw new Error('The private key is missing from the secure storage');
  return privateKeyNeedsPassphrase(armored);
}

/** Unlock a private key for this session. Throws on a wrong passphrase. */
export async function unlock(record: CryptoKeyRecord, passphrase: string): Promise<void> {
  if (record.kind === 'pgp') {
    const armored = await getSecret(pgpSecretId(record.id));
    if (!armored) throw new Error('The private key is missing from the secure storage');
    unlockedPgp.set(record.id, await unlockPrivateKey(armored, passphrase));
  } else {
    const p12 = await getSecret(smimeSecretId(record.id));
    if (!p12) throw new Error('The private key is missing from the secure storage');
    const { openPkcs12 } = await import('./smime/pkcs12');
    const opened = await openPkcs12(base64Decode(p12), passphrase);
    unlockedSmime.set(record.id, { pkcs8: opened.pkcs8 });
  }
  notify();
}

/** Unlock a key without a passphrase when it has none. Returns whether it is unlocked now. */
export async function unlockIfUnprotected(record: CryptoKeyRecord): Promise<boolean> {
  if (isUnlocked(record)) return true;
  if (record.kind !== 'pgp') return false;
  if (await needsPassphrase(record)) return false;
  await unlock(record, '');
  return true;
}

// ── import / export / delete ─────────────────────────────────────────

function pgpRecord(info: PgpKeyInfo, hasPrivate: boolean, source: PgpKeyRecord['source']): PgpKeyRecord {
  const emails = [...new Set(info.userIDs.map((u) => u.email).filter((e) => e.includes('@')))];
  return {
    kind: 'pgp',
    id: info.fingerprint.toLowerCase(),
    fingerprint: info.fingerprint.toLowerCase(),
    keyID: info.keyID.toLowerCase(),
    emails,
    userIDs: info.userIDs.map((u) => u.raw),
    created: info.created,
    expiration: info.expiration,
    algorithm: info.algorithm,
    publicKeyArmored: info.publicKeyArmored,
    hasPrivate,
    source,
    addedAt: new Date().toISOString(),
  };
}

/**
 * Import an armored PGP key. A private key is checked against its
 * passphrase (when it has one) before it is stored, so a typo doesn't leave
 * a key nobody can unlock; it is stored as given, still protected.
 */
export async function importPgpKey(armored: string, passphrase?: string, source: PgpKeyRecord['source'] = 'import'): Promise<PgpKeyRecord> {
  const text = armored.trim();
  const info = await inspectKey(text);
  if (info.isPrivate) {
    const key = await unlockPrivateKey(text, passphrase ?? '');
    await setSecret(pgpSecretId(info.fingerprint.toLowerCase()), text);
    unlockedPgp.set(info.fingerprint.toLowerCase(), key);
    notify();
  }
  const record = pgpRecord(info, info.isPrivate, source);
  upsert(record);
  return record;
}

function smimeRecord(
  info: import('./smime/certificate').CertificateInfo,
  certificate: Uint8Array,
  chain: Uint8Array[],
  hasPrivate: boolean,
  source: SmimeCertRecord['source'],
): SmimeCertRecord {
  return {
    kind: 'smime',
    id: info.fingerprint,
    fingerprint: info.fingerprint,
    emails: info.emailAddresses,
    subject: info.subject,
    issuer: info.issuer,
    serialNumber: info.serialNumber,
    notBefore: info.notBefore,
    notAfter: info.notAfter,
    algorithm: info.algorithm,
    certificate: base64Encode(certificate, 1 << 30),
    chain: chain.map((c) => base64Encode(c, 1 << 30)),
    canSign: info.capabilities.canSign,
    canEncrypt: info.capabilities.canEncrypt,
    hasPrivate,
    source,
    addedAt: new Date().toISOString(),
  };
}

/** Import your own S/MIME key from a .p12/.pfx; it stays unlocked for this session. */
export async function importPkcs12File(p12: Uint8Array, password: string): Promise<SmimeCertRecord> {
  const { openPkcs12 } = await import('./smime/pkcs12');
  const opened = await openPkcs12(p12, password);
  const record = smimeRecord(opened.info, opened.certificate, opened.chain, true, 'import');
  await setSecret(smimeSecretId(record.id), base64Encode(p12, 1 << 30));
  unlockedSmime.set(record.id, { pkcs8: opened.pkcs8 });
  upsert(record);
  notify();
  return record;
}

/** Import someone's certificate (PEM or DER). */
export async function importCertificate(bytes: Uint8Array, source: SmimeCertRecord['source'] = 'import'): Promise<SmimeCertRecord> {
  const { certificateDerFromFile, describeCertificate } = await import('./smime/certificate');
  const der = certificateDerFromFile(bytes);
  const info = await describeCertificate(der);
  const record = smimeRecord(info, der, [], false, source);
  upsert(record);
  return record;
}

/** Delete a key; its private part goes from SecureStore too. */
export async function deleteKey(record: CryptoKeyRecord): Promise<void> {
  if (record.hasPrivate) await deleteSecret(record.kind === 'pgp' ? pgpSecretId(record.id) : smimeSecretId(record.id));
  if (record.kind === 'pgp') unlockedPgp.delete(record.id);
  else unlockedSmime.delete(record.id);
  useCryptoKeysStore.getState().remove(record.kind, record.id);
  notify();
}

/** The public half to share: armored PGP key or PEM certificate. */
export async function exportPublic(record: CryptoKeyRecord): Promise<string> {
  if (record.kind === 'pgp') return record.publicKeyArmored;
  const { derToPem } = await import('./smime/certificate');
  return derToPem(base64Decode(record.certificate));
}

// ── lookups ──────────────────────────────────────────────────────────

/** Your own key for signing from this address. */
export function ownKeyFor(kind: CryptoKeyRecord['kind'], email: string): CryptoKeyRecord | undefined {
  const mine = keysForEmail(records(), email).filter((k) => k.kind === kind && k.hasPrivate && isRecordCurrent(k));
  if (kind === 'smime') return mine.find((k) => (k as SmimeCertRecord).canSign) ?? mine[0];
  return mine[0];
}

export function ownKeys(kind?: CryptoKeyRecord['kind']): CryptoKeyRecord[] {
  return records().filter((k) => k.hasPrivate && (!kind || k.kind === kind));
}

export function allPgpPublicKeys(): string[] {
  return records().filter((k): k is PgpKeyRecord => k.kind === 'pgp').map((k) => k.publicKeyArmored);
}

/** Remember the key of someone who signed a message, unless it is known already. */
export async function rememberSignerPgpKey(armored: string): Promise<void> {
  try {
    const info = await inspectKey(armored);
    if (info.isPrivate) return;
    if (records().some((k) => k.kind === 'pgp' && k.id === info.fingerprint.toLowerCase())) return;
    upsert(pgpRecord(info, false, 'message'));
  } catch {
    // a broken embedded key: ignore
  }
}

export async function rememberSignerCertificate(der: Uint8Array): Promise<void> {
  try {
    const { describeCertificate } = await import('./smime/certificate');
    const info = await describeCertificate(der);
    if (!info.emailAddresses.length) return;
    if (records().some((k) => k.kind === 'smime' && k.id === info.fingerprint)) return;
    upsert(smimeRecord(info, der, [], false, 'message'));
  } catch {
    // ignore
  }
}
