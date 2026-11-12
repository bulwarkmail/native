/**
 * Whether the mail drawer says out of office is on: the signed-in user's own
 * reply (the store can hold a shared account's, loaded in Settings), on, on
 * a server that has it.
 */
export function vacationBannerShown(state: {
  isEnabled: boolean; isSupported: boolean; hasLoaded: boolean; accountId: string | null;
}): boolean {
  return state.hasLoaded && state.isSupported && state.isEnabled && state.accountId === null;
}
