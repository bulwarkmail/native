// S/MIME against another implementation (#58): OpenSSL writes the mail
// other clients send (Thunderbird and Outlook use RSA PKCS#1 v1.5 key
// transport, old ones 3DES; Stalwart's encryption at rest writes
// AuthEnvelopedData) and the .p12 files people export, and it must read
// what the app sends. Needs the openssl CLI (skipped without it). The
// ChaCha20-Poly1305 message, which OpenSSL can't write, is built here the
// way Stalwart builds it (port of the smime plugin's test helper).
import { beforeAll, describe, expect, it } from 'vitest';
import * as nodeCrypto from 'node:crypto';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { openPkcs12, Pkcs12PasswordError } from '../smime/pkcs12';
import { smimeDecrypt, SmimeKeyLockedError, UnsupportedAlgorithmError } from '../smime/cms';
import { openSecureMessage, type SecureKeyAccess } from '../secure-message';
import { buildSecureMessage } from '../secure-send';
import { CRLF_MESSAGE, hasOpenssl, makeSmimeCert, openssl, smimeMessage, useNodeCrypto, type TestCert } from './helpers';

const HAVE = hasOpenssl();
const PLAINTEXT = 'Hello from the S/MIME test fixture.';
const decode = (b: Uint8Array) => new TextDecoder().decode(b);

let cert: TestCert;
const material = (unlocked = true) => [{ id: 'me', certificate: cert.certificate, ...(unlocked ? { pkcs8: cert.pkcs8 } : {}) }];

beforeAll(async () => {
  useNodeCrypto();
  cert = await makeSmimeCert('smime-test@example.org');
}, 60_000);

function encryptWithOpenssl(args: string[]): Uint8Array {
  return openssl(['cms', '-encrypt', '-binary', '-outform', 'DER', '-in', 'plain.eml', '-out', 'out.p7m', ...args], { 'plain.eml': CRLF_MESSAGE, 'cert.pem': cert.certPem }, 'out.p7m');
}

describe.skipIf(!HAVE)('decrypting what OpenSSL writes', () => {
  it('AES-256-CBC with the key wrapped by RSA PKCS#1 v1.5 (Thunderbird, Outlook, Stalwart AES-CBC)', async () => {
    const cms = encryptWithOpenssl(['-aes256', 'cert.pem']);
    expect(decode((await smimeDecrypt(cms, material())).mimeBytes)).toContain(PLAINTEXT);
  });

  it('3DES (old Outlook)', async () => {
    const cms = encryptWithOpenssl(['-des3', 'cert.pem']);
    expect(decode((await smimeDecrypt(cms, material())).mimeBytes)).toContain(PLAINTEXT);
  });

  it('RSA-OAEP with SHA-1 in EnvelopedData (the plugin read it with SHA-256 and failed)', async () => {
    const cms = encryptWithOpenssl(['-aes128', '-recip', 'cert.pem', '-keyopt', 'rsa_padding_mode:oaep']);
    expect(decode((await smimeDecrypt(cms, material())).mimeBytes)).toContain(PLAINTEXT);
  });

  it('AuthEnvelopedData with AES-256-GCM and RSA-OAEP SHA-256 (Stalwart AES-256-GCM at rest)', async () => {
    const cms = encryptWithOpenssl(['-aes-256-gcm', '-recip', 'cert.pem', '-keyopt', 'rsa_padding_mode:oaep', '-keyopt', 'rsa_oaep_md:sha256', '-keyopt', 'rsa_mgf1_md:sha256']);
    const res = await openSecureMessage(smimeMessage(cms, 'authEnveloped-data'), undefined, access(material()));
    expect(res?.status).toMatchObject({ encrypted: true, decrypted: true });
    expect(res?.body?.text).toContain(PLAINTEXT);
  });

  it('says the key is locked rather than failing', async () => {
    const cms = encryptWithOpenssl(['-aes256', 'cert.pem']);
    await expect(smimeDecrypt(cms, material(false))).rejects.toBeInstanceOf(SmimeKeyLockedError);
  });

  it('names RC2, which it cannot read', async () => {
    let cms: Uint8Array;
    try {
      cms = encryptWithOpenssl(['-rc2-128', '-provider', 'legacy', '-provider', 'default', 'cert.pem']);
    } catch {
      return; // no legacy provider in this OpenSSL
    }
    await expect(smimeDecrypt(cms, material())).rejects.toMatchObject({ name: 'UnsupportedAlgorithmError', algorithm: 'RC2-CBC' });
  });
});

describe.skipIf(!HAVE)('opening .p12 files', () => {
  const files = () => ({ 'cert.pem': cert.certPem, 'key.pem': cert.keyPem });

  it('reads an OpenSSL 3 default export (PBES2 / AES-256-CBC)', async () => {
    const p12 = openssl(['pkcs12', '-export', '-in', 'cert.pem', '-inkey', 'key.pem', '-out', 'out.p12', '-passout', 'pass:fixture'], files(), 'out.p12');
    const opened = await openPkcs12(p12, 'fixture');
    expect(opened.info.emailAddresses).toEqual(['smime-test@example.org']);
    expect(opened.info.capabilities).toEqual({ canSign: true, canEncrypt: true });
    expect(Buffer.from(opened.certificate).equals(Buffer.from(cert.certificate))).toBe(true);
    // The key it returns decrypts mail to the certificate.
    const cms = encryptWithOpenssl(['-aes256', 'cert.pem']);
    const res = await smimeDecrypt(cms, [{ id: 'me', certificate: opened.certificate, pkcs8: opened.pkcs8 }]);
    expect(decode(res.mimeBytes)).toContain(PLAINTEXT);
  }, 30_000);

  it('reads a legacy SHA-1 + 3DES export (Windows, macOS, OpenSSL 1.x)', async () => {
    const p12 = openssl(['pkcs12', '-export', '-in', 'cert.pem', '-inkey', 'key.pem', '-out', 'out.p12', '-passout', 'pass:fixture',
      '-keypbe', 'PBE-SHA1-3DES', '-certpbe', 'PBE-SHA1-3DES', '-macalg', 'sha1'], files(), 'out.p12');
    const opened = await openPkcs12(p12, 'fixture');
    expect(opened.info.emailAddresses).toEqual(['smime-test@example.org']);
    expect(opened.pkcs8.byteLength).toBeGreaterThan(1000);
  }, 30_000);

  it('refuses a wrong password', async () => {
    const p12 = openssl(['pkcs12', '-export', '-in', 'cert.pem', '-inkey', 'key.pem', '-out', 'out.p12', '-passout', 'pass:fixture'], files(), 'out.p12');
    await expect(openPkcs12(p12, 'wrong')).rejects.toBeInstanceOf(Pkcs12PasswordError);
  }, 30_000);
});

describe.skipIf(!HAVE)('OpenSSL reads what the app sends', () => {
  let rcpt: TestCert;
  beforeAll(async () => {
    rcpt = await makeSmimeCert('rcpt@example.org');
  }, 60_000);

  const input = () => ({ from: { email: cert.email }, to: [{ email: rcpt.email }], subject: 'interop', textBody: 'interop body' });

  it('verifies the detached signature', async () => {
    const raw = await buildSecureMessage(input(), { mode: 'smime', sign: true, encrypt: false }, {
      smime: { signer: { pkcs8: cert.pkcs8, certificate: cert.certificate, chain: [], algorithm: 'RSA-2048' } },
    });
    const out = openssl(['cms', '-verify', '-noverify', '-in', 'msg.eml', '-out', 'out.txt'], { 'msg.eml': raw }, 'out.txt');
    expect(decode(out)).toContain('interop body');
  });

  it('decrypts the encrypted message and verifies the signature inside', async () => {
    const raw = await buildSecureMessage(input(), { mode: 'smime', sign: true, encrypt: true }, {
      smime: { signer: { pkcs8: cert.pkcs8, certificate: cert.certificate, chain: [], algorithm: 'RSA-2048' }, recipientCerts: [rcpt.certificate], senderCert: cert.certificate },
    });
    const inner = openssl(['cms', '-decrypt', '-in', 'msg.eml', '-recip', 'rcpt.pem', '-inkey', 'rcpt.key', '-out', 'inner.eml'],
      { 'msg.eml': raw, 'rcpt.pem': rcpt.certPem, 'rcpt.key': rcpt.keyPem }, 'inner.eml');
    const out = openssl(['cms', '-verify', '-noverify', '-in', 'inner.eml', '-out', 'out.txt'], { 'inner.eml': inner }, 'out.txt');
    expect(decode(out)).toContain('interop body');
  });
});

// ── ChaCha20-Poly1305 AuthEnvelopedData, built the way Stalwart does ──

function access(smime: Array<{ id: string; certificate: Uint8Array; pkcs8?: Uint8Array }>): SecureKeyAccess {
  return { pgpDecryptionKeys: () => [], pgpOwnKeys: () => [], pgpPublicKeys: () => [], smimeKeys: () => smime };
}

async function chachaAuthEnveloped(recipient: TestCert, plaintext: Uint8Array, tamper = false): Promise<Uint8Array> {
  const oid = (value: string) => new asn1js.ObjectIdentifier({ value });
  const alg = (id: string, params?: asn1js.BaseBlock) => new asn1js.Sequence({ value: [oid(id), ...(params ? [params] : [])] });
  const explicit = (tagNumber: number, value: asn1js.BaseBlock) => new asn1js.Constructed({ idBlock: { tagClass: 3, tagNumber }, value: [value] });
  const key = nodeCrypto.randomBytes(32);
  const nonce = nodeCrypto.randomBytes(12);
  const c = nodeCrypto.createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
  const ciphertext = Buffer.concat([c.update(plaintext), c.final()]);
  const mac = c.getAuthTag();
  if (tamper) mac[0] ^= 1;
  const rcptCert = new pkijs.Certificate({ schema: asn1js.fromBER(recipient.certificate.slice().buffer).result });
  const pub = nodeCrypto.createPublicKey({ key: Buffer.from(recipient.certPem), format: 'pem' });
  const wrapped = nodeCrypto.publicEncrypt({ key: pub, padding: nodeCrypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key);
  const sha256 = alg('2.16.840.1.101.3.4.2.1', new asn1js.Null());
  const ktri = new asn1js.Sequence({
    value: [
      new asn1js.Integer({ value: 0 }),
      new asn1js.Sequence({ value: [rcptCert.issuer.toSchema(), rcptCert.serialNumber] }),
      alg('1.2.840.113549.1.1.7', new asn1js.Sequence({ value: [explicit(0, sha256), explicit(1, alg('1.2.840.113549.1.1.8', sha256))] })),
      new asn1js.OctetString({ valueHex: wrapped }),
    ],
  });
  const eci = new asn1js.Sequence({
    value: [
      oid('1.2.840.113549.1.7.1'),
      alg('1.2.840.113549.1.9.16.3.18', new asn1js.OctetString({ valueHex: nonce })),
      new asn1js.Primitive({ idBlock: { tagClass: 3, tagNumber: 0 }, valueHex: ciphertext }),
    ],
  });
  const aed = new asn1js.Sequence({ value: [new asn1js.Integer({ value: 0 }), new asn1js.Set({ value: [ktri] }), eci, new asn1js.OctetString({ valueHex: mac })] });
  return new Uint8Array(new asn1js.Sequence({ value: [oid('1.2.840.113549.1.9.16.1.23'), explicit(0, aed)] }).toBER(false));
}

describe('ChaCha20-Poly1305 (Stalwart encryption at rest)', () => {
  it('decrypts, and refuses a message whose tag was changed', async () => {
    const plaintext = new TextEncoder().encode(CRLF_MESSAGE);
    const ok = await smimeDecrypt(await chachaAuthEnveloped(cert, plaintext), material());
    expect(decode(ok.mimeBytes)).toContain(PLAINTEXT);
    await expect(smimeDecrypt(await chachaAuthEnveloped(cert, plaintext, true), material())).rejects.toThrow(/Failed to decrypt/);
  }, 30_000);

  it('reads Stalwart\'s smime-type spelling in a full message', async () => {
    const cms = await chachaAuthEnveloped(cert, new TextEncoder().encode(CRLF_MESSAGE));
    const res = await openSecureMessage(smimeMessage(cms, 'authenticated-enveloped-data'), undefined, access(material()));
    expect(res?.status).toMatchObject({ encrypted: true, decrypted: true });
    expect(res?.body?.text).toContain(PLAINTEXT);
  }, 30_000);

  it('is not mistaken for an unsupported algorithm', () => {
    expect(new UnsupportedAlgorithmError('X').algorithm).toBe('X');
  });
});
