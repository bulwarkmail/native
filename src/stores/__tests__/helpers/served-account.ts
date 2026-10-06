import { useAccountStore } from '../../account-store';
import { generateAccountId } from '../../../lib/account-utils';

/**
 * Register the app account a test's mocked `jmapClient` serves (same server
 * and user), active, so the store's served-account check
 * (`clientServesAccount`) holds. Returns its app account id.
 */
export function registerServedAccount(username: string, serverUrl: string): string {
  const id = generateAccountId(username, serverUrl);
  useAccountStore.setState({
    accounts: [{
      id,
      serverUrl,
      username,
      displayName: username,
      email: username,
      avatarColor: '#000000',
      lastLoginAt: 0,
      isConnected: true,
      hasError: false,
      isDefault: true,
    }],
    activeAccountId: id,
  });
  return id;
}
