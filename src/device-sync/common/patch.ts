/**
 * JMAP PatchObjects (RFC 8620 §5.3): keys are JSON Pointers (RFC 6901)
 * relative to the object, values replace what they point at, `null` removes.
 *
 * Stalwart specifics the engine relies on (docs/device-sync.md, "Uploads"):
 * a pointer whose parent does not exist fails the whole update ("Patch
 * operation failed"), so the first entry of a map is sent as the whole map;
 * and no pointer may be a prefix of another in one patch.
 */
import { pointerToken, pointerTokenValue } from '../../api/patch-pointer';
import { clone } from './json';

export type PatchObject = Record<string, unknown>;

/** Joins raw member names into a pointer, escaping `~` and `/` in each. */
export function ptr(...segments: string[]): string {
  return segments.map(pointerToken).join('/');
}

/** The raw member names of a pointer. */
export function ptrSegments(pointer: string): string[] {
  return pointer.split('/').map(pointerTokenValue);
}

/**
 * Throws when one pointer of the patch is a prefix of another (RFC 8620
 * §5.3 makes that an invalidPatch), or when a pointer is empty.
 */
export function assertPatchWellFormed(patch: PatchObject): void {
  const keys = Object.keys(patch).sort();
  for (let i = 0; i < keys.length; i++) {
    if (!keys[i]) throw new Error('empty pointer in patch');
    if (i > 0 && keys[i].startsWith(`${keys[i - 1]}/`)) {
      throw new Error(`patch pointer ${keys[i - 1]} is a prefix of ${keys[i]}`);
    }
  }
}

/**
 * Applies a PatchObject to a copy of `target` the way Stalwart does. Returns
 * null when a pointer's parent does not exist (Stalwart rejects the update).
 * Array elements cannot be addressed; the engine never tries.
 */
export function applyPatch<T extends object>(target: T, patch: PatchObject): T | null {
  const out = clone(target) as Record<string, unknown>;
  for (const [pointer, value] of Object.entries(patch)) {
    const segments = ptrSegments(pointer);
    let parent: Record<string, unknown> = out;
    for (let i = 0; i < segments.length - 1; i++) {
      const next = parent[segments[i]];
      if (next === null || typeof next !== 'object' || Array.isArray(next)) return null;
      parent = next as Record<string, unknown>;
    }
    const leaf = segments[segments.length - 1];
    if (value === null) delete parent[leaf];
    else parent[leaf] = clone(value);
  }
  return out as T;
}

/**
 * Adds `value` at `pointer` to a patch, unless a shorter pointer of the patch
 * already covers it (then the covering value is updated instead).
 */
export function setInPatch(patch: PatchObject, pointer: string, value: unknown): void {
  for (const existing of Object.keys(patch)) {
    if (pointer === existing) {
      patch[existing] = value;
      return;
    }
    if (pointer.startsWith(`${existing}/`)) {
      const covered = patch[existing];
      if (covered === null || typeof covered !== 'object') {
        throw new Error(`cannot patch ${pointer} below ${existing}, which is set to a scalar`);
      }
      const rest = pointer.slice(existing.length + 1);
      const applied = applyPatch(covered as object, { [rest]: value });
      if (!applied) throw new Error(`cannot patch ${pointer}: missing parent below ${existing}`);
      patch[existing] = applied;
      return;
    }
  }
  // A new covering pointer replaces the longer pointers it covers.
  for (const existing of Object.keys(patch)) {
    if (existing.startsWith(`${pointer}/`)) delete patch[existing];
  }
  patch[pointer] = value;
}
