import { DEFAULT_RELAY_BASE_URL, setStoredRelayBaseUrl } from './push-notifications';

/**
 * Put an account back on the hosted relay. With push on, the account is
 * re-registered there through `reregister` (which stores the relay itself):
 * renewals skip an account with no stored relay, so a bare clear would leave
 * its registration on the old one. With push off, the stored value is cleared.
 */
export async function resetPushRelay(
  appAccountId: string,
  pushEnabled: boolean,
  reregister: (relayBaseUrl: string) => Promise<void>,
): Promise<void> {
  if (pushEnabled) {
    await reregister(DEFAULT_RELAY_BASE_URL);
  } else {
    await setStoredRelayBaseUrl(null, appAccountId);
  }
}
