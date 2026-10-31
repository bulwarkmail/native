// Reading and sending PGP and S/MIME mail (#58): what the app builds for a
// send is read back by the reader, signatures verify (and fail when the
// message is changed), locked and missing keys are reported.
import { beforeAll, describe, expect, it } from 'vitest';
import * as openpgp from 'openpgp';
import { buildSecureMessage } from '../secure-send';
import { openSecureMessage, secureKindHint, type SecureKeyAccess } from '../secure-message';
import type { MimeMessageInput } from '../mime';
import { makePgpKey, makeSmimeCert, useNodeCrypto, type TestCert } from './helpers';

beforeAll(() => {
  useNodeCrypto();
});

const input = (from: string, to: string): MimeMessageInput => ({
  from: { name: 'Sender Name', email: from },
  to: [{ email: to }],
  subject: 'Grüße aus dem Test',
  textBody: 'Hallo Welt\nzweite Zeile mit Umlaut: äöü',
  htmlBody: '<p>Hallo <b>Welt</b></p>',
  attachments: [{ filename: 'notes.txt', contentType: 'text/plain', content: new TextEncoder().encode('attached bytes') }],
});

const decode = (b: Uint8Array) => new TextDecoder().decode(b);
const encode = (s: string) => new TextEncoder().encode(s);

function pgpAccess(own: Array<{ id: string; publicKey: string; unlocked?: openpgp.PrivateKey }>, publics: string[]): SecureKeyAccess {
  return {
    pgpDecryptionKeys: () => own.flatMap((k) => (k.unlocked ? [k.unlocked] : [])),
    pgpOwnKeys: () => own.map((k) => ({ id: k.id, publicKeyArmored: k.publicKey, unlocked: !!k.unlocked })),
    pgpPublicKeys: () => publics,
    smimeKeys: () => [],
  };
}

describe('PGP/MIME', () => {
  let alice: Awaited<ReturnType<typeof makePgpKey>>;
  let bob: Awaited<ReturnType<typeof makePgpKey>>;

  beforeAll(async () => {
    alice = await makePgpKey('alice@example.org');
    bob = await makePgpKey('bob@example.org', 'bobs pass', 'rsa');
  }, 60_000);

  it('a signed and encrypted message decrypts for the recipient with a valid signature', async () => {
    const raw = await buildSecureMessage(input(alice.email, bob.email), { mode: 'pgp', sign: true, encrypt: true }, {
      pgp: { signingKey: alice.unlocked, encryptionKeys: [bob.publicKey, alice.publicKey] },
    });
    const text = decode(raw);
    expect(text).toMatch(/Content-Type: multipart\/encrypted; protocol="application\/pgp-encrypted";/);
    expect(text).not.toContain('Hallo Welt');
    expect(text).not.toMatch(/^Bcc:/m);

    const res = await openSecureMessage(raw, alice.email, pgpAccess([{ id: 'bob', publicKey: bob.publicKey, unlocked: bob.unlocked }], [alice.publicKey]));
    expect(res?.status).toMatchObject({ kind: 'pgp', encrypted: true, decrypted: true, signature: 'valid', signerEmail: alice.email });
    expect(res?.body?.html).toContain('<b>Welt</b>');
    expect(res?.body?.text).toContain('äöü');
    expect(res?.attachments.map((a) => [a.name, decode(a.bytes)])).toEqual([['notes.txt', 'attached bytes']]);
  }, 60_000);

  it('the sender can read their own Sent copy (encrypt-to-self)', async () => {
    const raw = await buildSecureMessage(input(alice.email, bob.email), { mode: 'pgp', sign: false, encrypt: true }, {
      pgp: { encryptionKeys: [bob.publicKey, alice.publicKey] },
    });
    const res = await openSecureMessage(raw, alice.email, pgpAccess([{ id: 'alice', publicKey: alice.publicKey, unlocked: alice.unlocked }], []));
    expect(res?.status).toMatchObject({ decrypted: true, signature: 'none' });
  }, 30_000);

  it('asks to unlock when the key it is encrypted to is locked, and says so when no key fits', async () => {
    const raw = await buildSecureMessage(input(alice.email, bob.email), { mode: 'pgp', sign: false, encrypt: true }, {
      pgp: { encryptionKeys: [bob.publicKey] },
    });
    const locked = await openSecureMessage(raw, alice.email, pgpAccess([{ id: 'bob', publicKey: bob.publicKey }], []));
    expect(locked?.status).toMatchObject({ encrypted: true, decrypted: false, lockedKeyIds: ['bob'] });
    expect(locked?.body).toBeNull();

    const none = await openSecureMessage(raw, alice.email, pgpAccess([{ id: 'alice', publicKey: alice.publicKey, unlocked: alice.unlocked }], []));
    expect(none?.status).toMatchObject({ encrypted: true, decrypted: false, noKey: true });
  }, 30_000);

  it('a signed message verifies, and fails once a byte of the signed part changes', async () => {
    const raw = await buildSecureMessage(input(alice.email, bob.email), { mode: 'pgp', sign: true, encrypt: false }, {
      pgp: { signingKey: alice.unlocked },
    });
    const text = decode(raw);
    expect(text).toMatch(/multipart\/signed; micalg="pgp-sha256"; protocol="application\/pgp-signature";/);
    const access = pgpAccess([], [alice.publicKey]);
    const ok = await openSecureMessage(raw, alice.email, access);
    expect(ok?.status).toMatchObject({ signature: 'valid', signerEmail: alice.email, encrypted: false });
    expect(ok?.body?.text).toContain('Hallo Welt');

    const tampered = encode(text.replace('Hallo Welt', 'Hallo Wels'));
    const bad = await openSecureMessage(tampered, alice.email, access);
    expect(bad?.status.signature).toBe('invalid');

    const unknown = await openSecureMessage(raw, alice.email, pgpAccess([], []));
    expect(unknown?.status.signature).toBe('unknown');
  }, 30_000);

  it('flags a signature by a key whose address is not the From address', async () => {
    const raw = await buildSecureMessage(input(alice.email, bob.email), { mode: 'pgp', sign: true, encrypt: false }, {
      pgp: { signingKey: alice.unlocked },
    });
    const res = await openSecureMessage(raw, 'mallory@example.org', pgpAccess([], [alice.publicKey]));
    expect(res?.status).toMatchObject({ signature: 'valid', signerMismatch: true });
  }, 30_000);

  it('reads inline PGP: an encrypted body and a cleartext-signed one, even quoted-printable', async () => {
    const armored = await openpgp.encrypt({ message: await openpgp.createMessage({ text: 'inline secret' }), encryptionKeys: await openpgp.readKey({ armoredKey: bob.publicKey }) });
    const inlineEnc = encode(`From: ${alice.email}\r\nSubject: x\r\nContent-Type: text/plain\r\n\r\n${armored}`);
    const enc = await openSecureMessage(inlineEnc, alice.email, pgpAccess([{ id: 'bob', publicKey: bob.publicKey, unlocked: bob.unlocked }], []));
    expect(enc?.status).toMatchObject({ decrypted: true });
    expect(enc?.body?.text).toBe('inline secret');

    const signed = await openpgp.sign({ message: await openpgp.createCleartextMessage({ text: 'signed in the clear' }), signingKeys: alice.unlocked });
    const qp = (signed as string).replace(/=/g, '=3D').replace(/\r?\n/g, '\r\n');
    const inlineSigned = encode(`From: ${alice.email}\r\nContent-Type: text/plain\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n${qp}`);
    const sig = await openSecureMessage(inlineSigned, alice.email, pgpAccess([], [alice.publicKey]));
    expect(sig?.status).toMatchObject({ signature: 'valid', signerEmail: alice.email });
    expect(sig?.body?.text).toBe('signed in the clear');
  }, 30_000);

  it('leaves ordinary mail alone', async () => {
    const plain = encode('From: a@example.org\r\nContent-Type: text/plain\r\n\r\nnothing to see');
    expect(await openSecureMessage(plain, 'a@example.org', pgpAccess([], []))).toBeNull();
  });
});

describe('S/MIME', () => {
  let alice: TestCert;
  let bob: TestCert;

  function smimeAccess(keys: Array<{ cert: TestCert; unlocked: boolean }>): SecureKeyAccess {
    return {
      pgpDecryptionKeys: () => [],
      pgpOwnKeys: () => [],
      pgpPublicKeys: () => [],
      smimeKeys: () => keys.map((k) => ({ id: k.cert.email, certificate: k.cert.certificate, ...(k.unlocked ? { pkcs8: k.cert.pkcs8 } : {}) })),
    };
  }

  beforeAll(async () => {
    alice = await makeSmimeCert('alice@example.org');
    bob = await makeSmimeCert('bob@example.org');
  }, 60_000);

  const signer = (c: TestCert) => ({ pkcs8: c.pkcs8, certificate: c.certificate, chain: [], algorithm: 'RSA-2048' });

  it('a detached-signed message verifies and names the signer; a changed byte fails it', async () => {
    const raw = await buildSecureMessage(input(alice.email, bob.email), { mode: 'smime', sign: true, encrypt: false }, { smime: { signer: signer(alice) } });
    const text = decode(raw);
    expect(text).toMatch(/multipart\/signed; protocol="application\/pkcs7-signature";/);
    const ok = await openSecureMessage(raw, alice.email, smimeAccess([]));
    expect(ok?.status).toMatchObject({ kind: 'smime', signature: 'valid', signerEmail: alice.email, selfSigned: true, encrypted: false });
    expect(ok?.body?.html).toContain('<b>Welt</b>');

    const bad = await openSecureMessage(encode(text.replace('Hallo Welt', 'Hallo Wels')), alice.email, smimeAccess([]));
    expect(bad?.status.signature).toBe('invalid');
    expect(bad?.status.error).toMatch(/digest|does not match/i);
  }, 30_000);

  it('a signed and encrypted message decrypts for the recipient and verifies the inner signature', async () => {
    const raw = await buildSecureMessage(input(alice.email, bob.email), { mode: 'smime', sign: true, encrypt: true }, {
      smime: { signer: signer(alice), recipientCerts: [bob.certificate], senderCert: alice.certificate },
    });
    const text = decode(raw);
    expect(text).toMatch(/application\/pkcs7-mime; smime-type=enveloped-data/);
    expect(text).not.toContain('Hallo');

    const res = await openSecureMessage(raw, alice.email, smimeAccess([{ cert: bob, unlocked: true }]));
    expect(res?.status).toMatchObject({ encrypted: true, decrypted: true, signature: 'valid', signerEmail: alice.email });
    expect(res?.body?.text).toContain('äöü');
    expect(res?.attachments.map((a) => a.name)).toEqual(['notes.txt']);

    // The sender's own copy.
    const own = await openSecureMessage(raw, alice.email, smimeAccess([{ cert: alice, unlocked: true }]));
    expect(own?.status.decrypted).toBe(true);
  }, 30_000);

  it('reports a locked key and a message no key of ours can open', async () => {
    const raw = await buildSecureMessage(input(alice.email, bob.email), { mode: 'smime', sign: false, encrypt: true }, {
      smime: { recipientCerts: [bob.certificate], senderCert: bob.certificate },
    });
    const locked = await openSecureMessage(raw, alice.email, smimeAccess([{ cert: bob, unlocked: false }]));
    expect(locked?.status).toMatchObject({ encrypted: true, decrypted: false, lockedKeyIds: [bob.email] });
    const none = await openSecureMessage(raw, alice.email, smimeAccess([{ cert: alice, unlocked: true }]));
    expect(none?.status).toMatchObject({ noKey: true, decrypted: false });
  }, 30_000);

  it('writes AES-256-CBC EnvelopedData, which other clients read', async () => {
    const { parseEntity, bytesToBinary, decodeBody } = await import('../mime');
    const pkijs = await import('pkijs');
    const asn1js = await import('asn1js');
    const raw = await buildSecureMessage(input(alice.email, bob.email), { mode: 'smime', sign: false, encrypt: true }, {
      smime: { recipientCerts: [bob.certificate], senderCert: alice.certificate },
    });
    const der = decodeBody(parseEntity(bytesToBinary(raw)));
    const ci = new pkijs.ContentInfo({ schema: asn1js.fromBER(der.slice().buffer).result });
    const env = new pkijs.EnvelopedData({ schema: ci.content });
    expect(env.encryptedContentInfo.contentEncryptionAlgorithm.algorithmId).toBe('2.16.840.1.101.3.4.1.42');
    expect(env.recipientInfos).toHaveLength(2);
  }, 30_000);
});

describe('secureKindHint', () => {
  it('spots PGP and S/MIME from the structure or the text, without a download', () => {
    expect(secureKindHint({ bodyStructure: { type: 'multipart/encrypted', subParts: [{ type: 'application/pgp-encrypted' }] } as never })).toBe('pgp');
    expect(secureKindHint({ bodyStructure: { type: 'multipart/signed', subParts: [{ type: 'text/plain' }, { type: 'application/pkcs7-signature' }] } as never })).toBe('smime');
    expect(secureKindHint({ bodyStructure: { type: 'application/pkcs7-mime' } as never })).toBe('smime');
    expect(secureKindHint({ preview: '-----BEGIN PGP MESSAGE----- hQEM' } as never)).toBe('pgp');
    expect(secureKindHint({ bodyStructure: { type: 'text/plain' } as never, preview: 'hello' } as never)).toBeNull();
  });
});
