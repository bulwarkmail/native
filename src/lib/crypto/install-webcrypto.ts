// Installs WebCrypto for the PGP and S/MIME code (#58). Hermes has no
// `crypto` global; openpgp throws "The WebCrypto API is not available" at
// its first operation without one, and pkijs only picks an engine when it
// finds one. react-native-quick-crypto (OpenSSL, native) provides it.
//
// Imported first thing in index.ts. Nothing native loads here: `subtle` and
// the Node-style module are required on first use, so an app start or a
// headless push task pays nothing until a key or an encrypted message is
// touched. getRandomValues comes from expo-crypto, which the app already
// loads for src/lib/random.ts.

import { setNodeStyleCrypto, type NodeStyleCrypto } from './provider';

type QuickCrypto = NodeStyleCrypto & { subtle: SubtleCrypto; getRandomValues<T extends ArrayBufferView>(a: T): T; randomUUID(): string };

let quick: QuickCrypto | null = null;
function quickCrypto(): QuickCrypto {
  if (!quick) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('react-native-quick-crypto') as { default?: QuickCrypto } & QuickCrypto;
    quick = (mod.default ?? mod) as QuickCrypto;
  }
  return quick;
}

function randomValues<T extends ArrayBufferView>(array: T): T {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const expo = require('expo-crypto') as { getRandomValues?: <V extends ArrayBufferView>(a: V) => V };
    if (expo.getRandomValues) return expo.getRandomValues(array);
  } catch {
    // fall through to OpenSSL
  }
  return quickCrypto().getRandomValues(array);
}

/** Put `crypto.subtle` / `crypto.getRandomValues` on the global, loading the native module lazily. */
export function installWebCrypto(target: Record<string, unknown> = globalThis as unknown as Record<string, unknown>): void {
  const existing = target.crypto as Record<string, unknown> | undefined;
  const crypto: Record<string, unknown> = existing && Object.isExtensible(existing) ? existing : { ...(existing ?? {}) };
  if (typeof crypto.getRandomValues !== 'function') crypto.getRandomValues = randomValues;
  if (typeof crypto.randomUUID !== 'function') crypto.randomUUID = () => quickCrypto().randomUUID();
  if (!crypto.subtle) {
    Object.defineProperty(crypto, 'subtle', {
      configurable: true,
      enumerable: true,
      get: () => quickCrypto().subtle,
    });
  }
  if (crypto !== existing) target.crypto = crypto;
  setNodeStyleCrypto(quickCrypto);
}

installWebCrypto();
