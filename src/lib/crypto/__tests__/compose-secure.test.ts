// Signing / encrypting from the composer (#58): recipient keys come from the
// stored keys or a contact card, a missing key stops the send, and the
// uploaded message carries the attachments and the composer's options.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareSecureSend, resolveRecipientKeys, SecureSendError } from '../compose-secure';
import { importPgpKey, lockAll } from '../keyring';
import { openSecureMessage } from '../secure-message';
import { useCryptoKeysStore } from '../../../stores/crypto-keys-store';
import type { ContactCard } from '../../../api/types';
import type { OutgoingEmail } from '../../../api/email';
import { makePgpKey, useNodeCrypto } from './helpers';

const secure = vi.hoisted(() => new Map<string, string>());
vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
  setItemAsync: vi.fn(async (k: string, v: string) => { secure.set(k, v); }),
  getItemAsync: vi.fn(async (k: string) => secure.get(k) ?? null),
  deleteItemAsync: vi.fn(async (k: string) => { secure.delete(k); }),
}));

let me: Awaited<ReturnType<typeof makePgpKey>>;
let friend: Awaited<ReturnType<typeof makePgpKey>>;

beforeAll(async () => {
  useNodeCrypto();
  me = await makePgpKey('me@example.org');
  friend = await makePgpKey('friend@example.org');
}, 60_000);

beforeEach(() => {
  secure.clear();
  lockAll();
  useCryptoKeysStore.setState({ keys: [] });
});

const outgoing = (bcc: string[] = []): OutgoingEmail => ({
  from: [{ name: 'Me', email: 'me@example.org' }],
  to: [{ email: 'friend@example.org' }],
  bcc: bcc.map((email) => ({ email })),
  subject: 'Encrypted with attachment',
  textBody: 'see attached',
  htmlBody: '<p>see attached</p>',
  attachments: [{ blobId: 'b1', name: 'report.pdf', type: 'application/pdf', size: 3, disposition: 'attachment' }],
  priority: 'high',
  requestReadReceipt: true,
});

const contactWithKey = (armored: string): ContactCard => ({
  id: 'c1',
  emails: { e1: { address: 'Friend@Example.org' } },
  cryptoKeys: { k1: { uri: `data:application/pgp-keys;base64,${Buffer.from(armored).toString('base64')}` } },
} as unknown as ContactCard);

describe('recipient keys', () => {
  it('finds a key in a contact card when none is stored, and names recipients without one', async () => {
    expect(resolveRecipientKeys('pgp', ['friend@example.org']).missing).toEqual(['friend@example.org']);
    const r = resolveRecipientKeys('pgp', ['friend@example.org', 'stranger@example.org'], [contactWithKey(friend.publicKey)]);
    expect(r.missing).toEqual(['stranger@example.org']);
    expect(r.found).toEqual([friend.publicKey]);
  });
});

describe('prepareSecureSend', () => {
  it('uploads a signed and encrypted PGP/MIME message the recipient can read, attachment and headers included', async () => {
    await importPgpKey(me.privateKey, me.passphrase);
    await importPgpKey(friend.publicKey);
    let uploaded: Uint8Array | null = null;
    const blobId = await prepareSecureSend(outgoing(), { mode: 'pgp', sign: true, encrypt: true }, {
      fetchBlob: async () => new Uint8Array([1, 2, 3]),
      upload: async (bytes) => {
        uploaded = bytes;
        return 'raw-blob';
      },
    });
    expect(blobId).toBe('raw-blob');
    const text = new TextDecoder().decode(uploaded!);
    expect(text).toMatch(/^X-Priority: 1 \(Highest\)$/m);
    expect(text).toMatch(/^Disposition-Notification-To: me@example.org$/m);
    expect(text).toMatch(/^From: "Me" <me@example.org>$/m);

    const res = await openSecureMessage(uploaded!, 'me@example.org', {
      pgpDecryptionKeys: () => [friend.unlocked],
      pgpOwnKeys: () => [{ id: 'friend', publicKeyArmored: friend.publicKey, unlocked: true }],
      pgpPublicKeys: () => [me.publicKey],
      smimeKeys: () => [],
    });
    expect(res?.status).toMatchObject({ decrypted: true, signature: 'valid', signerEmail: 'me@example.org' });
    expect(res?.attachments.map((a) => [a.name, Array.from(a.bytes)])).toEqual([['report.pdf', [1, 2, 3]]]);
  }, 60_000);

  it('never writes Bcc into the message', async () => {
    await importPgpKey(me.privateKey, me.passphrase);
    await importPgpKey(friend.publicKey);
    let uploaded: Uint8Array | null = null;
    // The Bcc recipient needs a key too: give them the friend's for the test.
    const contacts = [{ id: 'c2', emails: { e: { address: 'bcc@example.org' } }, cryptoKeys: contactWithKey(friend.publicKey).cryptoKeys } as unknown as ContactCard];
    await prepareSecureSend(outgoing(['bcc@example.org']), { mode: 'pgp', sign: false, encrypt: true }, {
      contacts,
      fetchBlob: async () => new Uint8Array([1]),
      upload: async (bytes) => { uploaded = bytes; return 'x'; },
    });
    expect(new TextDecoder().decode(uploaded!)).not.toMatch(/bcc@example.org/i);
  }, 60_000);

  it('quotes a Reply-To name with a comma so it stays one address', async () => {
    await importPgpKey(me.privateKey, me.passphrase);
    let uploaded: Uint8Array | null = null;
    const msg = { ...outgoing(), replyTo: [{ name: 'Support, ACME', email: 'help@acme.com' }] };
    await prepareSecureSend(msg, { mode: 'pgp', sign: true, encrypt: false }, {
      fetchBlob: async () => new Uint8Array([1]),
      upload: async (bytes) => { uploaded = bytes; return 'x'; },
    });
    const text = new TextDecoder().decode(uploaded!);
    expect(text).toMatch(/^Reply-To: "Support, ACME" <help@acme.com>$/m);
  }, 60_000);

  it('stops when a recipient has no key, or when the signing key is locked', async () => {
    await importPgpKey(me.privateKey, me.passphrase);
    const deps = { fetchBlob: async () => new Uint8Array(), upload: async () => 'x' };
    await expect(prepareSecureSend(outgoing(), { mode: 'pgp', sign: false, encrypt: true }, deps))
      .rejects.toMatchObject({ code: 'missing-recipients', detail: ['friend@example.org'] });
    lockAll();
    await expect(prepareSecureSend(outgoing(), { mode: 'pgp', sign: true, encrypt: false }, deps)).rejects.toBeInstanceOf(SecureSendError);
    useCryptoKeysStore.setState({ keys: [] });
    await expect(prepareSecureSend(outgoing(), { mode: 'pgp', sign: true, encrypt: false }, deps)).rejects.toMatchObject({ code: 'no-own-key' });
  }, 60_000);
});
