// Keys that arrive in a message (#58): any sender can put a public key in a
// message, and the app used to store every one it found, for whatever address
// it named, whatever the signature said. Stored keys verify signatures and
// are encrypted to, so that let a sender plant a key for someone else. Now a
// key is only offered (when it names the From address) and saved by the
// user; an S/MIME certificate is kept only when it names the From address.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as openpgp from 'openpgp';
import fs from 'node:fs';
import path from 'node:path';
import { buildSecureMessage } from '../secure-send';
import { openSecureMessage } from '../secure-message';
import { importPgpKey, lockAll, savePgpKeyFor } from '../keyring';
import { useCryptoKeysStore } from '../../../stores/crypto-keys-store';
import { keyringAccess } from '../../../components/email/use-secure-message';
import type { MimeMessageInput } from '../mime';
import { makePgpKey, makeSmimeCert, useNodeCrypto, type TestCert } from './helpers';

const secure = vi.hoisted(() => new Map<string, string>());
vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
  setItemAsync: vi.fn(async (k: string, v: string) => { secure.set(k, v); }),
  getItemAsync: vi.fn(async (k: string) => secure.get(k) ?? null),
  deleteItemAsync: vi.fn(async (k: string) => { secure.delete(k); }),
}));

const encode = (s: string) => new TextEncoder().encode(s);
const stored = () => useCryptoKeysStore.getState().keys;

let alice: Awaited<ReturnType<typeof makePgpKey>>;
let mallory: Awaited<ReturnType<typeof makePgpKey>>;
let bob: Awaited<ReturnType<typeof makePgpKey>>;

beforeAll(async () => {
  useNodeCrypto();
  [alice, mallory, bob] = await Promise.all([
    makePgpKey('alice@example.org'), makePgpKey('mallory@example.org'), makePgpKey('bob@example.org'),
  ]);
}, 60_000);

beforeEach(() => {
  secure.clear();
  lockAll();
  useCryptoKeysStore.setState({ keys: [] });
});

/** An inline cleartext-signed message from `from` whose text carries `key`. */
async function inlineSigned(from: string, signer: openpgp.PrivateKey, key: string, tamper = false): Promise<Uint8Array> {
  const signed = await openpgp.sign({
    message: await openpgp.createCleartextMessage({ text: `Here is my key.\n\n${key}` }),
    signingKeys: signer,
  }) as string;
  const body = tamper ? signed.replace('Here is my key.', 'Here is my kex.') : signed;
  return encode(`From: ${from}\r\nContent-Type: text/plain\r\n\r\n${body.replace(/\r?\n/g, '\r\n')}`);
}

describe('a PGP key in a message', () => {
  it('is offered, not stored, when it names the From address and the signer is not known yet', async () => {
    const res = await openSecureMessage(await inlineSigned(alice.email, alice.unlocked, alice.publicKey), alice.email, keyringAccess());
    expect(res?.status.signature).toBe('unknown');
    const fingerprint = (await openpgp.readKey({ armoredKey: alice.publicKey })).getFingerprint();
    expect(res?.offeredKey).toMatchObject({ email: alice.email, fingerprint });
    expect(stored()).toEqual([]);

    // Stored only once the user saves it.
    await savePgpKeyFor(res!.offeredKey!.armored, res!.offeredKey!.email);
    expect(stored()).toEqual([expect.objectContaining({ kind: 'pgp', id: fingerprint, emails: [alice.email], source: 'message' })]);
  }, 60_000);

  it('is neither stored nor offered when none of its user ids is the From address', async () => {
    const res = await openSecureMessage(await inlineSigned(alice.email, alice.unlocked, mallory.publicKey), alice.email, keyringAccess());
    expect(res?.offeredKey).toBeUndefined();
    expect(stored()).toEqual([]);
    await expect(savePgpKeyFor(mallory.publicKey, alice.email)).rejects.toThrow(/not for alice@example.org/);
    expect(stored()).toEqual([]);
  }, 60_000);

  it('is neither stored nor offered when the signature fails', async () => {
    await importPgpKey(alice.publicKey);
    const res = await openSecureMessage(await inlineSigned(alice.email, alice.unlocked, alice.publicKey, true), alice.email, keyringAccess());
    expect(res?.status.signature).toBe('invalid');
    expect(res?.offeredKey).toBeUndefined();
    expect(stored()).toHaveLength(1);
  }, 60_000);

  it('is not stored from a decrypted message either', async () => {
    await importPgpKey(bob.privateKey, bob.passphrase);
    const input: MimeMessageInput = {
      from: { email: alice.email },
      to: [{ email: bob.email }],
      subject: 'key',
      textBody: `My new key:\n\n${mallory.publicKey}`,
    };
    const raw = await buildSecureMessage(input, { mode: 'pgp', sign: false, encrypt: true }, { pgp: { encryptionKeys: [bob.publicKey] } });
    const access = { ...keyringAccess(), pgpDecryptionKeys: () => [bob.unlocked], pgpOwnKeys: () => [{ id: 'bob', publicKeyArmored: bob.publicKey, unlocked: true }] };
    const res = await openSecureMessage(raw, alice.email, access);
    expect(res?.status.decrypted).toBe(true);
    expect(res?.body?.text).toContain('BEGIN PGP PUBLIC KEY BLOCK');
    expect(res?.offeredKey).toBeUndefined();
    expect(stored().map((k) => k.emails)).toEqual([[bob.email]]);
  }, 60_000);
});

describe('an S/MIME signer certificate', () => {
  let signer: TestCert;
  beforeAll(async () => {
    signer = await makeSmimeCert('alice@example.org');
  }, 60_000);

  const signed = () => buildSecureMessage(
    { from: { email: signer.email }, to: [{ email: 'bob@example.org' }], subject: 's', textBody: 'signed' },
    { mode: 'smime', sign: true, encrypt: false },
    { smime: { signer: { pkcs8: signer.pkcs8, certificate: signer.certificate, chain: [], algorithm: 'RSA-2048' } } },
  );

  it('is not kept when it does not name the From address, even with a valid signature', async () => {
    const res = await openSecureMessage(await signed(), 'mallory@example.org', keyringAccess());
    expect(res?.status.signature).toBe('valid');
    expect(stored()).toEqual([]);
  }, 60_000);

  it('is kept when it names the From address', async () => {
    await openSecureMessage(await signed(), signer.email, keyringAccess());
    await vi.waitFor(() => expect(stored()).toEqual([expect.objectContaining({ kind: 'smime', emails: [signer.email], source: 'message' })]));
  }, 60_000);
});

describe('the reader', () => {
  it('hands the offered key to the banner, which saves it only on the button', () => {
    const root = path.resolve(__dirname, '../../../..');
    const content = fs.readFileSync(path.join(root, 'src/components/email/MessageContent.tsx'), 'utf8');
    expect(content).toContain('offeredKey={secure.result?.offeredKey}');
    const banner = fs.readFileSync(path.join(root, 'src/components/email/SecureMessageBanner.tsx'), 'utf8');
    expect(banner).toMatch(/onPress=\{\(\) => \{ void saveOffered\(\); \}\}>\{offer\.action\}/);
    expect(banner.match(/savePgpKeyFor\(/g)).toHaveLength(1);
  });
});
