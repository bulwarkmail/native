import { CAPABILITIES } from '../api/types';
import type { JMAPAccountInfo, JMAPSession } from '../api/types';
import { useAuthStore } from '../stores/auth-store';
import { accountSupportsFiles } from '../api/files';
import { accountSupportsSieve, isSieveSupported } from '../api/sieve';
import { accountSupportsVacation, isVacationSupported } from '../api/vacation';

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

export type SharedAccountSettingsTab = 'filters' | 'vacation';

/**
 * Settings panes a shared/group account can be managed in, the first one
 * being where "Shared with me" lands. Mirrors the webmail's scoped settings
 * tabs (its calendar and contacts panes aren't scoped on mobile).
 */
export function sharedAccountSettingsTabs(accountId: string): SharedAccountSettingsTab[] {
  const tabs: SharedAccountSettingsTab[] = [];
  if (isSieveSupported(accountId)) tabs.push('filters');
  if (isVacationSupported(accountId)) tabs.push('vacation');
  return tabs;
}

