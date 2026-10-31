// Make Node look like the app's Hermes runtime for the PGP tests (#58).
//
// Hermes has no Symbol.species: Array methods on a subclass (openpgp's
// PacketList) return a plain Array. It has no WebAssembly and no
// (De)CompressionStream. Web streams exist in the app only as the polyfill
// Expo injects (expo/virtual/streams.js); a headless task may run without it.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { vi } from 'vitest';

const STREAM_GLOBALS = ['ReadableStream', 'WritableStream', 'TransformStream'] as const;

function expoStreams(): Record<string, unknown> {
  const req = createRequire(import.meta.url);
  const file = path.join(path.dirname(req.resolve('expo/package.json')), 'virtual', 'streams.js');
  const target: Record<string, unknown> = {};
  // The polyfill installs on `globalThis`; hand it a stand-in instead.
  new Function('globalThis', readFileSync(file, 'utf8'))(target);
  return target;
}

/** Strip what Hermes lacks; returns a function that puts it back. */
export function useHermesRuntime(streams: 'expo' | 'none'): () => void {
  const species = Object.getOwnPropertyDescriptor(Array, Symbol.species);
  delete (Array as unknown as Record<symbol, unknown>)[Symbol.species];
  vi.stubGlobal('WebAssembly', undefined);
  vi.stubGlobal('CompressionStream', undefined);
  vi.stubGlobal('DecompressionStream', undefined);
  const polyfill = streams === 'expo' ? expoStreams() : {};
  for (const name of STREAM_GLOBALS) vi.stubGlobal(name, polyfill[name]);
  return () => {
    if (species) Object.defineProperty(Array, Symbol.species, species);
    vi.unstubAllGlobals();
  };
}
