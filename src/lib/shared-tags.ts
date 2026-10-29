// Shared tags of a group account: the tag names and colours every member of
// a shared mailbox sees, kept in the metadata of the group's Inbox
// (namespace `org.bulwarkmail.tags`, src/api/bulwark-metadata.ts). Port of
// the reading half of the webmail's lib/shared-tags.ts (#1310, #470).
//
// Keywords in a group account are the same for every member, so
// `$label:urgent` on a team message is the team's tag; the shared
// definitions name it for everyone. Stored as a map by tag id,
// `{ "tags": { "<id>": { "label", "color", ... } } }`; the earlier
// `{ "list": [...] }` and bare-array shapes are read too. The app only
// reads them: editing them is the webmail's (Settings > Tags).

import { colors } from '../theme/tokens';
import type { KeywordColor, KeywordDef } from '../stores/keywords-store';

// keywords-store's FALLBACK_KEYWORD_COLOR; not imported, that store imports this module.
const FALLBACK_KEYWORD_COLOR: KeywordColor = 'gray';

/** The metadata key (namespace `org.bulwarkmail.tags`). */
export const SHARED_TAGS_KEY = 'tags';

/** Longest name a shared tag keeps, as in the webmail's tag editor. */
export const MAX_SHARED_TAG_LABEL = 30;

// RFC 8621 keywords are at most 128 bytes, `$label:` included.
const MAX_KEYWORD_ID_LENGTH = 128 - '$label:'.length;

/**
 * Characters RFC 8621 keywords can't hold (and whitespace), so a tag id
 * from the server that could never be on a message is dropped.
 */
const BAD_ID_CHARS = /[\s(){\]%*"\\]/;

function isKeywordSafe(id: string): boolean {
  if (!id || id.length > MAX_KEYWORD_ID_LENGTH || BAD_ID_CHARS.test(id)) return false;
  for (let i = 0; i < id.length; i++) {
    const code = id.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * The app's colour for a webmail palette key. The webmail has a light and a
 * dark shade of each colour (`blue-light`, `blue-dark`); the app has one.
 * A colour neither knows shows grey.
 */
export function keywordColorFromPalette(color: unknown): KeywordColor {
  if (typeof color !== 'string') return FALLBACK_KEYWORD_COLOR;
  const base = color.replace(/-(?:light|dark)$/, '');
  return Object.prototype.hasOwnProperty.call(colors.tags, base) ? base as KeywordColor : FALLBACK_KEYWORD_COLOR;
}

/** The raw entry of each tag by id, from any of the stored shapes. */
function entriesOf(value: unknown): Record<string, Record<string, unknown>> {
  const entries: Record<string, Record<string, unknown>> = {};
  if (isObject(value) && isObject(value.tags)) {
    for (const [id, entry] of Object.entries(value.tags)) {
      if (isKeywordSafe(id) && isObject(entry)) entries[id] = entry;
    }
    return entries;
  }
  const items = Array.isArray(value) ? value : isObject(value) && Array.isArray(value.list) ? value.list : [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!isObject(item) || typeof item.id !== 'string') continue;
    const id = item.id.trim();
    if (!isKeywordSafe(id) || seen.has(id.toLowerCase())) continue;
    seen.add(id.toLowerCase());
    entries[id] = item;
  }
  return entries;
}

/** The shared definitions in the namespace's value, by name. */
export function parseSharedTags(value: unknown): KeywordDef[] {
  return Object.entries(entriesOf(value))
    .map(([id, entry]) => {
      const label = typeof entry.label === 'string' ? entry.label.trim().slice(0, MAX_SHARED_TAG_LABEL) : '';
      return { id, label: label || id, color: keywordColorFromPalette(entry.color) };
    })
    .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
}

/**
 * What a message of a group account is tagged with: the shared definitions
 * first, then the member's own for ids nobody shared, so a tag on a team
 * message never loses its name just because the team didn't define it.
 * Ids compare without case, as keywords do.
 */
export function mergeSharedTags(shared: readonly KeywordDef[], personal: readonly KeywordDef[]): KeywordDef[] {
  if (shared.length === 0) return personal as KeywordDef[];
  const named = new Set(shared.map((d) => d.id.toLowerCase()));
  return [...shared, ...personal.filter((d) => !named.has(d.id.toLowerCase()))];
}
