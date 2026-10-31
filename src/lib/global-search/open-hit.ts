import { useAuthStore } from '../../stores/auth-store';
import { setPendingCalendarOpen } from '../../navigation/pending-calendar-open';
import { setPendingFilesLink } from '../../navigation/pending-files-link';
import type { GlobalSearchHit } from './types';

// Opening a search hit where it lives, in its own account (webmail
// lib/global-search/open-hit.ts, the standard layout's path): switch to the
// hit's login when it isn't the active one, then go to its screen. Every hit
// names its login, owning account and raw id (#847).

/** The navigation calls opening a hit needs. */
export interface HitNavigation {
  navigate: (...args: any[]) => void;
}

/** The Files link of a file hit: own files by path, a shared drive's by its listed id. */
export function filesLinkFor(hit: Extract<GlobalSearchHit, { kind: 'files' }>): { path: string; preview?: string; shared?: string } {
  if (hit.node.isShared) return { path: '/', shared: hit.node.id };
  if (hit.isFolder) {
    const base = hit.folderPath === '/' ? '' : hit.folderPath;
    return { path: `${base}/${hit.node.name}` };
  }
  return { path: hit.folderPath, preview: hit.node.name };
}

/**
 * Opens a hit. `peers` are the other hits of the list, so the reader can
 * page over the messages of the same account. Resolves false when the
 * switch to the hit's login did not happen.
 */
export async function openHit(hit: GlobalSearchHit, navigation: HitNavigation, peers: GlobalSearchHit[] = []): Promise<boolean> {
  const auth = useAuthStore.getState();
  if (auth.activeAccountId !== hit.localAccountId) {
    await auth.switchAccount(hit.localAccountId);
    if (useAuthStore.getState().activeAccountId !== hit.localAccountId) return false;
  }
  switch (hit.kind) {
    case 'mail': {
      const pages = peers
        .filter((p) => p.kind === 'mail' && p.localAccountId === hit.localAccountId && p.jmapAccountId === hit.jmapAccountId)
        .map((p) => p.id);
      navigation.navigate('EmailThread', {
        emailId: hit.id,
        threadId: hit.email.threadId,
        subject: hit.email.subject,
        // A group or shared account's message names its account: ids repeat.
        jmapAccountId: hit.shared ? hit.jmapAccountId : undefined,
        emailIds: pages.includes(hit.id) ? pages : [hit.id],
      });
      return true;
    }
    case 'contacts':
      navigation.navigate('ContactDetail', { contactId: hit.storeId });
      return true;
    case 'calendar': {
      // Like a tapped reminder: the Calendar tab finds the event by its
      // server id when it isn't in the loaded window.
      const startMs = hit.event.start ? Date.parse(hit.event.start) : NaN;
      setPendingCalendarOpen({
        kind: 'event',
        eventId: hit.source === 'local' ? hit.event.id : hit.shared ? `${hit.jmapAccountId}:${hit.id}` : hit.id,
        serverId: hit.id,
        accountId: hit.shared ? hit.jmapAccountId : undefined,
        ...(Number.isNaN(startMs) ? {} : { startMs }),
      });
      navigation.navigate('MainTabs', { screen: 'Calendar' });
      return true;
    }
    case 'files':
      setPendingFilesLink(filesLinkFor(hit));
      navigation.navigate('MainTabs', { screen: 'Files' });
      return true;
  }
}
