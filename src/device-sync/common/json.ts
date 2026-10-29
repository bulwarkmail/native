/**
 * JSON helpers for comparing server objects, shadows and baselines by value.
 * Pure: device sync's mappers, merge rules and engine build on them.
 */
import { sha256Hex } from '../../lib/sha256';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** JSON with object keys sorted and `undefined` members dropped, so equal values give equal text. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): Json {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : canonicalize(v)));
  if (typeof value === 'object') {
    const out: { [key: string]: Json } = {};
    for (const key of Object.keys(value as object).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = canonicalize(v);
    }
    return out;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  return value as Json;
}

/** Structural equality of JSON values; key order and `undefined` members don't matter. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || a === null || b === null) {
    return (a ?? null) === (b ?? null);
  }
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === 'object') {
    if (Array.isArray(b)) return false;
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
    for (const key of keys) if (!deepEqual(ao[key], bo[key])) return false;
    return true;
  }
  return false;
}

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** SHA-256 (hex) of the canonical JSON of a value. */
export function jsonHash(value: unknown): string {
  return sha256Hex(utf8(canonicalJson(value)));
}

/** Parses JSON a sync column holds; null for empty or unreadable text (a column another app wrote). */
export function parseJsonColumn<T>(text: unknown): T | null {
  if (typeof text !== 'string' || !text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}
