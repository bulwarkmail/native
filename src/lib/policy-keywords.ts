import type { KeywordDef } from '../stores/keywords-store';
import { keywordColorFromPalette } from './shared-tags';

// The admin's default tags (policy `defaults.emailKeywords`, webmail #1612,
// stores/settings-store.ts policyKeywordList): the tags a user starts with
// until they change their own. An empty list is a choice too: no tags.

/** The most tags a `defaults.emailKeywords` list may hold. */
const MAX_POLICY_KEYWORDS = 50;
/** Longest tag name (webmail MAX_KEYWORD_LABEL_LENGTH). */
const MAX_LABEL = 255;
// RFC 8621 keywords are at most 128 bytes, `$label:` included.
const MAX_ID = 128 - '$label:'.length;
const BAD_ID_CHARS = /[\s(){\]%*"\\]/;

function validId(id: string): boolean {
  if (!id || id.length > MAX_ID || BAD_ID_CHARS.test(id)) return false;
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u001f\u007f]/.test(id);
}

/**
 * A `defaults.emailKeywords` value reduced to id, name and colour, or null
 * when it isn't one: at most 50 tags, each with a valid, unique id (without
 * case) and a name. A colour the app's palette lacks shows grey; the
 * webmail's light and dark shades take the app's one.
 */
export function policyKeywordList(value: unknown): KeywordDef[] | null {
  if (!Array.isArray(value) || value.length > MAX_POLICY_KEYWORDS) return null;
  const seen = new Set<string>();
  const out: KeywordDef[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const { id, label, color } = entry as Record<string, unknown>;
    if (typeof id !== 'string' || !validId(id) || seen.has(id.toLowerCase())) return null;
    if (typeof label !== 'string' || label.trim().length === 0 || label.length > MAX_LABEL) return null;
    if (typeof color !== 'string') return null;
    seen.add(id.toLowerCase());
    out.push({ id, label: label.trim(), color: keywordColorFromPalette(color) });
  }
  return out;
}
