// What the Delegates page shows about people and their access (webmail
// components/settings/delegates/principal-display.ts, describeSummary in
// delegates-settings.tsx and the search of delegate-dialog.tsx). Kept free
// of React so it can be unit-tested.

import type { Principal } from '../../api/types';
import type { DelegateSummary } from './delegation';

type Translate = (key: string, fallback?: string, params?: Record<string, string | number>) => string;

/** The line to show for a principal, and the smaller one under it. */
export function principalDisplay(principal: Pick<Principal, 'id' | 'name' | 'email' | 'description'>): { name: string; detail: string | null } {
  const name = principal.name || principal.email || principal.id;
  const detail = principal.email && principal.email !== name
    ? principal.email
    : principal.description && principal.description !== name ? principal.description : null;
  return { name, detail };
}

/**
 * The principal behind an id: from the directory, the names kept on this
 * device, or, as a last way to name someone the directory won't (Stalwart
 * 1.0 with directory queries off), the account they shared with the user,
 * which the session lists under the owner's address.
 */
export function resolvePrincipal(
  id: string,
  sources: { directory: Principal[]; remembered: Map<string, Principal>; sessionAccounts: Map<string, string> },
): Principal | null {
  const known = sources.directory.find((p) => p.id === id) ?? sources.remembered.get(id);
  if (known) return known;
  const accountName = sources.sessionAccounts.get(id);
  if (!accountName) return null;
  // The webmail tells groups apart by the policy subject's groups, which the app doesn't have.
  return { id, name: accountName, email: accountName.includes('@') ? accountName : null, type: 'individual' };
}

/** "All mail folders · 1 calendar · Read", in the order of the dialog. */
export function describeSummary(summary: DelegateSummary, t: Translate): string {
  const parts: string[] = [];
  const { mail, calendars, addressBooks, files } = summary;
  if (mail.shared > 0) {
    parts.push(mail.shared === mail.total
      ? t('delegates.summary.mail_all', 'All mail folders')
      : mail.shared === 1 && mail.inbox
        ? t('delegates.summary.mail_inbox', 'Inbox')
        : t('delegates.summary.mail_some', '{count, plural, one {# mail folder} other {# mail folders}}', { count: mail.shared }));
  }
  if (calendars.shared > 0) {
    parts.push(t('delegates.summary.calendars', '{count, plural, one {# calendar} other {# calendars}}', { count: calendars.shared }));
  }
  if (addressBooks.shared > 0) {
    parts.push(t('delegates.summary.address_books', '{count, plural, one {# address book} other {# address books}}', { count: addressBooks.shared }));
  }
  if (files > 0) {
    parts.push(t('delegates.summary.files', '{count, plural, one {# file or folder} other {# files or folders}}', { count: files }));
  }
  const level = summary.level ?? 'none';
  const levelFallback = { read: 'Read', write: 'Read and write', mixed: 'Different rights', none: 'Free/busy only' }[level];
  parts.push(t(`delegates.level.${level}`, levelFallback));
  return parts.join(' · ');
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The people the dialog offers for a search: never the user. */
export function delegateCandidates(directory: Principal[], ownIds: string[], query: string): Principal[] {
  const own = new Set(ownIds);
  const q = query.trim().toLowerCase();
  return directory
    .filter((p) => !own.has(p.id))
    .filter((p) => !q || p.name?.toLowerCase().includes(q) || p.email?.toLowerCase().includes(q) || p.description?.toLowerCase().includes(q));
}

/** Whether "Use {address}" is offered: a typed address nobody listed has. */
export function canLookUpAddress(query: string, candidates: Principal[]): boolean {
  const typed = query.trim();
  return EMAIL_RE.test(typed) && !candidates.some((p) => p.email?.toLowerCase() === typed.toLowerCase());
}

export type Lookup =
  | { state: 'idle' }
  | { state: 'busy' }
  | { state: 'notFound'; address: string }
  | { state: 'directoryOff' }
  | { state: 'self' }
  | { state: 'failed' };

/** What a lookup of `address` found, as the dialog shows it; `picked` is set when it found someone. */
export function lookupResult(
  address: string,
  found: { principal: Principal | null; status: 'ok' | 'forbidden' | 'error' },
  ownIds: string[],
): { lookup: Lookup; picked: Principal | null } {
  if (found.principal && ownIds.includes(found.principal.id)) return { lookup: { state: 'self' }, picked: null };
  if (found.principal) return { lookup: { state: 'idle' }, picked: found.principal };
  if (found.status === 'forbidden') return { lookup: { state: 'directoryOff' }, picked: null };
  if (found.status === 'ok') return { lookup: { state: 'notFound', address }, picked: null };
  return { lookup: { state: 'failed' }, picked: null };
}
