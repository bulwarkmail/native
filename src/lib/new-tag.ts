import type { KeywordColor, KeywordDef } from '../stores/keywords-store';
import { getParentKeywordId, KEYWORD_SEPARATOR } from './keyword-nesting';

// "New tag" in the tag pickers (webmail components/email/tag-picker.tsx,
// 19676a14f; ids from lib/keyword-nesting.ts).

/**
 * Longest keyword Stalwart keeps (1.0 refuses a longer one, 0.16 cuts it),
 * less the `$label:` prefix.
 */
export const MAX_KEYWORD_ID_LENGTH = 128 - '$label:'.length;

/** Palette row 1 of the webmail's tag colours: a new tag takes the next one. */
export const NEW_TAG_PALETTE: KeywordColor[] = [
  'red', 'orange', 'amber', 'yellow', 'lime', 'green', 'teal', 'cyan', 'blue', 'indigo', 'purple', 'pink', 'gray',
];

/**
 * One level of a tag id from a display name: lowercase, everything outside
 * `[a-z0-9_-]` folded to a single dash (a slash typed into the name is part
 * of the name, not a level).
 */
export function normalizeKeywordLevel(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** The id a tag named `name` gets under `parentId` (null = top level). */
export function composeKeywordId(parentId: string | null, name: string): string {
  const level = normalizeKeywordLevel(name);
  if (!parentId || !level) return level;
  return `${parentId}/${level}`;
}

/**
 * A level for a name the slug can't stand for, such as `Работа` (nothing
 * left) or `Счета 1` next to `Банк 1` (both slug to `1`): `tag-` and a
 * 32-bit FNV-1a hash of the name in base 36. The same name always gives the
 * same level, and it is ASCII like every other id (webmail
 * lib/keyword-nesting.ts, #1613).
 */
export function generatedKeywordLevel(name: string): string {
  const text = name.trim().normalize('NFC').toLowerCase();
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
  }
  return `tag-${hash.toString(36)}`;
}

/**
 * The id a new or renamed tag called `name` gets under `parentId`, given the
 * ids other tags already have (compared without case, as servers fold
 * keywords to lowercase).
 *
 * A tag being edited (`currentId`, named `currentName` before the edit) that
 * stays under the same parent keeps its id when the name keeps its slug.
 * Otherwise the slug of the name when it has one that is free. Failing that,
 * a tag being renamed under the same parent keeps its id, and anything else
 * gets `generatedKeywordLevel`, with `-2`, `-3`... if even that is taken.
 * Empty only for an empty name.
 */
export function chooseKeywordId(
  parentId: string | null,
  name: string,
  takenIds: Iterable<string>,
  currentId?: string | null,
  currentName?: string,
): string {
  if (!name.trim()) return '';
  const samePlace = !!currentId && getParentKeywordId(currentId) === (parentId || null);
  if (samePlace && currentName !== undefined && normalizeKeywordLevel(name) === normalizeKeywordLevel(currentName)) {
    return currentId!;
  }
  const taken = new Set<string>();
  for (const id of takenIds) taken.add(id.toLowerCase());

  const slug = composeKeywordId(parentId, name);
  if (slug && !taken.has(slug)) return slug;
  if (samePlace) return currentId!;

  const level = generatedKeywordLevel(name);
  const join = (part: string) => (parentId ? `${parentId}${KEYWORD_SEPARATOR}${part}` : part);
  let id = join(level);
  for (let n = 2; taken.has(id); n++) id = join(`${level}-${n}`);
  return id;
}

/**
 * True when a tag directly under `parentId` (null = top level) already has
 * this name, ignoring case and surrounding spaces. `exceptId` is the tag
 * being renamed, which may keep its own name.
 */
export function isKeywordNameTaken(
  keywords: readonly Pick<KeywordDef, 'id' | 'label'>[],
  parentId: string | null,
  name: string,
  exceptId?: string,
): boolean {
  const wanted = name.trim().normalize('NFC').toLowerCase();
  if (!wanted) return false;
  return keywords.some(
    (keyword) =>
      keyword.id !== exceptId &&
      getParentKeywordId(keyword.id) === (parentId || null) &&
      (keyword.label ?? '').trim().normalize('NFC').toLowerCase() === wanted,
  );
}

export type NewTagError = 'tag_exists' | 'tag_name_invalid';

type TagRef = Pick<KeywordDef, 'id' | 'label'>;

/**
 * What a typed tag name would make: its id, and why it can't be made (null =
 * it can). A name is refused when a top-level tag already has it; a name
 * without a free slug gets a generated id instead.
 */
export function checkNewTag(name: string, keywords: readonly TagRef[]): { id: string; error: NewTagError | null } {
  const id = chooseKeywordId(null, name, keywords.map((k) => k.id));
  if (!name.trim()) return { id, error: null };
  if (isKeywordNameTaken(keywords, null, name)) return { id, error: 'tag_exists' };
  if (!id || id.length > MAX_KEYWORD_ID_LENGTH) return { id, error: 'tag_name_invalid' };
  return { id, error: null };
}

/** The definition for a new tag, or null when the name can't make one. */
export function newTagDefinition(name: string, keywords: readonly TagRef[]): KeywordDef | null {
  const { id, error } = checkNewTag(name, keywords);
  if (!name.trim() || error) return null;
  return { id, label: name.trim(), color: NEW_TAG_PALETTE[keywords.length % NEW_TAG_PALETTE.length] };
}
