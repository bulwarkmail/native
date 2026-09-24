// The folder list the mail store holds (or is loading) for the signed-in
// account, for code below the stores that needs it too: the push filter's
// Junk folders. It used to send a full `Mailbox/get` of its own right next to
// the store's on every sign-in and start. The mail store registers the
// provider, so nothing here imports it.

import type { Mailbox } from '../api/types';

type Provider = (accountId: string) => Promise<Mailbox[] | null>;

let provider: Provider | null = null;

export function provideLoadedMailboxes(next: Provider | null): void {
  provider = next;
}

/**
 * The own and shared folders of `accountId` (the account registry id) once
 * the store has them, joining a sync that is on its way. Null when the store
 * serves another account or could not load them.
 */
export async function loadedMailboxes(accountId: string): Promise<Mailbox[] | null> {
  if (!provider) return null;
  try {
    return await provider(accountId);
  } catch {
    return null;
  }
}
