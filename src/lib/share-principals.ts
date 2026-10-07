/** Where a share sheet's principal list was asked for: app account and connection. */
export interface PrincipalsOrigin {
  appAccountId: string | null;
  /** `jmapClient.connectionGen` when the list was asked for. */
  gen: number;
}

/**
 * Whether a principal list asked for at `opened` may be shown, given what
 * holds `now`: the same app account still shown, on the same connection, and
 * the client serving it. In the switch window the client may still serve the
 * previous account, whose directory ids mean nothing on the shown one's server.
 */
export function principalsListUsable(
  opened: PrincipalsOrigin,
  now: PrincipalsOrigin & { served: boolean },
): boolean {
  return now.served && now.appAccountId === opened.appAccountId && now.gen === opened.gen;
}
