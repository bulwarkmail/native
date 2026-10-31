// X.509 parsing and metadata for S/MIME (#58). Port of
// repos/plugins/smime/src/certificate-utils.js.

import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { base64Decode, base64Encode } from '../mime';
import { webCrypto } from '../provider';

const OID_EMAIL_PROTECTION = '1.3.6.1.5.5.7.3.4';
const OID_SAN = '2.5.29.17';

export interface CertificateInfo {
  subject: string;
  issuer: string;
  serialNumber: string;
  notBefore: string;
  notAfter: string;
  /** SHA-256 over the DER, colon-separated hex. */
  fingerprint: string;
  algorithm: string;
  emailAddresses: string[];
  capabilities: { canSign: boolean; canEncrypt: boolean };
}

export function pemToDer(pem: string): Uint8Array {
  return base64Decode(pem.replace(/-----BEGIN [^-]+-----/, '').replace(/-----END [^-]+-----/, ''));
}

export function derToPem(der: Uint8Array, label = 'CERTIFICATE'): string {
  return `-----BEGIN ${label}-----\n${base64Encode(der, 64).replace(/\r\n/g, '\n')}\n-----END ${label}-----\n`;
}

export function parseCertificateDer(der: Uint8Array | ArrayBuffer): pkijs.Certificate {
  const bytes = der instanceof Uint8Array ? der : new Uint8Array(der);
  const asn1 = asn1js.fromBER(bytes.slice().buffer);
  if (asn1.offset === -1) throw new Error('Invalid DER data: ASN.1 parsing failed');
  return new pkijs.Certificate({ schema: asn1.result });
}

/** A certificate file: PEM text or DER bytes. Returns the DER. */
export function certificateDerFromFile(bytes: Uint8Array): Uint8Array {
  const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 64));
  if (head.includes('-----BEGIN ')) return pemToDer(new TextDecoder().decode(bytes));
  return bytes;
}

function oidToName(oid: string): string {
  const map: Record<string, string> = {
    '2.5.4.3': 'CN', '2.5.4.6': 'C', '2.5.4.7': 'L', '2.5.4.8': 'ST', '2.5.4.10': 'O', '2.5.4.11': 'OU', '1.2.840.113549.1.9.1': 'E',
  };
  return map[oid] ?? oid;
}

function rdnToString(rdn: pkijs.RelativeDistinguishedNames): string {
  return rdn.typesAndValues
    .map((tv) => `${oidToName(tv.type)}=${(tv.value.valueBlock as { value?: string }).value ?? ''}`)
    .join(', ');
}

export async function computeFingerprint(der: Uint8Array): Promise<string> {
  const hash = await webCrypto().subtle.digest('SHA-256', der.slice());
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join(':');
}

function extractAlgorithm(cert: pkijs.Certificate): string {
  const algOid = cert.subjectPublicKeyInfo.algorithm.algorithmId;
  if (algOid === '1.2.840.113549.1.1.1') {
    try {
      const seq = asn1js.fromBER(cert.subjectPublicKeyInfo.subjectPublicKey.valueBlock.valueHexView).result as asn1js.Sequence;
      const modulus = seq.valueBlock.value[0] as asn1js.Integer;
      return `RSA-${(modulus.valueBlock.valueHexView.byteLength - 1) * 8}`;
    } catch {
      return 'RSA';
    }
  }
  if (algOid === '1.2.840.10045.2.1') {
    const params = cert.subjectPublicKeyInfo.algorithm.algorithmParams;
    if (params instanceof asn1js.ObjectIdentifier) {
      const curves: Record<string, string> = { '1.2.840.10045.3.1.7': 'ECDSA-P256', '1.3.132.0.34': 'ECDSA-P384', '1.3.132.0.35': 'ECDSA-P521' };
      return curves[params.valueBlock.toString()] ?? 'ECDSA';
    }
    return 'ECDSA';
  }
  return algOid;
}

function extractKeyUsage(cert: pkijs.Certificate): string[] | undefined {
  const ext = cert.extensions?.find((e) => e.extnID === '2.5.29.15');
  if (!ext?.parsedValue) return undefined;
  // pkijs parses keyUsage as a BIT STRING.
  const bits = ext.parsedValue as asn1js.BitString;
  const view = bits.valueBlock?.valueHexView;
  if (!view) return undefined;
  const names = ['digitalSignature', 'contentCommitment', 'keyEncipherment', 'dataEncipherment', 'keyAgreement', 'keyCertSign', 'cRLSign', 'encipherOnly', 'decipherOnly'];
  const out: string[] = [];
  for (let i = 0; i < names.length; i++) {
    const byte = view[i >> 3] ?? 0;
    if (byte & (0x80 >> (i & 7))) out.push(names[i]);
  }
  return out;
}

function extractExtendedKeyUsage(cert: pkijs.Certificate): string[] | undefined {
  const ext = cert.extensions?.find((e) => e.extnID === '2.5.29.37');
  return (ext?.parsedValue as { keyPurposes?: string[] } | undefined)?.keyPurposes;
}

function extractEmailAddresses(cert: pkijs.Certificate): string[] {
  const emails: string[] = [];
  for (const tv of cert.subject.typesAndValues) {
    if (tv.type === '1.2.840.113549.1.9.1') emails.push(String((tv.value.valueBlock as { value?: string }).value ?? ''));
  }
  const san = cert.extensions?.find((e) => e.extnID === OID_SAN);
  if (san) {
    let names = (san.parsedValue as { names?: pkijs.GeneralName[] } | undefined)?.names;
    if (!names && san.extnValue) {
      try {
        const parsed = asn1js.fromBER(san.extnValue.valueBlock.valueHexView);
        if (parsed.offset !== -1) names = new pkijs.GeneralNames({ schema: parsed.result }).names;
      } catch {
        // malformed SAN: skip
      }
    }
    for (const name of names ?? []) {
      if (name.type === 1 && typeof name.value === 'string' && !emails.includes(name.value)) emails.push(name.value);
    }
  }
  return emails.map((e) => e.toLowerCase()).filter(Boolean);
}

/** Signing/encryption capabilities from KU / EKU; absent extensions allow both. */
export function classifyCapabilities(cert: pkijs.Certificate): { canSign: boolean; canEncrypt: boolean } {
  const ku = extractKeyUsage(cert);
  const eku = extractExtendedKeyUsage(cert);
  let canSign = true;
  let canEncrypt = true;
  if (ku) {
    canSign = ku.includes('digitalSignature') || ku.includes('contentCommitment');
    canEncrypt = ku.includes('keyEncipherment') || ku.includes('dataEncipherment') || ku.includes('keyAgreement');
  }
  if (eku && eku.length > 0 && !eku.includes(OID_EMAIL_PROTECTION)) {
    canSign = false;
    canEncrypt = false;
  }
  return { canSign, canEncrypt };
}

export async function extractCertificateInfo(cert: pkijs.Certificate, der: Uint8Array): Promise<CertificateInfo> {
  const serial = cert.serialNumber.valueBlock.valueHexView;
  return {
    subject: rdnToString(cert.subject),
    issuer: rdnToString(cert.issuer),
    serialNumber: Array.from(new Uint8Array(serial)).map((b) => b.toString(16).padStart(2, '0')).join(':'),
    notBefore: cert.notBefore.value.toISOString(),
    notAfter: cert.notAfter.value.toISOString(),
    fingerprint: await computeFingerprint(der),
    algorithm: extractAlgorithm(cert),
    emailAddresses: extractEmailAddresses(cert),
    capabilities: classifyCapabilities(cert),
  };
}

/** Parse + describe a certificate from DER. */
export async function describeCertificate(der: Uint8Array): Promise<CertificateInfo> {
  return extractCertificateInfo(parseCertificateDer(der), der);
}
