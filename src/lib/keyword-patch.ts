/**
 * Keyword changes as an `Email/set` update sends them: one
 * `keywords/<name>` pointer per keyword, `true` to set it and `null` (or
 * `false`) to clear it. Keywords the patch does not name are left alone.
 *
 * Sending the whole `keywords` map instead replaces it on the server, which
 * erases whatever the local copy lacked: a star or tag another client set
 * since the list loaded, or everything on a message that was never loaded.
 */
export type KeywordPatch = Record<string, boolean | null>;

/** `keywords` with `patch` applied: the local mirror of the server update. */
export function applyKeywordPatch(
  keywords: Record<string, boolean> | undefined,
  patch: KeywordPatch,
): Record<string, boolean> {
  const next = { ...keywords };
  for (const [keyword, value] of Object.entries(patch)) {
    if (value) next[keyword] = true;
    else delete next[keyword];
  }
  return next;
}

/**
 * The patch that undoes `patch` on a message whose keywords were `original`
 * before it: each keyword the patch touched goes back to what it was, and
 * nothing else changes.
 */
export function revertKeywordPatch(
  patch: KeywordPatch,
  original: Record<string, boolean> | undefined,
): KeywordPatch {
  const revert: KeywordPatch = {};
  for (const keyword of Object.keys(patch)) {
    revert[keyword] = original?.[keyword] ? true : null;
  }
  return revert;
}
