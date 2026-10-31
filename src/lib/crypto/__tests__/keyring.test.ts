// Key management (#58): private keys go to SecureStore only, in pieces
// SecureStore can hold; public keys and certificates are listed; unlocking
// checks the passphrase and lasts for the session.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { setSecret, getSecret, deleteSecret } from '../secret-store';
import {
  importPgpKey, importPkcs12File, importCertificate, deleteKey, exportPublic, unlock, lockAll, isUnlocked, needsPassphrase, ownKeyFor,
} from '../keyring';
import { useCryptoKeysStore } from '../../../stores/crypto-keys-store';
import { PgpWrongPassphraseError } from '../pgp';
import { hasOpenssl, makePgpKey, makeSmimeCert, openssl, useNodeCrypto } from './helpers';

const secure = vi.hoisted(() => new Map<string, string>());

vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
  setItemAsync: vi.fn(async (k: string, v: string) => {
    if (v.length > 2048) throw new Error('value too large for SecureStore');
    secure.set(k, v);
  }),
  getItemAsync: vi.fn(async (k: string) => secure.get(k) ?? null),
  deleteItemAsync: vi.fn(async (k: string) => {
    secure.delete(k);
  }),
}));

beforeAll(() => {
  useNodeCrypto();
});

beforeEach(() => {
  secure.clear();
  lockAll();
  useCryptoKeysStore.setState({ keys: [] });
});

describe('secret store', () => {
  it('splits a large secret over items SecureStore can hold and reads it back whole', async () => {
    const big = 'x'.repeat(7000) + 'end';
    await setSecret('pgp.abc', big);
    expect([...secure.values()].every((v) => v.length <= 2048)).toBe(true);
    expect(secure.size).toBeGreaterThan(3);
    expect(await getSecret('pgp.abc')).toBe(big);
    await deleteSecret('pgp.abc');
    expect(secure.size).toBe(0);
    expect(await getSecret('pgp.abc')).toBeNull();
  });
});

describe('PGP keys', () => {
  it('imports a private key into SecureStore only, checks its passphrase, and unlocks it again later', async () => {
    const k = await makePgpKey('me@example.org', 'correct horse', 'rsa');
    await expect(importPgpKey(k.privateKey, 'wrong')).rejects.toBeInstanceOf(PgpWrongPassphraseError);
    expect(useCryptoKeysStore.getState().keys).toHaveLength(0);

    const record = await importPgpKey(k.privateKey, 'correct horse');
    expect(record).toMatchObject({ kind: 'pgp', hasPrivate: true, emails: ['me@example.org'] });
    expect([...secure.values()].join('')).toContain('BEGIN PGP PRIVATE KEY BLOCK');
    // Nothing private in what AsyncStorage gets.
    expect(JSON.stringify(useCryptoKeysStore.getState().keys)).not.toContain('PRIVATE KEY');
    await vi.waitFor(async () => expect(await AsyncStorage.getItem('crypto-keys')).toContain('PUBLIC KEY'), { timeout: 3000 });
    expect(await AsyncStorage.getItem('crypto-keys')).not.toContain('PRIVATE KEY');

    expect(isUnlocked(record)).toBe(true);
    lockAll();
    expect(isUnlocked(record)).toBe(false);
    expect(await needsPassphrase(record)).toBe(true);
    await expect(unlock(record, 'nope')).rejects.toBeInstanceOf(PgpWrongPassphraseError);
    await unlock(record, 'correct horse');
    expect(isUnlocked(record)).toBe(true);
    expect(ownKeyFor('pgp', 'ME@example.org')?.id).toBe(record.id);
    expect(await exportPublic(record)).toContain('BEGIN PGP PUBLIC KEY BLOCK');

    await deleteKey(record);
    expect(secure.size).toBe(0);
    expect(useCryptoKeysStore.getState().keys).toHaveLength(0);
  }, 60_000);

  it('a public import of a key we hold privately keeps the private flag', async () => {
    const k = await makePgpKey('me@example.org');
    await importPgpKey(k.privateKey, k.passphrase);
    await importPgpKey(k.publicKey);
    expect(useCryptoKeysStore.getState().keys).toHaveLength(1);
    expect(useCryptoKeysStore.getState().keys[0].hasPrivate).toBe(true);
  }, 30_000);
});

describe('S/MIME keys', () => {
  it('imports a certificate as a recipient certificate', async () => {
    const c = await makeSmimeCert('them@example.org');
    const record = await importCertificate(new TextEncoder().encode(c.certPem));
    expect(record).toMatchObject({ kind: 'smime', hasPrivate: false, emails: ['them@example.org'], canEncrypt: true });
    expect(await exportPublic(record)).toContain('BEGIN CERTIFICATE');
  }, 30_000);

  it.skipIf(!hasOpenssl())('imports a .p12 into SecureStore and needs its password after locking', async () => {
    const c = await makeSmimeCert('me@example.org');
    const p12 = openssl(['pkcs12', '-export', '-in', 'cert.pem', '-inkey', 'key.pem', '-out', 'out.p12', '-passout', 'pass:pw'],
      { 'cert.pem': c.certPem, 'key.pem': c.keyPem }, 'out.p12');
    const record = await importPkcs12File(p12, 'pw');
    expect(record).toMatchObject({ kind: 'smime', hasPrivate: true, emails: ['me@example.org'] });
    expect(secure.size).toBeGreaterThan(1);
    expect(JSON.stringify(useCryptoKeysStore.getState().keys)).not.toContain(Buffer.from(p12).toString('base64').slice(0, 40));
    lockAll();
    expect(await needsPassphrase(record)).toBe(true);
    await expect(unlock(record, 'bad')).rejects.toThrow(/password/i);
    await unlock(record, 'pw');
    expect(isUnlocked(record)).toBe(true);
  }, 60_000);
});
