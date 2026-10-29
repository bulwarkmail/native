import { describe, expect, it } from 'vitest';
import { canonicalJson, deepEqual, jsonHash, parseJsonColumn } from '../common/json';
import { applyPatch, assertPatchWellFormed, ptr, ptrSegments, setInPatch } from '../common/patch';
import {
  exceptionRef,
  makeKeyMinter,
  objectRef,
  parseObjectRef,
  pendingRef,
  pendingUidOf,
  uuidFrom,
} from '../common/ids';

function seeded(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
}

describe('common/json', () => {
  it('compares and hashes independently of key order and undefined members', () => {
    const a = { b: 1, a: { d: [1, { y: 2, x: 1 }], c: undefined } };
    const b = { a: { d: [1, { x: 1, y: 2 }] }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(deepEqual(a, b)).toBe(true);
    expect(jsonHash(a)).toBe(jsonHash(b));
    expect(deepEqual({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
    expect(deepEqual({ a: null }, {})).toBe(true);
  });

  it('reads sync columns defensively', () => {
    expect(parseJsonColumn('{"v":1}')).toEqual({ v: 1 });
    expect(parseJsonColumn('not json')).toBeNull();
    expect(parseJsonColumn(null)).toBeNull();
  });
});

describe('common/patch', () => {
  it('escapes pointer segments', () => {
    expect(ptr('emails', 'x/y', 'label')).toBe('emails/x~1y/label');
    expect(ptrSegments('emails/x~1y/a~0b')).toEqual(['emails', 'x/y', 'a~b']);
  });

  it('applies patches like Stalwart, refusing a missing parent', () => {
    const card = { emails: { e1: { address: 'a@x' } }, name: { full: 'A' } };
    expect(applyPatch(card, { 'emails/e1/address': 'b@x', 'emails/e2': { address: 'c@x' }, 'name/full': null })).toEqual({
      emails: { e1: { address: 'b@x' }, e2: { address: 'c@x' } },
      name: {},
    });
    expect(applyPatch(card, { 'phones/p1': { number: '1' } })).toBeNull();
    expect(card.emails.e1.address).toBe('a@x');
  });

  it('keeps patches free of overlapping pointers', () => {
    expect(() => assertPatchWellFormed({ emails: {}, 'emails/e1': null })).toThrow(/prefix/);
    const patch: Record<string, unknown> = { 'emails/e1/label': 'Office' };
    setInPatch(patch, 'emails', { e1: { address: 'a@x', label: 'Office' } });
    expect(patch).toEqual({ emails: { e1: { address: 'a@x', label: 'Office' } } });
    setInPatch(patch, 'emails/e1/address', 'b@x');
    expect(patch).toEqual({ emails: { e1: { address: 'b@x', label: 'Office' } } });
    assertPatchWellFormed(patch);
  });
});

describe('common/ids', () => {
  it('mints keys Stalwart treats as plain keys', () => {
    const mint = makeKeyMinter(seeded(7));
    const keys = Array.from({ length: 50 }, () => mint());
    for (const key of keys) {
      expect(key).toMatch(/^b[0-9a-z]{8}$/);
      expect(key).not.toMatch(/^k\d+$/);
    }
    expect(new Set(keys).size).toBe(keys.length);
    const again = makeKeyMinter(() => 0);
    expect(again(['b00000000'])).not.toBe('b00000000');
  });

  it('builds v4 uuids and object refs', () => {
    expect(uuidFrom(seeded(1))).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(objectRef('c', 'e9')).toBe('c/e9');
    expect(parseObjectRef('c/e9')).toEqual({ accountId: 'c', id: 'e9' });
    expect(parseObjectRef(pendingRef('u1'))).toBeNull();
    expect(pendingUidOf(pendingRef('urn:uuid:1'))).toBe('urn:uuid:1');
    expect(exceptionRef('c/e9', '2026-10-07T09:00:00')).toBe('c/e9#2026-10-07T09:00:00');
  });
});
