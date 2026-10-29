/**
 * What device sync reads from a JMAP session: the accounts that hold address
 * books or calendars, and the user's own calendar addresses.
 */
import { JMAP_CORE, type JmapSessionView } from '../types';
import type { JmapCaller } from './caller';

const JMAP_SUBMISSION = 'urn:ietf:params:jmap:submission';

export interface CapabilityAccount {
  id: string;
  name: string;
  /** The capability's primary account (the user's own). */
  primary: boolean;
  /**
   * Collections of the personal account are selected by default, those of the others are not. It is the
   * capability's primary account only, whatever `isPersonal` says: one rule with the app's chooser and
   * reminder filter, which know only the primary account per authority.
   */
  personal: boolean;
  readOnly: boolean;
}

/**
 * The primary account of the capability (`primaryAccounts[capability]`)
 * first, then every other account that advertises it (shared accounts).
 */
export function accountsWithCapability(session: JmapSessionView, capability: string): CapabilityAccount[] {
  const out: CapabilityAccount[] = [];
  const primary = session.primaryAccounts?.[capability];
  const add = (id: string, isPrimary: boolean) => {
    const account = session.accounts?.[id];
    if (!account || out.some((a) => a.id === id)) return;
    out.push({
      id,
      name: account.name || id,
      primary: isPrimary,
      personal: isPrimary,
      readOnly: !!account.isReadOnly,
    });
  };
  if (primary) add(primary, true);
  for (const [id, account] of Object.entries(session.accounts ?? {})) {
    if (id !== primary && account.accountCapabilities && capability in account.accountCapabilities) add(id, false);
  }
  return out;
}

export interface CalendarAddresses {
  /** `OWNER_ACCOUNT` of our calendars: never empty (Etar crashes on a null owner). */
  ownerAccount: string;
  /** Every address of the user, lowercase, without `mailto:`. */
  selfAddresses: string[];
}

function normalizeAddress(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const address = value.trim().replace(/^mailto:/i, '').toLowerCase();
  return address.includes('@') ? address : null;
}

/**
 * The login when it is an email address, else the first identity's address;
 * aliases from identities count as "me" too (docs/device-sync.md,
 * "Decisions"). Identities are read only when the session offers
 * submission; a server without `Identity/get` leaves the login.
 */
export async function calendarAddresses(caller: JmapCaller, fallbackName: string): Promise<CalendarAddresses> {
  const session = caller.session();
  const login = normalizeAddress(session.username);
  const identities: string[] = [];
  const submissionAccount = session.primaryAccounts?.[JMAP_SUBMISSION];
  if (submissionAccount) {
    try {
      const body = await caller.call<{ list?: Array<{ email?: string }> }>(
        'Identity/get',
        { accountId: submissionAccount, properties: ['email'] },
        [JMAP_CORE, JMAP_SUBMISSION],
      );
      for (const identity of body.list ?? []) {
        const address = normalizeAddress(identity.email);
        if (address) identities.push(address);
      }
    } catch {
      // Without identities the login is the only address we know.
    }
  }
  const selfAddresses = [...new Set([...(login ? [login] : []), ...identities])];
  const ownerAccount = login ?? identities[0] ?? (session.username || fallbackName).toLowerCase();
  return { ownerAccount, selfAddresses: selfAddresses.length ? selfAddresses : [ownerAccount] };
}
