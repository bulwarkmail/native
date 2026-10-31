// CMS for S/MIME (#58): decrypt (EnvelopedData and AuthEnvelopedData),
// verify (opaque and detached), sign (opaque and detached) and encrypt.
// Ports of repos/plugins/smime/src/{smime-decrypt,auth-enveloped,smime-
// verify,smime-sign,smime-encrypt}.js (plugin 1.4.1).
//
// Decryption unwraps the content key itself instead of handing the whole
// structure to pkijs + webcrypto-liner: RSA-OAEP with any of its hashes
// through WebCrypto, RSAES-PKCS1-v1_5 through the native module, and the
// content through WebCrypto (AES-CBC, AES-GCM) or the native module (3DES,
// ChaCha20-Poly1305). That covers what the plugin reads, plus RSA-OAEP with
// SHA-1 in EnvelopedData, which the plugin's pkijs path got wrong.

import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { cbcDecrypt, chacha20Poly1305Decrypt, concatBytes, rsaPkcs1Decrypt, toArrayBuffer, webCrypto } from '../provider';
import { smimeEngine, UnsupportedAlgorithmError } from './engine';
import { extractCertificateInfo, parseCertificateDer } from './certificate';

export { UnsupportedAlgorithmError };

const OID_DATA = '1.2.840.113549.1.7.1';
const OID_SIGNED_DATA = '1.2.840.113549.1.7.2';
const OID_ENVELOPED_DATA = '1.2.840.113549.1.7.3';
export const OID_AUTH_ENVELOPED_DATA = '1.2.840.113549.1.9.16.1.23';

const OID_RSA_ENCRYPTION = '1.2.840.113549.1.1.1';
const OID_RSAES_OAEP = '1.2.840.113549.1.1.7';
const OID_MGF1 = '1.2.840.113549.1.1.8';
const OID_P_SPECIFIED = '1.2.840.113549.1.1.9';

const HASHES: Record<string, string> = {
  '1.3.14.3.2.26': 'SHA-1',
  '2.16.840.1.101.3.4.2.1': 'SHA-256',
  '2.16.840.1.101.3.4.2.2': 'SHA-384',
  '2.16.840.1.101.3.4.2.3': 'SHA-512',
};

const ALGORITHM_NAMES: Record<string, string> = {
  '1.2.840.113549.3.2': 'RC2-CBC',
  '1.3.14.3.2.7': 'DES-CBC',
  '2.16.840.1.101.3.4.1.7': 'AES-128-CCM',
  '2.16.840.1.101.3.4.1.27': 'AES-192-CCM',
  '2.16.840.1.101.3.4.1.47': 'AES-256-CCM',
  '1.2.392.200011.61.1.1.1.2': 'Camellia-128-CBC',
  '1.2.392.200011.61.1.1.1.3': 'Camellia-192-CBC',
  '1.2.392.200011.61.1.1.1.4': 'Camellia-256-CBC',
};

function unsupported(oidOrName: string): UnsupportedAlgorithmError {
  return new UnsupportedAlgorithmError(ALGORITHM_NAMES[oidOrName] || oidOrName);
}

/** The key is there but not unlocked; the UI asks for the passphrase. */
export class SmimeKeyLockedError extends Error {
  constructor() {
    super('S/MIME key is locked. Unlock it to decrypt this message.');
    this.name = 'SmimeKeyLockedError';
  }
}

export class SmimeNoMatchingKeyError extends Error {
  constructor() {
    super('No imported S/MIME key matches any recipient in this encrypted message');
    this.name = 'SmimeNoMatchingKeyError';
  }
}

/** A private key the app holds: its certificate, and the PKCS#8 when unlocked. */
export interface SmimeKeyMaterial {
  id: string;
  certificate: Uint8Array;
  pkcs8?: Uint8Array;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

const isContext = (el: unknown, n: number): el is asn1js.Constructed =>
  !!el && (el as asn1js.BaseBlock).idBlock?.tagClass === 3 && (el as asn1js.BaseBlock).idBlock?.tagNumber === n;

function parseContentInfo(der: Uint8Array): pkijs.ContentInfo {
  const asn1 = asn1js.fromBER(toArrayBuffer(der));
  if (asn1.offset === -1) throw new Error('Invalid ASN.1 data - cannot parse CMS structure');
  try {
    return new pkijs.ContentInfo({ schema: asn1.result });
  } catch {
    throw new Error('Invalid ASN.1 data - cannot parse CMS structure');
  }
}

// ── Envelopes ────────────────────────────────────────────────────────

interface Envelope {
  recipientInfos: pkijs.RecipientInfo[];
  encryptedContentInfo: pkijs.EncryptedContentInfo;
  /** AuthEnvelopedData only. */
  mac?: Uint8Array;
  aad?: Uint8Array;
}

/** AuthEnvelopedData (RFC 5083); pkijs has no class for it. */
function parseAuthEnvelopedData(schema: unknown): Envelope {
  const items = schema instanceof asn1js.Sequence ? schema.valueBlock.value : [];
  let i = 0;
  if (!(items[i++] instanceof asn1js.Integer)) throw new Error('Invalid AuthEnvelopedData: no version');
  if (isContext(items[i], 0)) i++; // originatorInfo
  const recipientSet = items[i++];
  if (!(recipientSet instanceof asn1js.Set)) throw new Error('Invalid AuthEnvelopedData: no recipientInfos');
  const recipientInfos = recipientSet.valueBlock.value.map((el) => new pkijs.RecipientInfo({ schema: el }));
  const encryptedContentInfo = new pkijs.EncryptedContentInfo({ schema: items[i++] });
  // The MAC covers the authenticated attributes as DER with the SET OF tag,
  // not the [1] they are sent with (RFC 5083 §2.2).
  let aad: Uint8Array | undefined;
  if (isContext(items[i], 1)) {
    aad = new Uint8Array(items[i++].valueBeforeDecodeView);
    aad[0] = 0x31;
  }
  const mac = items[i++];
  if (!(mac instanceof asn1js.OctetString)) throw new Error('Invalid AuthEnvelopedData: no mac');
  return { recipientInfos, encryptedContentInfo, mac: new Uint8Array(mac.getValue()), aad };
}

function parseEnvelope(cms: Uint8Array): Envelope {
  const ci = parseContentInfo(cms);
  if (ci.contentType === OID_ENVELOPED_DATA) {
    const env = new pkijs.EnvelopedData({ schema: ci.content });
    return { recipientInfos: env.recipientInfos, encryptedContentInfo: env.encryptedContentInfo };
  }
  if (ci.contentType === OID_AUTH_ENVELOPED_DATA) return parseAuthEnvelopedData(ci.content);
  throw new Error(`Unexpected CMS content type: ${ci.contentType}`);
}

function keyTransInfo(ri: pkijs.RecipientInfo): pkijs.KeyTransRecipientInfo | null {
  if (ri instanceof pkijs.KeyTransRecipientInfo) return ri;
  return ri.variant === 1 && ri.value instanceof pkijs.KeyTransRecipientInfo ? ri.value : null;
}

function matchesRecipient(ktri: pkijs.KeyTransRecipientInfo, certificate: Uint8Array): boolean {
  try {
    const cert = parseCertificateDer(certificate);
    const rid = ktri.rid;
    if (rid instanceof pkijs.IssuerAndSerialNumber) {
      if (!bytesEqual(new Uint8Array(rid.serialNumber.valueBlock.valueHexView), new Uint8Array(cert.serialNumber.valueBlock.valueHexView))) return false;
      return bytesEqual(new Uint8Array(rid.issuer.toSchema().toBER(false)), new Uint8Array(cert.issuer.toSchema().toBER(false)));
    }
    if (rid instanceof asn1js.OctetString) {
      const ski = cert.extensions?.find((e) => e.extnID === '2.5.29.14');
      if (!ski) return false;
      const v = asn1js.fromBER(ski.extnValue.valueBlock.valueHexView);
      if (v.offset === -1) return false;
      return bytesEqual(new Uint8Array((v.result as asn1js.OctetString).valueBlock.valueHexView), new Uint8Array(rid.valueBlock.valueHexView));
    }
  } catch {
    // unparsable certificate: no match
  }
  return false;
}

/** The ids of the keys an encrypted message is addressed to (for the unlock prompt). */
export function matchingKeyIds(cms: Uint8Array, keys: Pick<SmimeKeyMaterial, 'id' | 'certificate'>[]): string[] {
  const env = parseEnvelope(cms);
  const ids: string[] = [];
  for (const ri of env.recipientInfos) {
    const ktri = keyTransInfo(ri);
    if (!ktri) continue;
    for (const k of keys) if (matchesRecipient(ktri, k.certificate) && !ids.includes(k.id)) ids.push(k.id);
  }
  return ids;
}

// RSAES-OAEP-params (RFC 4055): [0] hash, [1] MGF, [2] label source, all
// defaulting to SHA-1 / MGF1-SHA-1 / empty label.
function oaepParams(params: unknown): { hash: string; label?: ArrayBuffer } {
  let hash = 'SHA-1';
  let mgfHash: string | undefined = 'SHA-1';
  let label: ArrayBuffer | undefined;
  const fields = params instanceof asn1js.Sequence ? params.valueBlock.value : [];
  for (const field of fields) {
    const inner = (field as asn1js.Constructed).valueBlock.value[0];
    const alg = new pkijs.AlgorithmIdentifier({ schema: inner });
    if (isContext(field, 0)) {
      const h = HASHES[alg.algorithmId];
      if (!h) throw unsupported(`RSA-OAEP with hash ${alg.algorithmId}`);
      hash = h;
    } else if (isContext(field, 1)) {
      if (alg.algorithmId !== OID_MGF1) throw unsupported(`RSA-OAEP with mask ${alg.algorithmId}`);
      mgfHash = HASHES[new pkijs.AlgorithmIdentifier({ schema: alg.algorithmParams }).algorithmId];
    } else if (isContext(field, 2)) {
      if (alg.algorithmId !== OID_P_SPECIFIED) throw unsupported(`RSA-OAEP with label ${alg.algorithmId}`);
      const value = alg.algorithmParams instanceof asn1js.OctetString ? alg.algorithmParams.getValue() : new ArrayBuffer(0);
      if (value.byteLength > 0) label = value;
    }
  }
  // WebCrypto uses one hash for both.
  if (mgfHash !== hash) throw unsupported(`RSA-OAEP with ${hash} and MGF1-${mgfHash || 'unknown'}`);
  return { hash, label };
}

async function unwrapContentKey(ktri: pkijs.KeyTransRecipientInfo, pkcs8: Uint8Array): Promise<Uint8Array> {
  const { algorithmId, algorithmParams } = ktri.keyEncryptionAlgorithm;
  const encryptedKey = new Uint8Array(ktri.encryptedKey.valueBlock.valueHexView);
  if (algorithmId === OID_RSAES_OAEP) {
    const { hash, label } = oaepParams(algorithmParams);
    const subtle = webCrypto().subtle;
    const key = await subtle.importKey('pkcs8', toArrayBuffer(pkcs8), { name: 'RSA-OAEP', hash }, false, ['decrypt']);
    return new Uint8Array(await subtle.decrypt({ name: 'RSA-OAEP', ...(label ? { label } : {}) }, key, toArrayBuffer(encryptedKey)));
  }
  if (algorithmId === OID_RSA_ENCRYPTION) return rsaPkcs1Decrypt(pkcs8, encryptedKey);
  throw unsupported(algorithmId);
}

// GCMParameters ::= SEQUENCE { aes-nonce OCTET STRING, aes-ICVlen INTEGER DEFAULT 12 }
// pkijs writes a bare OCTET STRING nonce (the webmail plugin's own mail).
function gcmParams(params: unknown): { nonce: ArrayBuffer; tagLength: number } {
  if (params instanceof asn1js.OctetString) return { nonce: params.getValue(), tagLength: 16 };
  const fields = params instanceof asn1js.Sequence ? params.valueBlock.value : [];
  if (!(fields[0] instanceof asn1js.OctetString)) throw new Error('Invalid AES-GCM parameters');
  return { nonce: fields[0].getValue(), tagLength: fields[1] instanceof asn1js.Integer ? fields[1].valueBlock.valueDec : 12 };
}

const AES_CBC = new Set(['2.16.840.1.101.3.4.1.2', '2.16.840.1.101.3.4.1.22', '2.16.840.1.101.3.4.1.42']);
const AES_GCM = new Set(['2.16.840.1.101.3.4.1.6', '2.16.840.1.101.3.4.1.26', '2.16.840.1.101.3.4.1.46']);
const DES_EDE3_CBC = '1.2.840.113549.3.7';
const CHACHA20_POLY1305 = '1.2.840.113549.1.9.16.3.18';

function ivOf(params: unknown): Uint8Array {
  if (!(params instanceof asn1js.OctetString)) throw new Error('Invalid cipher parameters');
  return new Uint8Array(params.getValue());
}

function assertSupportedContent(eci: pkijs.EncryptedContentInfo, authenticated: boolean): void {
  const oid = eci.contentEncryptionAlgorithm.algorithmId;
  const ok = authenticated
    ? AES_GCM.has(oid) || oid === CHACHA20_POLY1305
    : AES_CBC.has(oid) || AES_GCM.has(oid) || oid === DES_EDE3_CBC;
  if (!ok) throw unsupported(oid);
}

async function decryptContent(env: Envelope, cek: Uint8Array): Promise<Uint8Array> {
  const { algorithmId: oid, algorithmParams } = env.encryptedContentInfo.contentEncryptionAlgorithm;
  const ciphertext = new Uint8Array(env.encryptedContentInfo.getEncryptedContent());
  const subtle = webCrypto().subtle;
  if (AES_CBC.has(oid)) {
    const key = await subtle.importKey('raw', toArrayBuffer(cek), { name: 'AES-CBC' }, false, ['decrypt']);
    return new Uint8Array(await subtle.decrypt({ name: 'AES-CBC', iv: toArrayBuffer(ivOf(algorithmParams)) }, key, toArrayBuffer(ciphertext)));
  }
  if (AES_GCM.has(oid)) {
    const { nonce, tagLength } = gcmParams(algorithmParams);
    // AuthEnvelopedData carries the tag in `mac`; EnvelopedData appends it.
    const sealed = env.mac ? concatBytes(ciphertext, env.mac) : ciphertext;
    if (env.mac && env.mac.byteLength !== tagLength) throw new Error('AES-GCM tag length does not match its parameters');
    const key = await subtle.importKey('raw', toArrayBuffer(cek), { name: 'AES-GCM' }, false, ['decrypt']);
    return new Uint8Array(await subtle.decrypt(
      { name: 'AES-GCM', iv: nonce, tagLength: (env.mac ? tagLength : 16) * 8, ...(env.aad ? { additionalData: toArrayBuffer(env.aad) } : {}) },
      key,
      toArrayBuffer(sealed),
    ));
  }
  if (oid === DES_EDE3_CBC) return cbcDecrypt('des-ede3-cbc', cek, ivOf(algorithmParams), ciphertext);
  if (oid === CHACHA20_POLY1305) {
    const nonce = ivOf(algorithmParams);
    if (nonce.byteLength !== 12) throw new Error('ChaCha20-Poly1305 nonce must be 12 bytes');
    if (!env.mac || env.mac.byteLength !== 16) throw new Error('ChaCha20-Poly1305 tag must be 16 bytes');
    return chacha20Poly1305Decrypt(cek, nonce, concatBytes(ciphertext, env.mac), env.aad);
  }
  throw unsupported(oid);
}

/**
 * Decrypt CMS EnvelopedData or AuthEnvelopedData with whichever of `keys`
 * it is addressed to. A matching key without its PKCS#8 (locked) raises
 * SmimeKeyLockedError; no matching key raises SmimeNoMatchingKeyError.
 */
export async function smimeDecrypt(cms: Uint8Array, keys: SmimeKeyMaterial[]): Promise<{ mimeBytes: Uint8Array; keyId: string }> {
  const env = parseEnvelope(cms);
  const matches: Array<{ key: SmimeKeyMaterial; ktri: pkijs.KeyTransRecipientInfo }> = [];
  for (const ri of env.recipientInfos) {
    const ktri = keyTransInfo(ri);
    if (!ktri) continue;
    for (const key of keys) if (matchesRecipient(ktri, key.certificate)) matches.push({ key, ktri });
  }
  if (matches.length === 0) throw new SmimeNoMatchingKeyError();
  assertSupportedContent(env.encryptedContentInfo, !!env.mac);

  let lastError: unknown;
  for (const { key, ktri } of matches) {
    if (!key.pkcs8) continue;
    try {
      const cek = await unwrapContentKey(ktri, key.pkcs8);
      return { mimeBytes: await decryptContent(env, cek), keyId: key.id };
    } catch (err) {
      if (err instanceof UnsupportedAlgorithmError) throw err;
      lastError = err; // wrong key or a broken message: try the next one
    }
  }
  if (matches.some((m) => !m.key.pkcs8)) throw new SmimeKeyLockedError();
  throw new Error(`Failed to decrypt the message${lastError instanceof Error ? `: ${lastError.message}` : ''}`);
}

// ── Signatures ───────────────────────────────────────────────────────

export interface SmimeSignatureStatus {
  signatureValid: boolean;
  signatureError?: string;
  /** The digest/signature check alone, before certificate dates. */
  cryptoValid: boolean;
  signerEmail?: string;
  signerEmailMatch?: boolean;
  selfSigned?: boolean;
  certExpired?: boolean;
  signerFingerprint?: string;
  signerSubject?: string;
  /** The signer's certificate, to remember as a recipient certificate. */
  signerCertificate?: Uint8Array;
}

function extractSignedData(ci: pkijs.ContentInfo): pkijs.SignedData {
  if (ci.contentType !== OID_SIGNED_DATA) throw new Error(`Unexpected CMS content type: ${ci.contentType}`);
  return new pkijs.SignedData({ schema: ci.content });
}

function extractInnerContent(sd: pkijs.SignedData): Uint8Array {
  const eContent = sd.encapContentInfo?.eContent;
  if (!eContent) throw new Error('No encapsulated content in SignedData');
  if (eContent instanceof asn1js.OctetString) {
    const children = eContent.valueBlock.value as asn1js.OctetString[] | undefined;
    if (children?.length) return concatBytes(...children.map((c) => new Uint8Array(c.valueBlock.valueHexView)));
    return new Uint8Array(eContent.valueBlock.valueHexView);
  }
  throw new Error('Unable to extract content from SignedData');
}

function extractSignerCertificate(sd: pkijs.SignedData): pkijs.Certificate | null {
  if (!sd.signerInfos?.length || !sd.certificates?.length) return null;
  const sid = sd.signerInfos[0].sid;
  if (sid instanceof pkijs.IssuerAndSerialNumber) {
    for (const c of sd.certificates) {
      if (!(c instanceof pkijs.Certificate)) continue;
      if (!bytesEqual(new Uint8Array(sid.serialNumber.valueBlock.valueHexView), new Uint8Array(c.serialNumber.valueBlock.valueHexView))) continue;
      if (bytesEqual(new Uint8Array(sid.issuer.toSchema().toBER(false)), new Uint8Array(c.issuer.toSchema().toBER(false)))) return c;
    }
  }
  if (sd.certificates.length === 1 && sd.certificates[0] instanceof pkijs.Certificate) return sd.certificates[0];
  return null;
}

async function verifyStatus(sd: pkijs.SignedData, data: ArrayBuffer | undefined, fromEmail?: string): Promise<SmimeSignatureStatus> {
  const signer = extractSignerCertificate(sd);
  if (!signer) return { signatureValid: false, cryptoValid: false, signatureError: 'Signer certificate not found in CMS structure' };
  let cryptoValid = false;
  let signatureError: string | undefined;
  try {
    // checkChain:false: the signature is checked cryptographically; trust in
    // the issuer is shown separately (selfSigned) as the plugin does.
    cryptoValid = await sd.verify({ signer: 0, checkChain: false, ...(data ? { data } : {}) }, smimeEngine()) as boolean;
  } catch (err) {
    signatureError = err instanceof Error ? err.message : 'Signature verification failed';
  }
  const der = new Uint8Array(signer.toSchema(true).toBER(false));
  const info = await extractCertificateInfo(signer, der);
  const now = Date.now();
  const certExpired = now > Date.parse(info.notAfter);
  const certNotYetValid = now < Date.parse(info.notBefore);
  if (!cryptoValid && !signatureError) signatureError = 'Signature does not match the message content';
  if (certExpired && !signatureError) signatureError = 'Signer certificate has expired';
  if (certNotYetValid && !signatureError) signatureError = 'Signer certificate is not yet valid';
  const signerEmail = info.emailAddresses[0];
  return {
    signatureValid: cryptoValid && !certExpired && !certNotYetValid,
    signatureError,
    cryptoValid,
    signerEmail,
    signerEmailMatch: fromEmail && signerEmail ? fromEmail.toLowerCase() === signerEmail.toLowerCase() : undefined,
    selfSigned: bytesEqual(new Uint8Array(signer.issuer.toSchema().toBER(false)), new Uint8Array(signer.subject.toSchema().toBER(false))),
    certExpired,
    signerFingerprint: info.fingerprint,
    signerSubject: info.subject,
    signerCertificate: der,
  };
}

/** Is this CMS a SignedData (sign-then-encrypt nests one)? */
export function isSignedData(cms: Uint8Array): boolean {
  try {
    return parseContentInfo(cms).contentType === OID_SIGNED_DATA;
  } catch {
    return false;
  }
}

/** Verify opaque SignedData and return the content it wraps. */
export async function smimeVerifyOpaque(cms: Uint8Array, fromEmail?: string): Promise<{ mimeBytes: Uint8Array; status: SmimeSignatureStatus }> {
  const sd = extractSignedData(parseContentInfo(cms));
  return { mimeBytes: extractInnerContent(sd), status: await verifyStatus(sd, undefined, fromEmail) };
}

function lfToCrlf(bytes: Uint8Array): Uint8Array | null {
  let bare = 0;
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0x0a && (i === 0 || bytes[i - 1] !== 0x0d)) bare++;
  if (bare === 0) return null;
  const out = new Uint8Array(bytes.length + bare);
  let j = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x0a && (i === 0 || bytes[i - 1] !== 0x0d)) out[j++] = 0x0d;
    out[j++] = bytes[i];
  }
  return out;
}

/** Verify a detached signature over the signed entity's exact bytes. */
export async function smimeVerifyDetached(signatureDer: Uint8Array, entity: Uint8Array, fromEmail?: string): Promise<SmimeSignatureStatus> {
  const sd = extractSignedData(parseContentInfo(signatureDer));
  // pkijs prefers embedded content over the data passed in, so a CMS with its
  // own content would vouch for that instead of the part shown.
  if (sd.encapContentInfo?.eContent) throw new Error('Detached signature carries its own content');
  let status = await verifyStatus(sd, toArrayBuffer(entity), fromEmail);
  // A relay may have stripped the CRs: retry in canonical form.
  const canonical = lfToCrlf(entity);
  if (!status.cryptoValid && canonical) {
    const retry = await verifyStatus(sd, toArrayBuffer(canonical), fromEmail);
    if (retry.cryptoValid) status = retry;
  }
  return status;
}

/** SMIMECapabilities: AES-256-CBC, AES-128-CBC, 3DES-CBC. */
function smimeCapabilities(): asn1js.Sequence {
  const cap = (oid: string) => new asn1js.Sequence({ value: [new asn1js.ObjectIdentifier({ value: oid })] });
  return new asn1js.Sequence({ value: [cap('2.16.840.1.101.3.4.1.42'), cap('2.16.840.1.101.3.4.1.2'), cap(DES_EDE3_CBC)] });
}

/** DER sorts a SET OF by encoding; pkijs encodes in array order. */
function derSorted(attributes: pkijs.Attribute[]): pkijs.Attribute[] {
  const enc = (a: pkijs.Attribute) => new Uint8Array(a.toSchema().toBER(false));
  const cmp = (x: Uint8Array, y: Uint8Array) => {
    for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
    return x.length - y.length;
  };
  return attributes.map((a) => ({ a, der: enc(a) })).sort((p, q) => cmp(p.der, q.der)).map((p) => p.a);
}

function newSignedData(encap: pkijs.EncapsulatedContentInfo, signerCertDer: Uint8Array, chainDer: Uint8Array[], digest: ArrayBuffer): pkijs.SignedData {
  const signerCert = parseCertificateDer(signerCertDer);
  return new pkijs.SignedData({
    version: 1,
    encapContentInfo: encap,
    signerInfos: [
      new pkijs.SignerInfo({
        version: 1,
        sid: new pkijs.IssuerAndSerialNumber({ issuer: signerCert.issuer, serialNumber: signerCert.serialNumber }),
        // Signed attributes (RFC 5652 §11 / RFC 8551 §2.5): Outlook needs a
        // signing time and the digest.
        signedAttrs: new pkijs.SignedAndUnsignedAttributes({
          type: 0,
          attributes: derSorted([
            new pkijs.Attribute({ type: '1.2.840.113549.1.9.3', values: [new asn1js.ObjectIdentifier({ value: OID_DATA })] }),
            new pkijs.Attribute({ type: '1.2.840.113549.1.9.4', values: [new asn1js.OctetString({ valueHex: digest })] }),
            new pkijs.Attribute({ type: '1.2.840.113549.1.9.5', values: [new asn1js.UTCTime({ valueDate: new Date() })] }),
            new pkijs.Attribute({ type: '1.2.840.113549.1.9.15', values: [smimeCapabilities()] }),
          ]),
        }),
      }),
    ],
    certificates: [signerCert, ...chainDer.map(parseCertificateDer)],
  });
}

/**
 * pkijs writes sha256WithRSAEncryption without the NULL parameters, which
 * Windows CryptoAPI rejects; use rsaEncryption + NULL (RFC 5754 §3.2).
 */
function contentInfoDer(sd: pkijs.SignedData): Uint8Array {
  const si = sd.signerInfos[0];
  if (['1.2.840.113549.1.1.11', '1.2.840.113549.1.1.12', '1.2.840.113549.1.1.13', '1.2.840.113549.1.1.5'].includes(si.signatureAlgorithm.algorithmId)) {
    si.signatureAlgorithm = new pkijs.AlgorithmIdentifier({ algorithmId: OID_RSA_ENCRYPTION, algorithmParams: new asn1js.Null() });
  }
  return new Uint8Array(new pkijs.ContentInfo({ contentType: OID_SIGNED_DATA, content: sd.toSchema(true) }).toSchema().toBER(false));
}

async function signingKey(pkcs8: Uint8Array, algorithm: string): Promise<CryptoKey> {
  const subtle = webCrypto().subtle;
  if (algorithm.startsWith('ECDSA')) {
    const curve = algorithm.includes('384') ? 'P-384' : algorithm.includes('521') ? 'P-521' : 'P-256';
    return subtle.importKey('pkcs8', toArrayBuffer(pkcs8), { name: 'ECDSA', namedCurve: curve }, false, ['sign']);
  }
  return subtle.importKey('pkcs8', toArrayBuffer(pkcs8), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}

async function sha256(bytes: Uint8Array): Promise<ArrayBuffer> {
  return webCrypto().subtle.digest('SHA-256', toArrayBuffer(bytes));
}

export interface SmimeSigner {
  pkcs8: Uint8Array;
  certificate: Uint8Array;
  chain: Uint8Array[];
  /** "RSA-2048", "ECDSA-P256", ... (certificate.ts extractAlgorithm). */
  algorithm: string;
}

/** Opaque SignedData wrapping `mime` (application/pkcs7-mime; smime-type=signed-data). */
export async function smimeSignOpaque(mime: Uint8Array, signer: SmimeSigner): Promise<Uint8Array> {
  const encap = new pkijs.EncapsulatedContentInfo({ eContentType: OID_DATA });
  // A plain primitive OCTET STRING, as OpenSSL and Outlook write it.
  encap.eContent = new asn1js.OctetString({ valueHex: toArrayBuffer(mime) });
  const sd = newSignedData(encap, signer.certificate, signer.chain, await sha256(mime));
  await sd.sign(await signingKey(signer.pkcs8, signer.algorithm), 0, 'SHA-256', undefined, smimeEngine());
  return contentInfoDer(sd);
}

/** Detached SignedData over a CRLF MIME entity (multipart/signed). */
export async function smimeSignDetached(entity: Uint8Array, signer: SmimeSigner): Promise<Uint8Array> {
  const sd = newSignedData(new pkijs.EncapsulatedContentInfo({ eContentType: OID_DATA }), signer.certificate, signer.chain, await sha256(entity));
  await sd.sign(await signingKey(signer.pkcs8, signer.algorithm), 0, 'SHA-256', toArrayBuffer(entity), smimeEngine());
  return contentInfoDer(sd);
}

/**
 * EnvelopedData to every recipient certificate plus the sender's, so Sent
 * stays readable. RSA-OAEP (SHA-256) key transport like the plugin, but
 * AES-256-CBC content: the plugin's AES-GCM inside EnvelopedData is not
 * standard (RFC 5084 puts GCM in AuthEnvelopedData) and Outlook and
 * Thunderbird can't read it.
 */
export async function smimeEncrypt(mime: Uint8Array, recipientCerts: Uint8Array[], senderCert: Uint8Array): Promise<Uint8Array> {
  const seen = new Set<string>();
  const unique = [...recipientCerts, senderCert].filter((der) => {
    const k = Array.from(der).join(',');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (unique.length === 0) throw new Error('No recipient certificates provided');
  const engine = smimeEngine();
  const env = new pkijs.EnvelopedData();
  for (const der of unique) env.addRecipientByCertificate(parseCertificateDer(der), { oaepHashAlgorithm: 'SHA-256' }, undefined, engine);
  await env.encrypt({ name: 'AES-CBC', length: 256 } as AesKeyAlgorithm, toArrayBuffer(mime), engine);
  return new Uint8Array(new pkijs.ContentInfo({ contentType: OID_ENVELOPED_DATA, content: env.toSchema() }).toSchema().toBER(false));
}
