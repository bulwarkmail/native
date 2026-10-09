import { CAPABILITIES } from '../api/types';
import type { JMAPAccountInfo, JMAPSession } from '../api/types';
import { useAuthStore } from '../stores/auth-store';
import { accountSupportsFiles } from '../api/files';
import { accountSupportsSieve, isSieveSupported } from '../api/sieve';
import { accountSupportsVacation, isVacationSupported } from '../api/vacation';
import { jmapClient } from '../api/jmap-client';

// When the session is null (cold start, offline restore) we assume features
// are available so they don't flicker off mid-restore. Once the live session
// arrives, the real capability set takes over.
function sessionHasCapability(capability: string): boolean {
  const session = useAuthStore.getState().session;
  if (!session) return true;
  return capability in session.capabilities;
}

export function hasCalendarCapability(): boolean {
  return sessionHasCapability(CAPABILITIES.CALENDARS);
}

export function hasContactsCapability(): boolean {
  return sessionHasCapability(CAPABILITIES.CONTACTS);
}

// Files is gated on the ACCOUNT capability (or a non-personal account), not
// just the server-wide session capability: an account whose filenode
// permissions were revoked still sees the capability in the session but
// every FileNode call fails (#563).
function sessionSupportsFiles(session: JMAPSession | null): boolean {
  if (!session) return true;
  const filesAccountId = session.primaryAccounts?.[CAPABILITIES.FILES];
  const accountId = filesAccountId ?? useAuthStore.getState().activeAccountId ?? '';
  const account = session.accounts?.[accountId]
    ?? (filesAccountId ? undefined : Object.values(session.accounts ?? {}).find((a) => a.isPersonal));
  return accountSupportsFiles(account, session.capabilities);
}

export function hasFilesCapability(): boolean {
  return sessionSupportsFiles(useAuthStore.getState().session);
}

export function useHasCalendar(): boolean {
  return useAuthStore((s) => (s.session ? CAPABILITIES.CALENDARS in s.session.capabilities : true));
}

export function useHasContacts(): boolean {
  return useAuthStore((s) => (s.session ? CAPABILITIES.CONTACTS in s.session.capabilities : true));
}

export function useHasFiles(): boolean {
  return useAuthStore((s) => sessionSupportsFiles(s.session));
}

// The account api/sieve.ts and api/vacation.ts target by default: the
// capability's primary account, else the mail account jmapClient resolves.
function primaryAccount(session: JMAPSession, capability: string): JMAPAccountInfo | undefined {
  const id = session.primaryAccounts?.[capability]
    ?? session.primaryAccounts?.[CAPABILITIES.MAIL]
    ?? session.primaryAccounts?.[CAPABILITIES.CORE]
    ?? Object.keys(session.accounts ?? {})[0];
  return id ? session.accounts?.[id] : undefined;
}

// Settings tabs for Sieve filters and the vacation responder are gated on the
// same per-account checks api/sieve.ts and api/vacation.ts make, so the tab is
// disabled up front instead of opening onto a "not supported" screen.
export function useHasSieve(): boolean {
  return useAuthStore((s) => (s.session
    ? accountSupportsSieve(primaryAccount(s.session, CAPABILITIES.SIEVE), s.session.capabilities)
    : true));
}

export function useHasVacation(): boolean {
  return useAuthStore((s) => (s.session
    ? accountSupportsVacation(primaryAccount(s.session, CAPABILITIES.MAIL), s.session.capabilities)
    : true));
}

/**
 * Whether folders of JMAP account `jmapAccountId` can be shared (mail:share):
 * the account's own capabilities name it (where Stalwart advertises it), or
 * the session's do. Unlike the helpers above it fails closed without a
 * session or an account: a share entry that opens onto a refusal is worse
 * than one that shows up once the session arrives.
 */
export function sessionSupportsMailShare(
  session: JMAPSession | null,
  jmapAccountId: string | null | undefined,
): boolean {
  if (!session || !jmapAccountId) return false;
  const account = session.accounts?.[jmapAccountId];
  if (!account) return false;
  if (CAPABILITIES.MAIL_SHARE in (session.capabilities ?? {})) return true;
  return !!account.accountCapabilities && CAPABILITIES.MAIL_SHARE in account.accountCapabilities;
}

export type SharedAccountSettingsTab = 'filters' | 'vacation' | 'calendar' | 'contacts';

// Whether JMAP account `accountId` of the live session has `capability`.
// Gated like accountSupportsSieve: the server has to offer it, and a
// non-personal account Stalwart lists without its capabilities counts as
// capable.
function accountHasCapability(accountId: string, capability: string): boolean {
  const session = jmapClient.currentSession;
  if (!session?.capabilities || !(capability in session.capabilities)) return false;
  const account = session.accounts?.[accountId];
  if (!account) return false;
  if (!account.isPersonal || !account.accountCapabilities) return true;
  return capability in account.accountCapabilities;
}

/**
 * Settings panes a shared/group account can be managed in, the first one
 * being where "Shared with me" lands. Mirrors the webmail's scoped settings
 * tabs; in scope, the calendar and contacts panes only list that account's
 * calendars and address books.
 */
export function sharedAccountSettingsTabs(accountId: string): SharedAccountSettingsTab[] {
  const tabs: SharedAccountSettingsTab[] = [];
  if (isSieveSupported(accountId)) tabs.push('filters');
  if (isVacationSupported(accountId)) tabs.push('vacation');
  if (accountHasCapability(accountId, CAPABILITIES.CALENDARS)) tabs.push('calendar');
  if (accountHasCapability(accountId, CAPABILITIES.CONTACTS)) tabs.push('contacts');
  return tabs;
}
