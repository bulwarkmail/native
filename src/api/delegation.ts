// Delegates (webmail JMAPClient.getShareTargets, applyShareChanges,
// findPrincipalByEmail and the capability checks Settings > Sharing uses):
// the JMAP side of giving someone access to mail, calendars and contacts in
// one step. The pure parts are in lib/delegation.

import { jmapClient } from './jmap-client';
import { CAPABILITIES, type JMAPMethodCall, type Principal } from './types';
import { getAllFileNodes, filesAccountId, supportsFiles } from './files';
import { batched } from './jmap-result';
import {
  SET_METHOD,
  buildShareSetCalls,
  failAll,
  parseShareTargets,
  readShareSetResults,
  type ShareChange,
  type ShareChangeResult,
  type ShareTarget,
} from '../lib/delegation/share-batch';
import type { AnyRights, ShareKind } from '../lib/delegation/share-rights';

export const MAIL_SHARE_CAPABILITY = 'urn:ietf:params:jmap:mail:share';

type MethodResponse = [string, Record<string, unknown>, string];

function accountCaps(accountId: string): Record<string, unknown> | undefined {
  return jmapClient.currentSession?.accounts?.[accountId]?.accountCapabilities;
}

/** The capability is in the account's own accountCapabilities (webmail hasAccountCapability). */
function hasAccountCapability(capability: string, accountId: string): boolean {
  const caps = accountCaps(accountId);
  return !!caps && capability in caps;
}

/**
 * Whether the user may use a capability's methods with an account (webmail
 * JMAPClient.accountSupports): the account's own list decides; a shared
 * account that lists nothing falls back to the server-wide capability.
 */
function accountSupports(accountId: string, capability: string): boolean {
  const session = jmapClient.currentSession;
  const account = session?.accounts?.[accountId];
  if (!account) return false;
  const caps = account.accountCapabilities;
  if (caps?.[capability]) return true;
  if (caps && Object.keys(caps).length > 0) return false;
  return account.isPersonal === false && !!session?.capabilities?.[capability];
}

export function getCalendarsAccountId(): string {
  return jmapClient.currentSession?.primaryAccounts?.[CAPABILITIES.CALENDARS] || jmapClient.accountId;
}

export function getContactsAccountId(): string {
  return jmapClient.currentSession?.primaryAccounts?.[CAPABILITIES.CONTACTS] || jmapClient.accountId;
}

/** Whether the account's server accepts `shareWith` on Mailbox objects. */
export function supportsMailboxSharing(accountId: string = jmapClient.accountId): boolean {
  return hasAccountCapability(MAIL_SHARE_CAPABILITY, accountId);
}

export function supportsCalendarSharing(accountId: string = getCalendarsAccountId()): boolean {
  return accountSupports(accountId, CAPABILITIES.CALENDARS);
}

export function supportsContactSharing(accountId: string = getContactsAccountId()): boolean {
  return accountSupports(accountId, CAPABILITIES.CONTACTS);
}

export function supportsPrincipals(): boolean {
  return jmapClient.hasCapability(CAPABILITIES.PRINCIPALS);
}

/**
 * Whether Settings offers Delegates: someone to share with (principals) and
 * something to share (webmail settings-app supportsSharing).
 */
export function supportsDelegation(gates: { calendarsEnabled: boolean; contactsEnabled: boolean }): boolean {
  if (!jmapClient.currentSession || !supportsPrincipals()) return false;
  return supportsMailboxSharing()
    || (supportsCalendarSharing() && gates.calendarsEnabled)
    || (supportsContactSharing() && gates.contactsEnabled);
}

/**
 * Whether the server keeps a folder's "mark as read" and keyword rights as
 * one right, so a read-only share can also flag mail. Stalwart 1.0 does;
 * every 1.0 account lists principals:owner, which 0.16 never does.
 */
export function sharesSeenWithKeywords(accountId: string = jmapClient.accountId): boolean {
  return hasAccountCapability(CAPABILITIES.PRINCIPALS_OWNER, accountId);
}

function withOwner(using: string[]): string[] {
  return jmapClient.hasCapability(CAPABILITIES.PRINCIPALS_OWNER) ? [...using, CAPABILITIES.PRINCIPALS_OWNER] : using;
}

const MAILBOX_USING = [CAPABILITIES.CORE, CAPABILITIES.MAIL, MAIL_SHARE_CAPABILITY];
const calendarUsing = () => withOwner([CAPABILITIES.CORE, CAPABILITIES.CALENDARS]);
const contactUsing = () => withOwner([CAPABILITIES.CORE, CAPABILITIES.CONTACTS]);
const fileUsing = () => (jmapClient.hasCapability(CAPABILITIES.FILES) ? [CAPABILITIES.CORE, CAPABILITIES.FILES] : [CAPABILITIES.CORE]);

/**
 * Every folder, calendar and address book of the user's own account with
 * its `shareWith`, and the files that are shared with someone. A type the
 * account can't share is left out; one whose read failed is in `failed`,
 * so the caller doesn't mistake it for "shared with nobody".
 */
export async function getShareTargets(
  include: { calendars?: boolean; contacts?: boolean; files?: boolean } = {},
): Promise<{ targets: ShareTarget[]; failed: ShareKind[] }> {
  const calls: JMAPMethodCall[] = [];
  const using = new Set<string>([CAPABILITIES.CORE]);
  const accounts: { mailbox?: string; calendar?: string; addressBook?: string } = {};
  const mailAccountId = jmapClient.accountId;
  if (supportsMailboxSharing(mailAccountId)) {
    accounts.mailbox = mailAccountId;
    calls.push(['Mailbox/get', { accountId: mailAccountId, ids: null, properties: ['id', 'name', 'role', 'parentId', 'shareWith'] }, 'm']);
    for (const u of MAILBOX_USING) using.add(u);
  }
  const calendarsAccountId = getCalendarsAccountId();
  if (include.calendars !== false && supportsCalendarSharing(calendarsAccountId)) {
    accounts.calendar = calendarsAccountId;
    calls.push(['Calendar/get', { accountId: calendarsAccountId, ids: null, properties: ['id', 'name', 'isDefault', 'shareWith'] }, 'c']);
    for (const u of calendarUsing()) using.add(u);
  }
  const contactsAccountId = getContactsAccountId();
  if (include.contacts !== false && supportsContactSharing(contactsAccountId)) {
    accounts.addressBook = contactsAccountId;
    calls.push(['AddressBook/get', { accountId: contactsAccountId, ids: null, properties: ['id', 'name', 'isDefault', 'shareWith'] }, 'a']);
    for (const u of contactUsing()) using.add(u);
  }

  const readCollections = async (): Promise<{ targets: ShareTarget[]; failed: ShareKind[] }> => {
    if (calls.length === 0) return { targets: [], failed: [] };
    try {
      const res = await jmapClient.request(calls, [...using]);
      return parseShareTargets(res.methodResponses as MethodResponse[], accounts);
    } catch (err) {
      console.warn('[delegation] reading sharing failed', err);
      return { targets: [], failed: Object.keys(accounts) as ShareKind[] };
    }
  };
  const readFiles = async (): Promise<{ targets: ShareTarget[]; failed: ShareKind[] }> => {
    if (include.files === false || !supportsFiles()) return { targets: [], failed: [] };
    const accountId = filesAccountId();
    try {
      const targets: ShareTarget[] = [];
      for (const node of await getAllFileNodes()) {
        if (!node.shareWith || Object.keys(node.shareWith).length === 0) continue;
        targets.push({
          kind: 'file',
          accountId,
          id: node.id,
          name: node.name,
          parentId: node.parentId ?? null,
          shareWith: node.shareWith as Record<string, AnyRights>,
        });
      }
      return { targets, failed: [] };
    } catch (err) {
      console.warn('[delegation] reading file sharing failed', err);
      return { targets: [], failed: ['file'] };
    }
  };
  // The file tree can take several requests; it is read alongside the rest.
  const [collections, fileTargets] = await Promise.all([readCollections(), readFiles()]);
  return {
    targets: [...collections.targets, ...fileTargets.targets],
    failed: [...collections.failed, ...fileTargets.failed],
  };
}

/** The reason a change was not sent: another login is active now. */
export const LOGIN_SWITCHED = 'The account was switched';

/**
 * Applies `shareWith` changes to many items in as few requests as the
 * server's limits allow, and says for each one whether it worked. Never
 * throws: a request that fails, or one not sent because `stillSameLogin`
 * says the login changed, marks its items failed.
 */
export async function applyShareChanges(
  changes: ShareChange[],
  stillSameLogin: () => boolean = () => true,
): Promise<ShareChangeResult[]> {
  if (changes.length === 0) return [];
  const { calls, changesByCall } = buildShareSetCalls(changes, { maxObjectsInSet: jmapClient.getMaxObjectsInSet() });
  const usingFor: Record<string, string[]> = {
    [SET_METHOD.mailbox]: MAILBOX_USING,
    [SET_METHOD.calendar]: calendarUsing(),
    [SET_METHOD.addressBook]: contactUsing(),
    [SET_METHOD.file]: fileUsing(),
  };
  const results: ShareChangeResult[] = [];
  for (const group of batched(calls, jmapClient.getMaxCallsInRequest())) {
    if (!stillSameLogin()) {
      results.push(...failAll(group, changesByCall, new Error(LOGIN_SWITCHED)));
      continue;
    }
    const using = [...new Set(group.flatMap(([method]) => usingFor[method] ?? []))];
    try {
      const res = await jmapClient.request(group, using);
      results.push(...readShareSetResults(group, changesByCall, res.methodResponses as MethodResponse[]));
    } catch (err) {
      results.push(...failAll(group, changesByCall, err));
    }
  }
  return results;
}

// Same as api/files: the Principal properties the share sheets read, and
// Stalwart 1.0's answer while directory queries are off (its default).
const PRINCIPAL_PROPERTIES = ['id', 'type', 'name', 'description', 'email'];
const DIRECTORY_QUERIES_OFF = 'The administrator has disabled directory queries.';

export interface PrincipalLookup {
  principal: Principal | null;
  status: 'ok' | 'forbidden' | 'error';
  directoryQueriesOff?: boolean;
}

/**
 * The principal with this address, through a directory query. `forbidden`
 * when the server refuses queries (Stalwart 1.0 with directory queries off,
 * the default), with `directoryQueriesOff` when that is the reason.
 */
export async function findPrincipalByEmail(email: string): Promise<PrincipalLookup> {
  if (!supportsPrincipals()) return { principal: null, status: 'error' };
  const wanted = email.trim().toLowerCase();
  const accountId = jmapClient.accountId;
  try {
    const res = await jmapClient.request(
      [
        ['Principal/query', { accountId, filter: { email: wanted }, limit: 10 }, '0'],
        ['Principal/get', {
          accountId,
          '#ids': { resultOf: '0', name: 'Principal/query', path: '/ids' },
          properties: PRINCIPAL_PROPERTIES,
        }, '1'],
      ],
      [CAPABILITIES.CORE, CAPABILITIES.PRINCIPALS],
    );
    const responses = res.methodResponses ?? [];
    const queryResp = responses.find((r) => r[0] === 'Principal/query');
    const getResp = responses.find((r) => r[0] === 'Principal/get');
    if (!queryResp || !getResp) {
      // A refused query makes the chained get fail; only the query's error says why.
      const error = responses.find((r) => r[0] === 'error')?.[1] as { type?: string; description?: string } | undefined;
      if (error?.type === 'forbidden') {
        return { principal: null, status: 'forbidden', ...(error.description === DIRECTORY_QUERIES_OFF ? { directoryQueriesOff: true } : {}) };
      }
      return { principal: null, status: 'error' };
    }
    const list = (getResp[1].list ?? []) as Principal[];
    const principal = list.find((p) => p.email?.toLowerCase() === wanted || p.name?.toLowerCase() === wanted) ?? null;
    return { principal, status: 'ok' };
  } catch (err) {
    console.warn('[delegation] looking up a principal failed', err);
    return { principal: null, status: 'error' };
  }
}
