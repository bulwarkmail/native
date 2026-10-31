// The account's name in "Sync to this device": its address, plus the server
// when another signed-in account has the same address (usera@example.org on
// two servers showed two identical "Sync usera@example.org to this device").
import { serverHostLabel } from '../../../lib/account-utils';

interface LabelledAccount {
  id: string;
  email: string;
  username: string;
  serverUrl: string;
}

export function deviceSyncAccountLabel(account: LabelledAccount, accounts: readonly LabelledAccount[]): string {
  const address = account.email || account.username;
  const key = address.trim().toLowerCase();
  const twin = accounts.some((a) => a.id !== account.id && (a.email || a.username).trim().toLowerCase() === key);
  return twin ? `${address} (${serverHostLabel(account.serverUrl)})` : address;
}
