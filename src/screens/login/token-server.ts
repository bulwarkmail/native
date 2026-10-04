// The server the access-token step starts with. A token is a credential for
// one server, so it may only be pre-filled from a server the user typed or
// confirmed in this sign-in flow. Never from the accounts already on the
// device: an "add account" for another provider would otherwise offer the
// active account's server and one tap would send the new token there.
export function tokenServerPrefill(flow: { serverUrl: string }): string {
  return flow.serverUrl.trim();
}
