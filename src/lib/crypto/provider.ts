// The crypto the PGP and S/MIME code (#58) runs on, beyond WebCrypto.
//
// openpgp and pkijs only need `globalThis.crypto` (getRandomValues + subtle).
// S/MIME mail still uses a few things WebCrypto has no names for: RSAES-
// PKCS1-v1_5 key transport, 3DES content encryption and ChaCha20-Poly1305
// (Stalwart's encryption at rest). Those go through a Node-style crypto
// module: react-native-quick-crypto in the app (src/lib/crypto/install-
// webcrypto.ts registers it), node:crypto in the tests. Both are OpenSSL.

/** The part of Node's crypto module this code uses. */
export interface NodeStyleCrypto {
  privateDecrypt(
    key: { key: unknown; format?: string; type?: string; padding?: number; oaepHash?: string },
    buffer: Uint8Array,
  ): Uint8Array;
  createDecipheriv(
    algorithm: string,
    key: Uint8Array,
    iv: Uint8Array,
    options?: { authTagLength?: number },
  ): {
    update(data: Uint8Array): Uint8Array;
    final(): Uint8Array;
    setAuthTag?(tag: Uint8Array): unknown;
    setAAD?(aad: Uint8Array, options?: { plaintextLength: number }): unknown;
    setAutoPadding?(on: boolean): unknown;
  };
  constants: { RSA_PKCS1_PADDING: number };
}

let load: (() => NodeStyleCrypto) | null = null;
let cached: NodeStyleCrypto | null = null;

/** Register where the Node-style crypto comes from (loaded on first use). */
export function setNodeStyleCrypto(loader: () => NodeStyleCrypto): void {
  load = loader;
  cached = null;
}

/** The registered Node-style crypto, or an error naming what is missing. */
export function nodeStyleCrypto(): NodeStyleCrypto {
  if (cached) return cached;
  if (!load) throw new Error('No native crypto module is available');
  cached = load();
  return cached;
}

/** The WebCrypto subtle the app installed, or an error the UI can show. */
export function webCrypto(): Crypto {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c?.subtle || !c.getRandomValues) throw new Error('The WebCrypto API is not available');
  return c;
}

/** Copy a view into a standalone ArrayBuffer (WebCrypto and pkijs want one). */
export function toArrayBuffer(view: ArrayBuffer | ArrayBufferView): ArrayBuffer {
  if (view instanceof ArrayBuffer) return view;
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
}

/** Concatenate byte arrays. */
export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

/** Decrypt RSAES-PKCS1-v1_5 (WebCrypto has no name for it) with a PKCS#8 key. */
export function rsaPkcs1Decrypt(pkcs8: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  const nc = nodeStyleCrypto();
  const out = nc.privateDecrypt(
    { key: pkcs8, format: 'der', type: 'pkcs8', padding: nc.constants.RSA_PKCS1_PADDING },
    ciphertext,
  );
  return new Uint8Array(out);
}

/** CBC decryption for ciphers WebCrypto lacks (3DES). PKCS#7 padding is removed. */
export function cbcDecrypt(algorithm: 'des-ede3-cbc', key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array {
  const d = nodeStyleCrypto().createDecipheriv(algorithm, key, iv);
  return concatBytes(new Uint8Array(d.update(data)), new Uint8Array(d.final()));
}

/** ChaCha20-Poly1305 (RFC 8103) decryption; the tag is the last 16 bytes of `sealed`. */
export function chacha20Poly1305Decrypt(key: Uint8Array, nonce: Uint8Array, sealed: Uint8Array, aad?: Uint8Array): Uint8Array {
  if (sealed.byteLength < 16) throw new Error('ChaCha20-Poly1305 ciphertext is too short');
  const d = nodeStyleCrypto().createDecipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
  const body = sealed.subarray(0, sealed.byteLength - 16);
  d.setAuthTag?.(sealed.subarray(sealed.byteLength - 16));
  if (aad) d.setAAD?.(aad, { plaintextLength: body.byteLength });
  return concatBytes(new Uint8Array(d.update(body)), new Uint8Array(d.final()));
}
