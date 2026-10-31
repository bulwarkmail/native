// The PGP and S/MIME libraries (#58), installed ahead of the features: each
// one loads and does one basic operation. The same libraries as the webmail's
// plugins (repos/plugins/bulwark-gpg, repos/plugins/smime). This runs under
// Node, which has WebCrypto; on Hermes the app installs one from
// react-native-quick-crypto (src/lib/crypto/install-webcrypto.ts).
import { describe, it, expect, afterEach } from 'vitest';
import * as nodeCrypto from 'node:crypto';
import { webcrypto } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as openpgp from 'openpgp';
import * as pkijs from 'pkijs';
import * as asn1js from 'asn1js';
import { Convert } from 'pvtsutils';
import { cbcDecrypt, setNodeStyleCrypto, type NodeStyleCrypto } from '../crypto/provider';
import { installWebCrypto } from '../crypto/install-webcrypto';
import { prepareOpenPgp } from '../crypto/openpgp-module';
import { decryptMessage, detachedSign, encryptBytes, verifyDetached } from '../crypto/pgp';
import { useHermesRuntime } from '../crypto/__tests__/hermes-runtime';

const subtle = webcrypto.subtle as unknown as SubtleCrypto;

describe('crypto libraries', () => {
  it('openpgp reads a generated key and round-trips a signed message', async () => {
    const { privateKey, publicKey } = await openpgp.generateKey({
      type: 'ecc',
      curve: 'curve25519Legacy',
      userIDs: [{ name: 'Test', email: 'test@example.org' }],
      format: 'armored',
    });
    const pub = await openpgp.readKey({ armoredKey: publicKey });
    const priv = await openpgp.readPrivateKey({ armoredKey: privateKey });
    expect(pub.getUserIDs()).toEqual(['Test <test@example.org>']);
    expect(pub.getFingerprint()).toBe(priv.getFingerprint());

    const armored = await openpgp.encrypt({
      message: await openpgp.createMessage({ text: 'Grüße' }),
      encryptionKeys: pub,
      signingKeys: priv,
    });
    const { data, signatures } = await openpgp.decrypt({
      message: await openpgp.readMessage({ armoredMessage: armored as string }),
      decryptionKeys: priv,
      verificationKeys: pub,
    });
    expect(data).toBe('Grüße');
    await expect(signatures[0].verified).resolves.toBe(true);
  });

  it('asn1js and pvtsutils encode and decode DER', () => {
    const der = new asn1js.Sequence({ value: [new asn1js.Integer({ value: 42 }), new asn1js.Utf8String({ value: 'ok' })] }).toBER();
    expect(Convert.ToHex(der)).toBe('300702012a0c026f6b');
    const parsed = asn1js.fromBER(der);
    expect(parsed.offset).not.toBe(-1);
    const seq = parsed.result as asn1js.Sequence;
    expect((seq.valueBlock.value[0] as asn1js.Integer).valueBlock.valueDec).toBe(42);
    expect(Convert.ToBase64(Convert.FromHex('00ff'))).toBe('AP8=');
  });

  it('pkijs parses a certificate it signed', async () => {
    const engine = new pkijs.CryptoEngine({ name: 'node', crypto: webcrypto as unknown as Crypto });
    const keys = await subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    );
    const cert = new pkijs.Certificate();
    cert.version = 2;
    cert.serialNumber = new asn1js.Integer({ value: 7 });
    const cn = () => new pkijs.AttributeTypeAndValue({ type: '2.5.4.3', value: new asn1js.Utf8String({ value: 'Test' }) });
    cert.subject.typesAndValues.push(cn());
    cert.issuer.typesAndValues.push(cn());
    cert.notBefore.value = new Date('2026-01-01T00:00:00Z');
    cert.notAfter.value = new Date('2027-01-01T00:00:00Z');
    await cert.subjectPublicKeyInfo.importKey(keys.publicKey, engine);
    await cert.sign(keys.privateKey, 'SHA-256', engine);

    const parsed = pkijs.Certificate.fromBER(cert.toSchema().toBER());
    expect(parsed.serialNumber.valueBlock.valueDec).toBe(7);
    expect((parsed.subject.typesAndValues[0].value.valueBlock as { value: string }).value).toBe('Test');
    await expect(parsed.verify(undefined, engine)).resolves.toBe(true);
  });

  it('3DES, which legacy S/MIME mail still uses, decrypts through the native crypto module', () => {
    setNodeStyleCrypto(() => nodeCrypto as unknown as NodeStyleCrypto);
    const key = nodeCrypto.randomBytes(24);
    const iv = nodeCrypto.randomBytes(8);
    const c = nodeCrypto.createCipheriv('des-ede3-cbc', key, iv);
    const sealed = Buffer.concat([c.update('legacy'), c.final()]);
    expect(sealed.byteLength).toBe(8);
    const opened = cbcDecrypt('des-ede3-cbc', new Uint8Array(key), new Uint8Array(iv), new Uint8Array(sealed));
    expect(new TextDecoder().decode(opened)).toBe('legacy');
  });
});

describe('openpgp on a Hermes-like runtime', () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
  });

  async function roundTrip(pgp: typeof openpgp): Promise<void> {
    for (const keyOptions of [{ type: 'ecc', curve: 'curve25519Legacy' }, { type: 'rsa', rsaBits: 2048 }] as const) {
      const { privateKey, publicKey } = await pgp.generateKey({
        ...keyOptions,
        userIDs: [{ email: 'hermes@example.org' }],
        passphrase: 'pw',
        format: 'armored',
      });
      const priv = await pgp.decryptKey({ privateKey: await pgp.readPrivateKey({ armoredKey: privateKey }), passphrase: 'pw' });
      const pub = await pgp.readKey({ armoredKey: publicKey });
      const armored = await pgp.encrypt({
        message: await pgp.createMessage({ text: 'ohne Streams' }),
        encryptionKeys: pub,
        signingKeys: priv,
      });
      const { data, signatures } = await pgp.decrypt({
        message: await pgp.readMessage({ armoredMessage: armored as string }),
        decryptionKeys: priv,
        verificationKeys: pub,
        expectSigned: true,
      });
      expect(data).toBe('ohne Streams');
      await expect(signatures[0].verified).resolves.toBe(true);

      const signed = await pgp.sign({ message: await pgp.createMessage({ text: 'signiert' }), signingKeys: priv });
      const verified = await pgp.verify({
        message: await pgp.readMessage({ armoredMessage: signed as string }),
        verificationKeys: pub,
        expectSigned: true,
      });
      expect(verified.data).toBe('signiert');
    }
  }

  // Metro bundles openpgp's browser build (metro.config.js), and the app
  // prepares it in loadOpenPgp() (src/lib/crypto/openpgp-module.ts).
  for (const streams of ['expo', 'none'] as const) {
    it(`the browser build Metro bundles encrypts, signs, decrypts and verifies (${streams === 'expo' ? "Expo's stream polyfill" : 'no web streams'}, no Symbol.species, no WebAssembly)`, async () => {
      restore = useHermesRuntime(streams);
      const req = createRequire(import.meta.url);
      const browserBuild = path.join(path.dirname(req.resolve('openpgp')), '..', 'openpgp.min.mjs');
      const pgp = prepareOpenPgp((await import(/* @vite-ignore */ pathToFileURL(browserBuild).href)) as typeof openpgp);
      await roundTrip(pgp);
    }, 60_000);
  }

  it('the app decrypts and verifies a signed message without Symbol.species', async () => {
    const { privateKey, publicKey } = await openpgp.generateKey({
      type: 'ecc',
      curve: 'curve25519Legacy',
      userIDs: [{ email: 'hermes@example.org' }],
      format: 'object',
    });
    restore = useHermesRuntime('expo');
    const data = new TextEncoder().encode('Grüße');
    const armoredMessage = await encryptBytes({ data, recipientPublicKeysArmored: [publicKey.armor()], signingKey: privateKey });
    const opened = await decryptMessage({ armoredMessage, decryptionKeys: [privateKey], verificationKeysArmored: [publicKey.armor()] });
    expect(new TextDecoder().decode(opened.data)).toBe('Grüße');
    expect(opened.signature.status).toBe('valid');
    const armoredSignature = await detachedSign(data, privateKey);
    await expect(verifyDetached({ data, armoredSignature, verificationKeysArmored: [publicKey.armor()] })).resolves.toMatchObject({ status: 'valid' });
  }, 60_000);
});

describe('installWebCrypto', () => {
  it('puts a lazy subtle and getRandomValues on a runtime without crypto', () => {
    const target: Record<string, unknown> = {};
    installWebCrypto(target);
    const crypto = target.crypto as Record<string, unknown>;
    expect(typeof crypto.getRandomValues).toBe('function');
    // The native module loads on first use of subtle, not at install.
    expect(Object.getOwnPropertyDescriptor(crypto, 'subtle')?.get).toBeTypeOf('function');
  });

  it('keeps a crypto that is already there', () => {
    const subtle = {};
    const getRandomValues = () => undefined;
    const target: Record<string, unknown> = { crypto: { subtle, getRandomValues } };
    installWebCrypto(target);
    expect((target.crypto as { subtle: unknown }).subtle).toBe(subtle);
    expect((target.crypto as { getRandomValues: unknown }).getRandomValues).toBe(getRandomValues);
  });
});
