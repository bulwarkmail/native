import { jmapClient } from './jmap-client';

/**
 * The connection one operation runs on, and the JMAP account it acts on.
 * Taken once when the operation starts and passed to each of its requests,
 * so a later request never goes out on a connection that replaced it:
 * account ids repeat across servers (Stalwart numbers accounts per server, so
 * two servers' first users are both `c`), and a session check alone would
 * let A's operation finish on B.
 */
export interface OpScope {
  /** The connection's generation (`jmapClient.connectionGen`). */
  readonly gen: number;
  readonly accountId: string;
}

/**
 * How an API helper is told which account to act on: a scope its caller took
 * (binding it to that connection), a bare JMAP account id, or nothing for the
 * user's own account. The last two take the live connection at call time.
 */
export type AccountRef = string | OpScope | undefined;

/** The scope `account` names, taken from the live connection unless given. */
export function opScope(account?: AccountRef): OpScope {
  if (typeof account === 'object' && account !== null) return account;
  return { gen: jmapClient.connectionGen, accountId: account ?? jmapClient.accountId };
}

/**
 * `at` for JMAP account `accountId` on the same connection (undefined: the
 * account `at` already names, the user's own for a scope from `opScope()`).
 */
export function inAccount(at: OpScope, accountId: string | undefined): OpScope {
  return accountId && accountId !== at.accountId ? { gen: at.gen, accountId } : at;
}
