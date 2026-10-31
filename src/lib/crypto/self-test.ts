// Settings > Encryption > Check encryption support (#58): runs each
// algorithm PGP and S/MIME rely on through the installed crypto
// (react-native-quick-crypto on a device) and reports which work. On a new
// platform or library version this names a gap before a message fails.

import { cbcDecrypt, chacha20Poly1305Decrypt, nodeStyleCrypto, rsaPkcs1Decrypt, toArrayBuffer, webCrypto } from './provider';

export interface SelfTestResult {
  name: string;
  ok: boolean;
  error?: string;
}

type Check = [name: string, run: () => Promise<void>];

function assert(cond: unknown, what: string): void {
  if (!cond) throw new Error(what);
}

const bytes = (s: string) => new TextEncoder().encode(s);

function checks(): Check[] {
  const subtle = () => webCrypto().subtle;
  const data = bytes('bulwark self-test');
  return [
    ['SHA-1 / SHA-256 / SHA-512', async () => {
      for (const h of ['SHA-1', 'SHA-256', 'SHA-512']) assert((await subtle().digest(h, data)).byteLength > 0, h);
    }],
    ['AES-GCM', async () => {
      const key = await subtle().generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      const iv = webCrypto().getRandomValues(new Uint8Array(12));
      const ct = await subtle().encrypt({ name: 'AES-GCM', iv }, key, data);
      assert(new TextDecoder().decode(await subtle().decrypt({ name: 'AES-GCM', iv }, key, ct)) === 'bulwark self-test', 'round trip');
    }],
    ['AES-CBC / AES-CTR / AES-KW', async () => {
      const raw = webCrypto().getRandomValues(new Uint8Array(32));
      const cbc = await subtle().importKey('raw', raw, 'AES-CBC', false, ['encrypt', 'decrypt']);
      const iv = new Uint8Array(16);
      const ct = await subtle().encrypt({ name: 'AES-CBC', iv }, cbc, data);
      assert((await subtle().decrypt({ name: 'AES-CBC', iv }, cbc, ct)).byteLength === data.byteLength, 'cbc');
      const ctr = await subtle().importKey('raw', raw, 'AES-CTR', false, ['encrypt']);
      assert((await subtle().encrypt({ name: 'AES-CTR', counter: iv, length: 64 }, ctr, data)).byteLength === data.byteLength, 'ctr');
      const kw = await subtle().importKey('raw', raw, 'AES-KW', false, ['wrapKey']);
      const hmac = await subtle().importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, true, ['sign']);
      assert((await subtle().wrapKey('raw', hmac, kw, 'AES-KW')).byteLength === 40, 'kw');
    }],
    ['RSA-OAEP / RSA PKCS#1 signatures', async () => {
      const oaep = await subtle().generateKey({ name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['encrypt', 'decrypt']) as CryptoKeyPair;
      const ct = await subtle().encrypt({ name: 'RSA-OAEP' }, oaep.publicKey, data);
      assert((await subtle().decrypt({ name: 'RSA-OAEP' }, oaep.privateKey, ct)).byteLength === data.byteLength, 'oaep');
      const jwk = await subtle().exportKey('jwk', oaep.privateKey);
      assert(!!jwk.d, 'jwk export');
      const sig = await subtle().generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
      const s = await subtle().sign('RSASSA-PKCS1-v1_5', sig.privateKey, data);
      assert(await subtle().verify('RSASSA-PKCS1-v1_5', sig.publicKey, s, data), 'verify');
    }],
    ['ECDSA / ECDH P-256', async () => {
      const ecdsa = await subtle().generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
      const s = await subtle().sign({ name: 'ECDSA', hash: 'SHA-256' }, ecdsa.privateKey, data);
      assert(await subtle().verify({ name: 'ECDSA', hash: 'SHA-256' }, ecdsa.publicKey, s, data), 'ecdsa');
      const a = await subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
      const b = await subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
      assert((await subtle().deriveBits({ name: 'ECDH', public: b.publicKey }, a.privateKey, 256)).byteLength === 32, 'ecdh');
    }],
    ['Ed25519 / X25519', async () => {
      const ed = await subtle().generateKey('Ed25519', true, ['sign', 'verify']) as CryptoKeyPair;
      const s = await subtle().sign('Ed25519', ed.privateKey, data);
      assert(await subtle().verify('Ed25519', ed.publicKey, s, data), 'ed25519');
      const jwk = await subtle().exportKey('jwk', ed.privateKey);
      await subtle().importKey('jwk', jwk, 'Ed25519', false, ['sign']);
      const a = await subtle().generateKey('X25519', true, ['deriveBits']) as CryptoKeyPair;
      const b = await subtle().generateKey('X25519', true, ['deriveBits']) as CryptoKeyPair;
      assert((await subtle().deriveBits({ name: 'X25519', public: b.publicKey }, a.privateKey, 256)).byteLength === 32, 'x25519');
    }],
    ['HKDF / PBKDF2', async () => {
      const ikm = await subtle().importKey('raw', data, 'HKDF', false, ['deriveBits']);
      assert((await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(16), info: new Uint8Array(0) }, ikm, 256)).byteLength === 32, 'hkdf');
      const pw = await subtle().importKey('raw', data, 'PBKDF2', false, ['deriveBits']);
      assert((await subtle().deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new Uint8Array(16), iterations: 1000 }, pw, 256)).byteLength === 32, 'pbkdf2');
    }],
    ['RSA PKCS#1 v1.5 decryption (S/MIME key transport)', async () => {
      const pair = await subtle().generateKey({ name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['encrypt', 'decrypt']) as CryptoKeyPair;
      const pkcs8 = new Uint8Array(await subtle().exportKey('pkcs8', pair.privateKey));
      const jwk = await subtle().exportKey('jwk', pair.publicKey);
      // Encrypt with PKCS#1 v1.5 padding by hand: 00 02 <nonzero random> 00 <data>.
      const n = BigInt(`0x${Array.from(atob(jwk.n!.replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0).toString(16).padStart(2, '0')).join('')}`);
      const k = 256;
      const em = new Uint8Array(k);
      em[1] = 2;
      const pad = webCrypto().getRandomValues(new Uint8Array(k - 3 - data.length)).map((x) => x || 1);
      em.set(pad, 2);
      em.set(data, k - data.length);
      let m = 0n;
      for (const b of em) m = (m << 8n) | BigInt(b);
      let c = 1n;
      let base = m % n;
      let e = 65537n;
      while (e > 0n) {
        if (e & 1n) c = (c * base) % n;
        base = (base * base) % n;
        e >>= 1n;
      }
      const ct = new Uint8Array(k);
      for (let i = k - 1; i >= 0; i--) {
        ct[i] = Number(c & 0xffn);
        c >>= 8n;
      }
      assert(new TextDecoder().decode(rsaPkcs1Decrypt(pkcs8, ct)) === 'bulwark self-test', 'decrypt');
    }],
    ['3DES / ChaCha20-Poly1305 (legacy and Stalwart at-rest mail)', async () => {
      const nc = nodeStyleCrypto() as unknown as { createCipheriv(a: string, k: Uint8Array, iv: Uint8Array, o?: object): { update(d: Uint8Array): Uint8Array; final(): Uint8Array; getAuthTag?(): Uint8Array } };
      const key24 = webCrypto().getRandomValues(new Uint8Array(24));
      const iv8 = webCrypto().getRandomValues(new Uint8Array(8));
      const des = nc.createCipheriv('des-ede3-cbc', key24, iv8);
      const desCt = new Uint8Array([...des.update(data), ...des.final()]);
      assert(new TextDecoder().decode(cbcDecrypt('des-ede3-cbc', key24, iv8, desCt)) === 'bulwark self-test', '3des');
      const key32 = webCrypto().getRandomValues(new Uint8Array(32));
      const nonce = webCrypto().getRandomValues(new Uint8Array(12));
      const cc = nc.createCipheriv('chacha20-poly1305', key32, nonce, { authTagLength: 16 });
      const sealed = new Uint8Array([...cc.update(data), ...cc.final(), ...(cc.getAuthTag?.() ?? [])]);
      assert(new TextDecoder().decode(chacha20Poly1305Decrypt(key32, nonce, sealed)) === 'bulwark self-test', 'chacha');
    }],
    ['OpenPGP: curve25519 key, sign + encrypt, decrypt + verify', async () => {
      const openpgp = await import('openpgp');
      const { privateKey, publicKey } = await openpgp.generateKey({ type: 'ecc', curve: 'curve25519Legacy', userIDs: [{ email: 'self-test@example.org' }], format: 'object' });
      const armored = await openpgp.encrypt({ message: await openpgp.createMessage({ text: 'ok' }), encryptionKeys: publicKey, signingKeys: privateKey });
      const res = await openpgp.decrypt({ message: await openpgp.readMessage({ armoredMessage: armored as string }), decryptionKeys: privateKey, verificationKeys: publicKey, expectSigned: true });
      assert(res.data === 'ok', 'decrypt');
    }],
    ['OpenPGP: RSA key', async () => {
      const openpgp = await import('openpgp');
      const { privateKey, publicKey } = await openpgp.generateKey({ type: 'rsa', rsaBits: 2048, userIDs: [{ email: 'self-test@example.org' }], format: 'object' });
      const signed = await openpgp.sign({ message: await openpgp.createMessage({ text: 'ok' }), signingKeys: privateKey });
      const v = await openpgp.verify({ message: await openpgp.readMessage({ armoredMessage: signed as string }), verificationKeys: publicKey, expectSigned: true });
      assert(v.data === 'ok', 'verify');
    }],
    ['S/MIME: certificate signature (pkijs)', async () => {
      const pkijs = await import('pkijs');
      const asn1js = await import('asn1js');
      const { smimeEngine } = await import('./smime/engine');
      const engine = smimeEngine();
      const keys = await subtle().generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
      const cert = new pkijs.Certificate();
      cert.version = 2;
      cert.serialNumber = new asn1js.Integer({ value: 1 });
      const cn = () => new pkijs.AttributeTypeAndValue({ type: '2.5.4.3', value: new asn1js.Utf8String({ value: 'self-test' }) });
      cert.subject.typesAndValues.push(cn());
      cert.issuer.typesAndValues.push(cn());
      cert.notBefore.value = new Date();
      cert.notAfter.value = new Date(Date.now() + 86400_000);
      await cert.subjectPublicKeyInfo.importKey(keys.publicKey, engine);
      await cert.sign(keys.privateKey, 'SHA-256', engine);
      const parsed = pkijs.Certificate.fromBER(toArrayBuffer(new Uint8Array(cert.toSchema().toBER(false))));
      assert(await parsed.verify(undefined, engine), 'verify');
    }],
  ];
}

/** Run every check; each one reports on its own. */
export async function runCryptoSelfTest(): Promise<SelfTestResult[]> {
  const out: SelfTestResult[] = [];
  for (const [name, run] of checks()) {
    try {
      await run();
      out.push({ name, ok: true });
    } catch (err) {
      out.push({ name, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}
