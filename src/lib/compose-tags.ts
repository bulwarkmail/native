// Tags on a message being written (webmail composer Tags menu, #1610):
// replies and forwards start with the original's tags, drafts keep them and
// the sent copy carries them.

import { getEmailTagIds, KEYWORD_PREFIX } from './thread-utils';

/** RFC 8621 section 4.1.1: printable ASCII without ( ) { ] % * " and the backslash. */
const KEYWORD_SYNTAX = /^[\x21-\x7e]{1,255}$/;
const FORBIDDEN = /[(){\]%*"\\]/;

/** The tag keywords (`$label:<id>`) a message starts with, from its keywords. */
export function initialTagTokens(keywords: Record<string, boolean> | null | undefined): string[] {
  return getEmailTagIds(keywords ?? undefined).map((id) => `${KEYWORD_PREFIX}${id}`);
}

/** Add or take away one tag, keeping the order they were added in. */
export function toggleTagToken(tokens: string[], token: string, on: boolean): string[] {
  if (on) return tokens.includes(token) ? tokens : [...tokens, token];
  return tokens.filter((x) => x !== token);
}

/**
 * The tag keywords that go on the draft or the sent copy: only `$label:`
 * tags with a valid keyword, each once. The host's own keywords ($seen,
 * $draft) are set by the caller.
 */
export function outgoingTagKeywordMap(tokens: readonly string[] | undefined): Record<string, true> {
  const out: Record<string, true> = {};
  const seen = new Set<string>();
  for (const token of tokens ?? []) {
    if (typeof token !== 'string' || !token.startsWith(KEYWORD_PREFIX) || token.length <= KEYWORD_PREFIX.length) continue;
    if (!KEYWORD_SYNTAX.test(token) || FORBIDDEN.test(token)) continue;
    const key = token.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out[token] = true;
  }
  return out;
}

/** The selected tags as the keywords map of a stand-in message, for the tag sheet's ticks. */
export function tagTokensAsKeywords(tokens: readonly string[]): Record<string, boolean> {
  return Object.fromEntries(tokens.map((token) => [token, true]));
}
