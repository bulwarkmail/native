// Sign-out and export rules for the per-account shared calendar colour keys
// (sharedCalendarColorKey in calendar-utils). Kept apart, importing nothing,
// so the settings store can use them without importing calendar-utils,
// which reaches the settings store through calendar-timezone.

/**
 * Whether an override key is in the old shape (`accountId|originalId`,
 * legacySharedCalendarColorKey), which names no app account.
 */
export function isLegacyCalendarColorKey(key: string): boolean {
  return key.split('|').length <= 2;
}

/**
 * Whether app account `appAccountId` may read the old keys: only the
 * accounts registered at the upgrade (`readers`, seeded once), each until
 * it has claimed them. Null means not yet seeded (before the first start
 * after the upgrade), when the registered accounts still read them, but
 * never one signed in while the list was unseeded (`nonReaders`): that one
 * is new, though a later seed finds it registered.
 */
export function readsLegacyCalendarColors(
  readers: readonly string[] | null,
  appAccountId: string,
  nonReaders: readonly string[] = [],
): boolean {
  if (!appAccountId) return false;
  return readers === null ? !nonReaders.includes(appAccountId) : readers.includes(appAccountId);
}

/** The overrides without the old keys (once no account is left to claim them). */
export function withoutLegacyCalendarColors(overrides: Record<string, string>): Record<string, string> {
  if (!Object.keys(overrides).some(isLegacyCalendarColorKey)) return overrides;
  return Object.fromEntries(Object.entries(overrides).filter(([k]) => !isLegacyCalendarColorKey(k)));
}

/**
 * The overrides after a settings import: `current`, with each old-shape key
 * in the file written as the shown app account's (over its own). Keys in
 * the file with more parts are ignored: they name an app account the file
 * can't vouch for. With no account shown, the file colours nothing.
 */
export function importedCalendarColors(
  current: Record<string, string>,
  fromFile: Record<string, string>,
  appAccountId: string | null,
): Record<string, string> {
  if (!appAccountId) return current;
  const out = { ...current };
  for (const [key, color] of Object.entries(fromFile)) {
    if (isLegacyCalendarColorKey(key)) out[`${appAccountId}|${key}`] = color;
  }
  return out;
}

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
 * The overrides a settings export carries: the shown app account's own, in
 * the old shape (the one webmail reads), over the old keys while that
 * account may still read them (`readsLegacy`, readsLegacyCalendarColors).
 * No other app account's go in the file: their keys name the account
 * (`user@server`), and webmail can't use them. Nor do old keys the account
 * may no longer read: they may be another account's, and an import stores
 * what the file holds as the shown account's (importedCalendarColors).
 * Nothing without an account shown.
 */
export function exportableCalendarColors(
  overrides: Record<string, string>,
  appAccountId: string | null,
  readsLegacy: boolean,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!appAccountId) return out;
  if (readsLegacy) {
    for (const [key, color] of Object.entries(overrides)) {
      if (isLegacyCalendarColorKey(key)) out[key] = color;
    }
  }
  for (const [key, color] of Object.entries(overrides)) {
    if (isAccountColorKey(key, appAccountId)) out[key.slice(appAccountId.length + 1)] = color;
  }
  return out;
}
