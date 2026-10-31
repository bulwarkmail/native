import type { KeywordColor, KeywordDef } from '../stores/keywords-store';

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

export type NewTagError = 'tag_exists' | 'tag_name_invalid';

/** What a typed tag name would make: its id, and why it can't be made (null = it can). */
export function checkNewTag(name: string, keywords: readonly Pick<KeywordDef, 'id'>[]): { id: string; error: NewTagError | null } {
  const id = composeKeywordId(null, name);
  if (!name.trim()) return { id, error: null };
  if (keywords.some((k) => k.id === id)) return { id, error: 'tag_exists' };
  if (!id || id.length > MAX_KEYWORD_ID_LENGTH) return { id, error: 'tag_name_invalid' };
  return { id, error: null };
}

/** The definition for a new tag, or null when the name can't make one. */
export function newTagDefinition(name: string, keywords: readonly Pick<KeywordDef, 'id'>[]): KeywordDef | null {
  const { id, error } = checkNewTag(name, keywords);
  if (!name.trim() || error) return null;
  return { id, label: name.trim(), color: NEW_TAG_PALETTE[keywords.length % NEW_TAG_PALETTE.length] };
}
