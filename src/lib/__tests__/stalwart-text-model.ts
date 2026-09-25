// A small model of how Stalwart's built-in search index matches one text
// filter value against one field, so tests can check what a filter finds on
// each version, not only its shape. It leaves out stemming and language
// detection. Same model as the webmail's lib/__tests__/search-utils.test.ts.
// - 1.0 (store/src/search/document.rs `has_text`): a value wrapped in `"` or
//   `'` is an exact phrase (word positions exist for subject and body only;
//   address fields fall back to all words); a value ending in `*` is one
//   prefix over the rest, lower-cased and not split into words, at most 16
//   bytes, matching words of at most 16 bytes; anything else needs all its
//   words in the same field.
// - 0.16: no phrases and no prefixes; every value needs all its words in the
//   same field, and `*` only separates words.

export type StalwartTextVersion = '0.16' | '1.0';

const wordsOf = (value: string): string[] => value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const byteLength = (value: string) => new TextEncoder().encode(value).length;

/** Whether `value` matches `field`; `hasPositions` for subject and body. */
export function textFieldMatches(
  version: StalwartTextVersion,
  value: string,
  field: string,
  hasPositions: boolean,
): boolean {
  const tokens = wordsOf(field);
  if (version === '1.0') {
    const exact = /^"([\s\S]*)"$/.exec(value) ?? /^'([\s\S]*)'$/.exec(value);
    if (exact) {
      const phrase = wordsOf(exact[1]);
      if (phrase.length === 0) return false;
      if (!hasPositions) return phrase.every((w) => tokens.includes(w));
      return tokens.some((_, i) => phrase.every((w, j) => tokens[i + j] === w));
    }
    if (value.endsWith('*')) {
      const prefix = value.slice(0, -1).trim().toLowerCase();
      if (!prefix || byteLength(prefix) > 16) return false;
      return tokens.some((t) => byteLength(t) <= 16 && t.startsWith(prefix));
    }
  }
  const words = wordsOf(value);
  return words.length > 0 && words.every((w) => tokens.includes(w));
}

export interface TextModelMessage {
  from?: string;
  to?: string;
  subject?: string;
  body?: string;
}

/**
 * Whether a message matches an Email/query filter made of text conditions
 * (`text`, `from`, `to`, `subject`, `body`) and AND/OR/NOT operators. `text`
 * is an OR over from, to, subject and body. Other keys are handed to
 * `other`, or throw.
 */
export function textFilterMatches(
  version: StalwartTextVersion,
  filter: Record<string, unknown>,
  message: TextModelMessage,
  other?: (key: string, value: unknown) => boolean,
): boolean {
  if ('operator' in filter) {
    const results = (filter.conditions as Record<string, unknown>[])
      .map((c) => textFilterMatches(version, c, message, other));
    if (filter.operator === 'AND') return results.every(Boolean);
    if (filter.operator === 'OR') return results.some(Boolean);
    return !results.some(Boolean);
  }
  return Object.entries(filter).every(([key, value]) => {
    const field = (name: keyof TextModelMessage, positions: boolean) =>
      textFieldMatches(version, String(value), message[name] ?? '', positions);
    switch (key) {
      case 'text':
        return field('from', false) || field('to', false) || field('subject', true) || field('body', true);
      case 'from':
      case 'to':
        return field(key, false);
      case 'subject':
      case 'body':
        return field(key, true);
      default:
        if (other) return other(key, value);
        throw new Error(`the text model has no ${key} condition`);
    }
  });
}
