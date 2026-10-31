// pkijs engine for S/MIME (#58). Port of repos/plugins/smime/src/crypto-
// engine.js without webcrypto-liner: WebCrypto comes from the installed
// global (react-native-quick-crypto in the app), and the legacy PKCS#12 PBE
// ciphers (3DES) go through the Node-style crypto module (provider.ts).

import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { cbcDecrypt, toArrayBuffer, webCrypto } from '../provider';

// ── PKCS#12 legacy PBE OIDs ──────────────────────────────────────────
const PBE_SHA1_3DES_3KEY = '1.2.840.113549.1.12.1.3';
const PBE_SHA1_3DES_2KEY = '1.2.840.113549.1.12.1.4';
const PBE_SHA1_RC2_128 = '1.2.840.113549.1.12.1.5';
const PBE_SHA1_RC2_40 = '1.2.840.113549.1.12.1.6';

/** Thrown for a cipher the app can't decrypt; `algorithm` names it for the banner. */
export class UnsupportedAlgorithmError extends Error {
  algorithm: string;
  constructor(algorithm: string) {
    super(`Unsupported encryption algorithm ${algorithm}`);
    this.name = 'UnsupportedAlgorithmError';
    this.algorithm = algorithm;
  }
}

/** PKCS#12 key derivation, RFC 7292 Appendix B (SHA-1). */
async function pkcs12KDF(password: Uint8Array, salt: Uint8Array, iterations: number, id: number, needed: number): Promise<Uint8Array> {
  const subtle = webCrypto().subtle;
  const v = 64;
  const u = 20;
  const D = new Uint8Array(v).fill(id);
  const sLen = salt.length === 0 ? 0 : v * Math.ceil(salt.length / v);
  const S = new Uint8Array(sLen);
  for (let i = 0; i < sLen; i++) S[i] = salt[i % salt.length];
  const pLen = password.length === 0 ? 0 : v * Math.ceil(password.length / v);
  const P = new Uint8Array(pLen);
  for (let i = 0; i < pLen; i++) P[i] = password[i % password.length];
  const I = new Uint8Array(sLen + pLen);
  I.set(S, 0);
  I.set(P, sLen);
  const c = Math.ceil(needed / u);
  const result = new Uint8Array(c * u);
  for (let i = 0; i < c; i++) {
    const buf = new Uint8Array(v + I.length);
    buf.set(D, 0);
    buf.set(I, v);
    let A = new Uint8Array(await subtle.digest('SHA-1', buf));
    for (let j = 1; j < iterations; j++) A = new Uint8Array(await subtle.digest('SHA-1', A));
    result.set(A, i * u);
    if (i + 1 < c) {
      const B = new Uint8Array(v);
      for (let j = 0; j < v; j++) B[j] = A[j % u];
      for (let j = 0; j < I.length; j += v) {
        let carry = 1;
        for (let k = v - 1; k >= 0; k--) {
          const sum = I[j + k] + B[k] + carry;
          I[j + k] = sum & 0xff;
          carry = sum >> 8;
        }
      }
    }
  }
  return result.slice(0, needed);
}

/** BMPString password with the trailing NUL pair (RFC 7292 §B.1). */
function passwordToBMP(password: ArrayBuffer): Uint8Array {
  const p = new Uint8Array(password);
  const bmp = new Uint8Array(p.length * 2 + 2);
  for (let i = 0; i < p.length; i++) bmp[i * 2 + 1] = p[i];
  return bmp;
}

/** 2-key 3DES (K1 K2 K1) as the 24-byte key OpenSSL's des-ede3-cbc takes. */
function expand3DesKey(key: Uint8Array): Uint8Array {
  if (key.length === 24) return key;
  const out = new Uint8Array(24);
  out.set(key.subarray(0, 16), 0);
  out.set(key.subarray(0, 8), 16);
  return out;
}

class AppCryptoEngine extends pkijs.CryptoEngine {
  // pkijs only decrypts PBES2; many .p12 files (Windows, OpenSSL 1.x, macOS)
  // protect their bags with the PKCS#12 SHA-1 + 3DES scheme.
  override async decryptEncryptedContentInfo(parameters: pkijs.CryptoEngineDecryptParams): Promise<ArrayBuffer> {
    const oid = parameters.encryptedContentInfo.contentEncryptionAlgorithm.algorithmId;
    if (oid === PBE_SHA1_RC2_128 || oid === PBE_SHA1_RC2_40) throw new UnsupportedAlgorithmError('RC2-CBC');
    if (oid !== PBE_SHA1_3DES_3KEY && oid !== PBE_SHA1_3DES_2KEY) return super.decryptEncryptedContentInfo(parameters);

    const algParams = parameters.encryptedContentInfo.contentEncryptionAlgorithm.algorithmParams;
    if (!algParams) throw new Error('Missing PBE algorithm parameters');
    const seq = asn1js.fromBER((algParams as asn1js.BaseBlock).toBER(false)).result as asn1js.Sequence;
    const salt = new Uint8Array((seq.valueBlock.value[0] as asn1js.OctetString).valueBlock.valueHexView);
    const iterations = (seq.valueBlock.value[1] as asn1js.Integer).valueBlock.valueDec;
    const keyLen = oid === PBE_SHA1_3DES_3KEY ? 24 : 16;
    const bmp = passwordToBMP(parameters.password);
    const key = await pkcs12KDF(bmp, salt, iterations, 1, keyLen);
    const iv = await pkcs12KDF(bmp, salt, iterations, 2, 8);
    const ciphertext = new Uint8Array(parameters.encryptedContentInfo.getEncryptedContent());
    return toArrayBuffer(cbcDecrypt('des-ede3-cbc', expand3DesKey(key), iv, ciphertext));
  }
}

let engine: AppCryptoEngine | null = null;

/** The pkijs engine (also set as pkijs' global engine, which some of its paths read). */
export function smimeEngine(): pkijs.CryptoEngine {
  if (!engine) {
    engine = new AppCryptoEngine({ name: 'app', crypto: webCrypto() });
    pkijs.setEngine('app', engine);
  }
  return engine;
}

/** For tests: forget the engine so the next call picks up a new global crypto. */
export function resetSmimeEngine(): void {
  engine = null;
}
