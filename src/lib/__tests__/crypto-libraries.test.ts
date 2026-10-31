// The PGP and S/MIME libraries (#58), installed ahead of the features: each
// one loads and does one basic operation. The same libraries as the webmail's
// plugins (repos/plugins/bulwark-gpg, repos/plugins/smime). This runs under
// Node, which has WebCrypto; on Hermes openpgp and pkijs need a WebCrypto
// subtle installed first (docs in the S/MIME and PGP feature work).
import { describe, it, expect } from 'vitest';
import { webcrypto } from 'node:crypto';
import * as openpgp from 'openpgp';
import * as pkijs from 'pkijs';
import * as asn1js from 'asn1js';
import { Convert } from 'pvtsutils';
// @ts-expect-error The ES build has no typings; the webmail's smime plugin
// imports it the same way, since the "browser" build has no named exports.
import * as liner from 'webcrypto-liner/build/index.es.js';

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

  it('webcrypto-liner adds 3DES, which legacy S/MIME mail still uses', async () => {
    liner.setCrypto(webcrypto);
    const crypto = new liner.Crypto() as Crypto;
    const key = await crypto.subtle.generateKey({ name: 'DES-EDE3-CBC', length: 192 } as unknown as AesKeyGenParams, true, ['encrypt', 'decrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(8));
    const alg = { name: 'DES-EDE3-CBC', iv } as unknown as AesCbcParams;
    const sealed = await crypto.subtle.encrypt(alg, key as CryptoKey, new TextEncoder().encode('legacy'));
    expect(sealed.byteLength).toBe(8);
    const opened = await crypto.subtle.decrypt(alg, key as CryptoKey, sealed);
    expect(new TextDecoder().decode(opened)).toBe('legacy');
  });
});
