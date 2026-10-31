// utf8.ts: pass.json decoding where Hermes lacks a fatal TextDecoder.
import { afterEach, describe, expect, it } from 'vitest';
import { readPassJson } from '../pkpass';
import { decodeByHand, decodeUtf8Strict } from '../utf8';
import { boardingPass, zipPass } from './pkpass-fixtures';

const encode = (text: string) => new TextEncoder().encode(text);
const original = globalThis.TextDecoder;

afterEach(() => {
  globalThis.TextDecoder = original;
});

describe('decodeByHand', () => {
  it('decodes what TextEncoder wrote, from ASCII to astral characters', () => {
    const text = 'Zürich → 東京 \u{1F6EB} ok';
    expect(decodeByHand(encode(text))).toBe(text);
    const long = 'é'.repeat(10_000);
    expect(decodeByHand(encode(long))).toBe(long);
  });

  it('throws on malformed input as a fatal decoder does', () => {
    for (const bad of [[0xc3], [0xff], [0xc0, 0x80], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xe2, 0x28, 0xa1]]) {
      expect(() => decodeByHand(new Uint8Array(bad))).toThrow();
      expect(() => new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bad))).toThrow();
    }
  });
});

describe('decodeUtf8Strict without TextDecoder', () => {
  it('still reads a Wallet pass', async () => {
    const bytes = await zipPass(boardingPass());
    (globalThis as { TextDecoder?: unknown }).TextDecoder = undefined;
    expect(decodeUtf8Strict(encode('Köln'))).toBe('Köln');
    expect(await readPassJson(bytes)).toMatchObject({ formatVersion: 1 });
  });

  it('falls back when the decoder refuses the fatal option', () => {
    globalThis.TextDecoder = class {
      constructor(_label?: string, options?: { fatal?: boolean }) {
        if (options?.fatal) throw new RangeError('fatal is not supported');
      }
      decode(): string { return 'wrong'; }
    } as unknown as typeof TextDecoder;
    expect(decodeUtf8Strict(encode('Köln'))).toBe('Köln');
    expect(() => decodeUtf8Strict(new Uint8Array([0xc3]))).toThrow();
  });
});
