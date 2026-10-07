// Opening a global search hit on its surface, in its account. Port of
// webmail's lib/global-search/open-hit.ts (standard layout): switch to the
// hit's login when another is shown, then open the item there.
//
// Ids repeat across accounts (Stalwart numbers them per account), so a hit is
// never looked up by id alone: the switch must have landed on the hit's
// account before anything is read, every read goes out on that account's
// connection (and the hit's own JMAP account, for group or shared items),
// and nothing opens once another account is shown.

import { getEmails } from '../../api/email';
import { inAccount, type OpScope } from '../../api/op-scope';
import type { RootStackParamList } from '../../navigation/types';
import { setPendingCalendarOpen } from '../../navigation/pending-calendar-open';
import { setPendingFilesOpen } from '../../navigation/pending-files-open';
import { useAuthStore } from '../../stores/auth-store';
import { useContactsStore } from '../../stores/contacts-store';
import { isShownAccount, requireShownAccountScope } from '../../stores/email-store';
import { useLocaleStore } from '../../stores/locale-store';
import { prefetchMessage } from '../email-detail-cache';
import { isStaleLoad } from '../network-error';
import { scopeStillShown } from './providers/shown';
import type { CalendarHit, ContactHit, FileHit, GlobalSearchHit, MailHit } from './types';

/** Where an opened hit goes; the screen maps these onto its navigator. */
export interface OpenHitNavigation {
  openThread: (params: RootStackParamList['EmailThread']) => void;
  openContact: (contactId: string) => void;
  openTab: (tab: 'Calendar' | 'Files') => void;
  /**
   * Whether the opener still wants the hit (the search screen is mounted).
   * Checked once the switch and the reads are done: the user who backed out
   * meanwhile gets nothing opened, and nothing left parked for a tab.
   */
  active: () => boolean;
}

/** Opened, or why not (a text to show the user). */
export type OpenHitResult =
  | { opened: true }
  /** `message` is null when the opener left: nothing to say. */
  | { opened: false; message: string | null };

const ABANDONED: OpenHitResult = { opened: false, message: null };

const OPENED: OpenHitResult = { opened: true };

function t(key: string, fallback: string): string {
  return useLocaleStore.getState().t(key, fallback);
}

function refused(key: string, fallback: string): OpenHitResult {
  return { opened: false, message: t(key, fallback) };
}

function switchedAway(): OpenHitResult {
  return refused('email_list.account_switched_back', 'This belongs to another account. Switch back to it and try again.');
}

async function openMail(hit: MailHit, at: OpScope, nav: OpenHitNavigation): Promise<OpenHitResult> {
  // The thread id from the hit's own account: an id alone would be any
  // account's message with that id.
  const [email] = await getEmails([hit.id], inAccount(at, hit.jmapAccountId));
  if (!scopeStillShown(hit.appAccountId, at)) return switchedAway();
  if (!email) return refused('deep_link.message_not_found', 'This message is no longer available.');
  // A group or shared message lives under another JMAP account (#839).
  const jmapAccountId = hit.jmapAccountId !== at.accountId ? hit.jmapAccountId : undefined;
  // The viewer paints the header from this row and starts on the body now.
  if (!nav.active()) return ABANDONED;
  prefetchMessage(email, jmapAccountId);
  nav.openThread({
    emailId: email.id,
    threadId: email.threadId,
    subject: email.subject,
    jmapAccountId,
    // Page over this message alone, not the folder on screen, whose ids may
    // be another JMAP account's.
    emailIds: [email.id],
  });
  return OPENED;
}

async function openContact(hit: ContactHit, at: OpScope, nav: OpenHitNavigation): Promise<OpenHitResult> {
  // Card ids repeat across accounts, so a card only counts when the store's
  // cards were read on this account's connection (not the persisted cache,
  // not a load the switch overtook).
  const find = () => {
    const state = useContactsStore.getState();
    return state.contactsGen === at.gen && state.contacts.some((c) => c.id === hit.storeId);
  };
  if (!find()) {
    await useContactsStore.getState().fetchContacts();
    if (!scopeStillShown(hit.appAccountId, at)) return switchedAway();
  }
  if (!find()) return refused('contacts.detail.not_found', 'Contact not found');
  if (!nav.active()) return ABANDONED;
  nav.openContact(hit.storeId);
  return OPENED;
}

function openEvent(hit: CalendarHit, at: OpScope, nav: OpenHitNavigation): OpenHitResult {
  if (!nav.active()) return ABANDONED;
  // The calendar store names its own events by their raw id and a shared
  // calendar's as `${owner}:${id}`, stamped with that owner (no owner on its
  // own events); a hit from the loaded window carries the store id itself.
  const shared = hit.jmapAccountId !== at.accountId;
  const storeId = hit.source === 'local' ? hit.event.id : shared ? `${hit.jmapAccountId}:${hit.id}` : hit.id;
  const startMs = hit.event.start ? Date.parse(hit.event.start) : Number.NaN;
  setPendingCalendarOpen({
    kind: 'event',
    eventId: storeId,
    serverId: hit.id,
    accountId: shared ? hit.jmapAccountId : undefined,
    ...(hit.event.recurrenceId ? { recurrenceId: hit.event.recurrenceId } : {}),
    ...(Number.isFinite(startMs) ? { startMs } : {}),
    appAccountId: hit.appAccountId,
  });
  nav.openTab('Calendar');
  return OPENED;
}

function openFile(hit: FileHit, nav: OpenHitNavigation): OpenHitResult {
  if (!nav.active()) return ABANDONED;
  setPendingFilesOpen({
    appAccountId: hit.appAccountId,
    nodeId: hit.node.id,
    folderPath: hit.folderPath,
    fileName: hit.isFolder ? null : hit.node.name,
  });
  nav.openTab('Files');
  return OPENED;
}

const NOT_FOUND: Record<GlobalSearchHit['kind'], [string, string]> = {
  mail: ['deep_link.message_not_found', 'This message is no longer available.'],
  contacts: ['contacts.detail.not_found', 'Contact not found'],
  calendar: ['deep_link.event_not_found', 'This event is no longer available.'],
  files: ['deep_link.file_not_found', 'This file is no longer available.'],
};

/**
 * Open `hit` in its account. Resolves (never rejects) with whether it opened
 * and, when not, the text to show.
 */
export async function openHit(hit: GlobalSearchHit, nav: OpenHitNavigation): Promise<OpenHitResult> {
  try {
    if (!isShownAccount(hit.appAccountId)) {
      try {
        await useAuthStore.getState().switchAccount(hit.appAccountId);
      } catch {
        // Checked below: the switch did not land.
      }
    }
    // A failed or undone switch leaves another account shown.
    if (!isShownAccount(hit.appAccountId)) return switchedAway();
    let at: OpScope;
    try {
      at = requireShownAccountScope(hit.appAccountId);
    } catch (err) {
      return { opened: false, message: err instanceof Error ? err.message : t('email_list.account_switched_back', 'This belongs to another account. Switch back to it and try again.') };
    }
    switch (hit.kind) {
      case 'mail':
        return await openMail(hit, at, nav);
      case 'contacts':
        return await openContact(hit, at, nav);
      case 'calendar':
        return openEvent(hit, at, nav);
      case 'files':
        return openFile(hit, nav);
    }
  } catch (err) {
    // Dropped with its connection (another switch or a sign-out): the item
    // isn't missing, it belongs to an account no longer shown.
    if (isStaleLoad(err) || !isShownAccount(hit.appAccountId)) return switchedAway();
    // Offline or refused: reported like a missing item.
    const [key, fallback] = NOT_FOUND[hit.kind];
    return refused(key, fallback);
  }
}
