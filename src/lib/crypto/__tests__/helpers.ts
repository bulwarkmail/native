// Throwaway keys and certificates for the PGP / S/MIME tests (#58), made
// fresh in each run. Nothing here belongs to a real person.
import * as nodeCrypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import * as openpgp from 'openpgp';
import { setNodeStyleCrypto, type NodeStyleCrypto } from '../provider';
import { resetSmimeEngine } from '../smime/engine';

/** Node's crypto stands in for react-native-quick-crypto. */
export function useNodeCrypto(): void {
  setNodeStyleCrypto(() => nodeCrypto as unknown as NodeStyleCrypto);
  resetSmimeEngine();
}

export interface TestCert {
  email: string;
  certificate: Uint8Array;
  pkcs8: Uint8Array;
  keyPem: string;
  certPem: string;
}

const engine = () => new pkijs.CryptoEngine({ name: 'test', crypto: globalThis.crypto });

/** A self-signed RSA-2048 S/MIME certificate for `email`. */
export async function makeSmimeCert(email: string, opts: { notAfter?: Date } = {}): Promise<TestCert> {
  const subtle = globalThis.crypto.subtle;
  const keys = await subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  ) as CryptoKeyPair;
  const cert = new pkijs.Certificate();
  cert.version = 2;
  cert.serialNumber = new asn1js.Integer({ value: Math.floor(Math.random() * 1e9) + 1 });
  const name = () => [
    new pkijs.AttributeTypeAndValue({ type: '2.5.4.3', value: new asn1js.Utf8String({ value: `Test ${email}` }) }),
    new pkijs.AttributeTypeAndValue({ type: '1.2.840.113549.1.9.1', value: new asn1js.IA5String({ value: email }) }),
  ];
  cert.subject.typesAndValues.push(...name());
  cert.issuer.typesAndValues.push(...name());
  cert.notBefore.value = new Date(Date.now() - 86400_000);
  cert.notAfter.value = opts.notAfter ?? new Date(Date.now() + 365 * 86400_000);
  // keyUsage: digitalSignature + keyEncipherment; SAN rfc822Name.
  const ku = new asn1js.BitString({ valueHex: new Uint8Array([0xa0]).buffer, unusedBits: 5 });
  cert.extensions = [
    new pkijs.Extension({ extnID: '2.5.29.15', critical: true, extnValue: ku.toBER(false), parsedValue: ku }),
    new pkijs.Extension({
      extnID: '2.5.29.17',
      extnValue: new pkijs.GeneralNames({ names: [new pkijs.GeneralName({ type: 1, value: email })] }).toSchema().toBER(false),
    }),
  ];
  await cert.subjectPublicKeyInfo.importKey(keys.publicKey, engine());
  await cert.sign(keys.privateKey, 'SHA-256', engine());
  const der = new Uint8Array(cert.toSchema().toBER(false));
  const pkcs8 = new Uint8Array(await subtle.exportKey('pkcs8', keys.privateKey));
  const pem = (label: string, bytes: Uint8Array) =>
    `-----BEGIN ${label}-----\n${Buffer.from(bytes).toString('base64').replace(/(.{64})/g, '$1\n').trim()}\n-----END ${label}-----\n`;
  return { email, certificate: der, pkcs8, keyPem: pem('PRIVATE KEY', pkcs8), certPem: pem('CERTIFICATE', der) };
}

/** A fresh curve25519 PGP key pair for `email`, protected with `passphrase`. */
export async function makePgpKey(email: string, passphrase = 'secret', type: 'ecc' | 'rsa' = 'ecc') {
  const { privateKey, publicKey } = await openpgp.generateKey({
    ...(type === 'ecc' ? { type: 'ecc' as const, curve: 'curve25519Legacy' as const } : { type: 'rsa' as const, rsaBits: 2048 }),
    userIDs: [{ name: `Test ${email}`, email }],
    passphrase,
    format: 'armored',
  });
  const unlocked = await openpgp.decryptKey({ privateKey: await openpgp.readPrivateKey({ armoredKey: privateKey }), passphrase });
  return { privateKey, publicKey, unlocked, passphrase, email };
}

let opensslChecked: boolean | null = null;
/** Is the openssl CLI there (interop fixtures)? */
export function hasOpenssl(): boolean {
  if (opensslChecked === null) {
    try {
      execFileSync('openssl', ['version'], { stdio: 'pipe' });
      opensslChecked = true;
    } catch {
      opensslChecked = false;
    }
  }
  return opensslChecked;
}

/** Run openssl in a scratch dir with the given input files; returns the named output file. */
export function openssl(args: string[], files: Record<string, string | Uint8Array>, output: string): Uint8Array {
  const dir = mkdtempSync(path.join(tmpdir(), 'bulwark-smime-'));
  try {
    for (const [name, content] of Object.entries(files)) writeFileSync(path.join(dir, name), content);
    execFileSync('openssl', args, { cwd: dir, stdio: 'pipe', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
    return new Uint8Array(readFileSync(path.join(dir, output)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const CRLF_MESSAGE = 'Content-Type: text/plain; charset=utf-8\r\n\r\nHello from the S/MIME test fixture.\r\n';

/** Wrap CMS DER as an S/MIME message the way a client sends it. */
export function smimeMessage(cms: Uint8Array, smimeType: string, from = 'sender@example.org'): Uint8Array {
  const b64 = Buffer.from(cms).toString('base64').replace(/(.{76})/g, '$1\r\n');
  return new TextEncoder().encode(
    `From: ${from}\r\nTo: rcpt@example.org\r\nSubject: test\r\nMIME-Version: 1.0\r\n`
    + `Content-Type: application/pkcs7-mime; smime-type=${smimeType}; name="smime.p7m"\r\n`
    + 'Content-Transfer-Encoding: base64\r\n\r\n'
    + `${b64}\r\n`,
  );
}
