// Sign-out and export rules for the per-account shared calendar colour keys
// (sharedCalendarColorKey in calendar-utils). Kept apart, importing nothing,
// so the settings store can use them without importing calendar-utils,
// which reaches the settings store through calendar-timezone.

// An override key is app account `appAccountId`'s when it opens with that id
// and still has both parts of the old key after it (sharedCalendarColorKey);
// `A|c1` is an old key whose JMAP account happens to be called A.
function isAccountColorKey(key: string, appAccountId: string): boolean {
  return key.startsWith(`${appAccountId}|`) && key.slice(appAccountId.length + 1).includes('|');
}

/** The overrides without app account `appAccountId`'s (on sign-out). Old keys stay. */
export function withoutAccountCalendarColors(
  overrides: Record<string, string>,
  appAccountId: string,
): Record<string, string> {
  if (!appAccountId || !Object.keys(overrides).some((k) => isAccountColorKey(k, appAccountId))) return overrides;
  return Object.fromEntries(Object.entries(overrides).filter(([k]) => !isAccountColorKey(k, appAccountId)));
}

/**
 * The overrides a settings export carries: the old keys, with the shown app
 * account's own overrides written over them in the old shape (the one
 * webmail reads). No other app account's go in the file: their keys name
 * the account (`user@server`), and webmail can't use them. An import stores
 * what the file holds as old keys, which every app account reads.
 */
export function exportableCalendarColors(
  overrides: Record<string, string>,
  appAccountId: string | null,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, color] of Object.entries(overrides)) {
    if (key.split('|').length <= 2) out[key] = color;
  }
  if (appAccountId) {
    for (const [key, color] of Object.entries(overrides)) {
      if (isAccountColorKey(key, appAccountId)) out[key.slice(appAccountId.length + 1)] = color;
    }
  }
  return out;
}
