// PKCS#12 (.p12/.pfx) import for S/MIME (#58). Port of the parsing half of
// repos/plugins/smime/src/pkcs12.js. The app keeps the .p12 itself in
// SecureStore and opens it with its password once per session, so there is
// no second at-rest wrapping here.

import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { smimeEngine } from './engine';
import { extractCertificateInfo, type CertificateInfo } from './certificate';

export interface Pkcs12Contents {
  /** PKCS#8 PrivateKeyInfo DER. */
  pkcs8: Uint8Array;
  certificate: Uint8Array;
  chain: Uint8Array[];
  info: CertificateInfo;
}

export class Pkcs12PasswordError extends Error {
  constructor() {
    super('Wrong password for this certificate file');
    this.name = 'Pkcs12PasswordError';
  }
}

function passwordBuffer(password: string): ArrayBuffer {
  // pkijs expects the password as bytes; it builds the BMPString itself.
  return new TextEncoder().encode(password).slice().buffer;
}

async function withEngine<T>(fn: () => Promise<T>): Promise<T> {
  smimeEngine();
  return fn();
}

/** Open a .p12 with its password: the private key, leaf certificate and chain. */
export async function openPkcs12(p12: Uint8Array, password: string): Promise<Pkcs12Contents> {
  const asn1 = asn1js.fromBER(p12.slice().buffer);
  if (asn1.offset === -1) throw new Error('Invalid PKCS#12 file');
  const pfx = new pkijs.PFX({ schema: asn1.result });
  const pass = passwordBuffer(password);

  try {
    await withEngine(() => pfx.parseInternalValues({ password: pass, checkIntegrity: true }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/integrity|password|mac/i.test(msg)) throw new Pkcs12PasswordError();
    throw err;
  }
  const authSafe = pfx.parsedValue?.authenticatedSafe;
  if (!authSafe) throw new Error('PKCS#12 file does not contain an authenticated safe');
  const safeContentsParams = authSafe.safeContents.map((ci) => (ci.contentType === '1.2.840.113549.1.7.6' ? { password: pass } : {}));
  await withEngine(() => authSafe.parseInternalValues({ safeContents: safeContentsParams }));

  let leaf: { cert: pkijs.Certificate; der: Uint8Array } | null = null;
  const chain: Uint8Array[] = [];
  let keyInfo: pkijs.PrivateKeyInfo | null = null;

  for (const safeContent of authSafe.parsedValue?.safeContents ?? []) {
    const sc = (safeContent as { value?: pkijs.SafeContents }).value;
    if (!sc) continue;
    for (const bag of sc.safeBags) {
      if (bag.bagId === '1.2.840.113549.1.12.10.1.3') {
        const certBag = bag.bagValue as pkijs.CertBag;
        let cert: pkijs.Certificate | null = null;
        let der: Uint8Array | null = null;
        if (certBag.parsedValue instanceof pkijs.Certificate) {
          cert = certBag.parsedValue;
          der = new Uint8Array(cert.toSchema(true).toBER(false));
        } else if (certBag.certId === '1.2.840.113549.1.9.22.1' && certBag.certValue) {
          const bytes = (certBag.certValue as asn1js.OctetString).valueBlock.valueHexView;
          const parsed = asn1js.fromBER(bytes);
          if (parsed.offset !== -1) {
            cert = new pkijs.Certificate({ schema: parsed.result });
            der = new Uint8Array(bytes);
          }
        }
        if (cert && der) {
          if (!leaf) leaf = { cert, der };
          else chain.push(der);
        }
      } else if (bag.bagId === '1.2.840.113549.1.12.10.1.1') {
        keyInfo = bag.bagValue as pkijs.PrivateKeyInfo;
      } else if (bag.bagId === '1.2.840.113549.1.12.10.1.2') {
        const shrouded = bag.bagValue as pkijs.PKCS8ShroudedKeyBag;
        if (!shrouded.parsedValue) {
          // Protected in pkijs' typings, public in its build (the plugin calls it too).
          const parse = shrouded as unknown as { parseInternalValues(p: { password: ArrayBuffer }): Promise<void> };
          await withEngine(() => parse.parseInternalValues({ password: pass }));
        }
        if (shrouded.parsedValue) keyInfo = shrouded.parsedValue;
      }
    }
  }

  if (!leaf) throw new Error('No certificate found in PKCS#12 file');
  if (!keyInfo) throw new Error('No private key found in PKCS#12 file');

  // With several certificates, the leaf is the one that isn't an issuer of
  // the others (the plugin took the first; some exports list the CA first).
  const all = [leaf.der, ...chain];
  const certs = all.map((der) => new pkijs.Certificate({ schema: asn1js.fromBER(der.slice().buffer).result }));
  const issuerDers = new Set(certs.map((c) => toKey(c.issuer)));
  const leafIndex = Math.max(0, certs.findIndex((c) => !issuerDers.has(toKey(c.subject)) || certs.length === 1));
  const leafDer = all[leafIndex];
  const others = all.filter((_, i) => i !== leafIndex);

  return {
    pkcs8: new Uint8Array(keyInfo.toSchema().toBER(false)),
    certificate: leafDer,
    chain: others,
    info: await extractCertificateInfo(certs[leafIndex], leafDer),
  };
}

function toKey(name: pkijs.RelativeDistinguishedNames): string {
  return Array.from(new Uint8Array(name.toSchema().toBER(false))).join(',');
}
