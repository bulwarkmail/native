// The encryption self-test (#58) passes on a complete crypto and names the
// check that fails on one with a gap.
import { describe, expect, it, vi, afterEach } from 'vitest';
import { runCryptoSelfTest } from '../self-test';
import { useNodeCrypto } from './helpers';
import { setNodeStyleCrypto } from '../provider';
import { useHermesRuntime } from './hermes-runtime';

let restoreRuntime: (() => void) | null = null;

afterEach(() => {
  restoreRuntime?.();
  restoreRuntime = null;
  vi.unstubAllGlobals();
  useNodeCrypto();
});

describe('runCryptoSelfTest', () => {
  it('passes every check on a complete crypto', async () => {
    useNodeCrypto();
    const results = await runCryptoSelfTest();
    expect(results.filter((r) => !r.ok)).toEqual([]);
    expect(results.length).toBeGreaterThan(10);
  }, 60_000);

  // Hermes has no Symbol.species; openpgp's verify broke on it (#58).
  it('passes the OpenPGP checks on a Hermes-like runtime', async () => {
    useNodeCrypto();
    restoreRuntime = useHermesRuntime('expo');
    const results = await runCryptoSelfTest();
    expect(results.filter((r) => r.name.startsWith('OpenPGP'))).toEqual([
      { name: 'OpenPGP: curve25519 key, sign + encrypt, decrypt + verify', ok: true },
      { name: 'OpenPGP: RSA key', ok: true },
    ]);
  }, 60_000);

  it('reports the checks a missing algorithm breaks, and keeps going', async () => {
    useNodeCrypto();
    const real = globalThis.crypto;
    const subtle = new Proxy(real.subtle, {
      get(target, prop) {
        if (prop === 'generateKey') {
          return (alg: AlgorithmIdentifier, ...rest: unknown[]) => {
            if ((typeof alg === 'string' ? alg : alg.name) === 'Ed25519') return Promise.reject(new Error('Ed25519 not supported'));
            return (target.generateKey as (...a: unknown[]) => unknown).call(target, alg, ...rest);
          };
        }
        const v = Reflect.get(target, prop);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    vi.stubGlobal('crypto', { subtle, getRandomValues: real.getRandomValues.bind(real) });
    setNodeStyleCrypto(() => { throw new Error('no native module'); });
    const results = await runCryptoSelfTest();
    const failed = results.filter((r) => !r.ok).map((r) => r.name);
    expect(failed).toContain('Ed25519 / X25519');
    expect(failed).toContain('3DES / ChaCha20-Poly1305 (legacy and Stalwart at-rest mail)');
    expect(results.find((r) => r.name === 'AES-GCM')?.ok).toBe(true);
  }, 60_000);
});
