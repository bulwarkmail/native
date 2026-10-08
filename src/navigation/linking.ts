// Deep links: `bulwarkmobile://…` app links, webmail permalinks
// (https://<webmail>/mail/message/<id> etc. - same path grammar as the
// webmail's lib/deep-links.ts) and `mailto:` URLs. Parsing is pure so it can
// be unit-tested; `handleDeepLink` performs the navigation.
import type { NavigationContainerRefWithCurrent, StackActionType } from '@react-navigation/native';
import type { EmailAddress } from '../api/types';
import { parseMailtoUrl } from '../lib/mailto';
import type { RootStackParamList } from './types';
import { setPendingSettingsTab } from './pending-settings-tab';
import { setPendingCalendarOpen, setPendingCalendarView, type CalendarViewTarget } from './pending-calendar-open';
import { setPendingFilesOpen } from './pending-files-open';
import { setPendingMailSearch } from './pending-mail-search';
import { setPendingMailFolder } from './pending-mail-folder';
import { virtualFolderTarget } from '../lib/folder-ref';
import { setPendingSignInLink, usePendingSignInLinkStore } from './pending-sign-in-link';
import { insecurePairingLinkError, parseQrLoginPayload, type QrLoginPayload } from '../lib/oauth';
import { MAX_ACCOUNTS } from '../lib/account-utils';

export const APP_SCHEME = 'bulwarkmobile';
// The webmail's "Link Mobile App" links (`bulwarkmail://pair?server=…&code=…`)
// and server-bootstrap links (`bulwarkmail://connect?server=…`). They sign in
// rather than navigate, so they never become a DeepLink.
export const SIGN_IN_SCHEME = 'bulwarkmail';

const UNIFIED_ROLES = ['inbox', 'sent', 'drafts', 'junk', 'archive', 'trash'] as const;
const UNIFIED_VIEWS = ['all', 'unread', 'starred'] as const;
type UnifiedRole = typeof UNIFIED_ROLES[number];
type UnifiedView = typeof UNIFIED_VIEWS[number];

export type DeepLink =
  // `jmapAccountId`: the JMAP account owning a message in a group/shared
  // mailbox (`?jmapAccount=`); `threadId` (`?thread=`) saves looking it up;
  // `action: 'reply'` opens a reply to it.
  | { kind: 'message'; emailId: string; accountId?: string; jmapAccountId?: string; threadId?: string; action?: 'reply' }
  | { kind: 'draft'; emailId: string; accountId?: string; jmapAccountId?: string }
  | { kind: 'thread'; threadId: string; accountId?: string }
  // No `ref`: a bare `/mail` link, which opens the list on whatever it shows.
  | { kind: 'folder'; ref?: string; accountId?: string }
  | { kind: 'unified'; role?: UnifiedRole; view?: UnifiedView }
  | { kind: 'scheduled' }
  | { kind: 'search'; query: string }
  // `jmapAccountId`: the JMAP account owning the event (`?account=`), for
  // one on a calendar shared with the user; `accountId`: the signed-in
  // account it belongs to (`?appAccount=`, from widgets).
  | { kind: 'calendar'; eventId?: string; view?: CalendarViewTarget['view']; date?: string; jmapAccountId?: string; accountId?: string }
  // `accountId`: the signed-in account the card belongs to (`?account=`).
  // Card ids repeat across accounts, so without one the link opens on the
  // account shown. `edit` opens the edit form over the card.
  | { kind: 'contact'; contactId: string; edit?: boolean; accountId?: string }
  // A new-contact form, prefilled from `?email=` / `?name=`.
  | { kind: 'contactNew'; email?: string; name?: string; accountId?: string }
  | { kind: 'contacts' }
  | { kind: 'files'; path?: string[]; preview?: string; accountId?: string }
  | { kind: 'settings'; tab?: string }
  | { kind: 'compose'; to: EmailAddress[]; cc: EmailAddress[]; bcc?: EmailAddress[]; subject?: string; body?: string };

const CALENDAR_VIEWS = ['month', 'week', 'day', 'agenda'] as const;

/** `YYYY-MM-DD` when it is a real day (2026-02-31 is not), else undefined. */
function validLinkDate(value: string): string | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(y, mo - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return undefined;
  return value;
}

export interface CalendarLinkState {
  view: CalendarViewTarget['view'] | 'tasks';
  date?: Date | string | null;
  eventId?: string | null;
  /** JMAP account owning the event, for one on a shared calendar. */
  accountId?: string | null;
}

/** The webmail's `buildCalendarPath`: `/calendar/<view>[/<date>]` or `/calendar/event/<id>`. */
export function buildCalendarPath(state: CalendarLinkState): string {
  if (state.eventId) {
    const path = `/calendar/event/${encodeURIComponent(state.eventId)}`;
    return state.accountId ? `${path}?account=${encodeURIComponent(state.accountId)}` : path;
  }
  const { date } = state;
  if (!date) return `/calendar/${state.view}`;
  const day = typeof date === 'string'
    ? date
    : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  return `/calendar/${state.view}/${day}`;
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function toAddresses(list: string[]): EmailAddress[] {
  return list.map((email) => ({ email }));
}

/**
 * Split a URL into path segments and query, tolerating both `scheme://host/
 * path` (https permalinks, `bulwarkmobile://mail/...` where "mail" lands in
 * the host slot) and `scheme:path` forms.
 */
function splitUrl(url: string): { segments: string[]; search: URLSearchParams } | null {
  const m = /^([a-z][a-z0-9+.-]*):(?:\/\/)?([^?#]*)(?:\?([^#]*))?/i.exec(url.trim());
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  let path = m[2];
  // For https permalinks the first segment is the webmail host; drop it and
  // an optional locale prefix (`/de/mail/...`).
  if (scheme === 'http' || scheme === 'https') {
    path = path.replace(/^[^/]*\/?/, '');
  }
  const segments = path.split('/').filter(Boolean);
  if (/^[a-z]{2}(-[A-Za-z]{2,4})?$/.test(segments[0] ?? '') && segments.length > 1
    && ['mail', 'calendar', 'contacts', 'files', 'settings', 'compose'].includes(segments[1])) {
    segments.shift();
  }
  return { segments, search: new URLSearchParams(m[3] ?? '') };
}

export function parseDeepLink(url: string): DeepLink | null {
  if (!url) return null;
  if (isSignInSchemeUrl(url)) return null;
  if (/^mailto:/i.test(url)) {
    const parsed = parseMailtoUrl(url);
    if (!parsed) return null;
    return {
      kind: 'compose',
      to: toAddresses(parsed.to),
      cc: toAddresses(parsed.cc),
      bcc: toAddresses(parsed.bcc),
      subject: parsed.subject,
      body: parsed.body,
    };
  }

  const parts = splitUrl(url);
  if (!parts) return null;
  const { segments, search } = parts;
  const [area, kind, value] = segments;
  const accountId = search.get('account') ?? undefined;

  switch (area) {
    case 'mail': {
      const jmapAccountId = search.get('jmapAccount') ?? undefined;
      if (kind === 'message' && value) {
        const threadId = search.get('thread');
        return {
          kind: 'message',
          emailId: decodeSegment(value),
          accountId,
          ...(jmapAccountId ? { jmapAccountId } : {}),
          ...(threadId ? { threadId } : {}),
          ...(search.get('action') === 'reply' ? { action: 'reply' as const } : {}),
        };
      }
      if (kind === 'draft' && value) {
        return { kind: 'draft', emailId: decodeSegment(value), accountId, ...(jmapAccountId ? { jmapAccountId } : {}) };
      }
      if (kind === 'unified') {
        const role = search.get('role');
        const view = search.get('view');
        return {
          kind: 'unified',
          ...(role && (UNIFIED_ROLES as readonly string[]).includes(role) ? { role: role as UnifiedRole } : {}),
          ...(view && (UNIFIED_VIEWS as readonly string[]).includes(view) ? { view: view as UnifiedView } : {}),
        };
      }
      if (kind === 'scheduled') return { kind: 'scheduled' };
      if (kind === 'search') return { kind: 'search', query: search.get('q') ?? '' };
      if (kind === 'thread' && value) return { kind: 'thread', threadId: decodeSegment(value), accountId };
      if (kind === 'folder' && value) return { kind: 'folder', ref: decodeSegment(value), accountId };
      // Legacy `?email=<id>` from the webmail's older service worker.
      const legacyEmail = search.get('email');
      if (legacyEmail) return { kind: 'message', emailId: legacyEmail, accountId };
      return { kind: 'folder', accountId };
    }
    case 'calendar': {
      if (kind === 'event' && value) {
        const jmapAccountId = search.get('account') ?? undefined;
        const appAccountId = search.get('appAccount') ?? undefined;
        return {
          kind: 'calendar',
          eventId: decodeSegment(value),
          ...(jmapAccountId ? { jmapAccountId } : {}),
          ...(appAccountId ? { accountId: appAccountId } : {}),
        };
      }
      // `/calendar/<view>[/<date>]`, or a bare `/calendar/<date>` that keeps
      // the user's view. A bad date is dropped (today); `tasks`, which has
      // no grid here, and unknown views just open the tab.
      if (kind && (CALENDAR_VIEWS as readonly string[]).includes(kind)) {
        const date = value ? validLinkDate(decodeSegment(value)) : undefined;
        return { kind: 'calendar', view: kind as CalendarViewTarget['view'], ...(date ? { date } : {}) };
      }
      const bare = kind ? validLinkDate(decodeSegment(kind)) : undefined;
      return { kind: 'calendar', ...(bare ? { date: bare } : {}) };
    }
    case 'contacts':
      return parseContactsPath(segments.slice(1), search, accountId) ?? { kind: 'contacts' };
    case 'files': {
      // `/files/<folder>/…[?preview=<name>]`: empty segments are dropped, and
      // a bare link stays a bare tab open.
      const path = segments.slice(1).map(decodeSegment).filter(Boolean);
      const preview = search.get('preview') || undefined;
      return {
        kind: 'files',
        ...(path.length ? { path } : {}),
        ...(preview ? { preview } : {}),
        ...(accountId ? { accountId } : {}),
      };
    }
    case 'settings':
      return { kind: 'settings', tab: kind ? decodeSegment(kind) : undefined };
    case 'compose': {
      const to = search.get('to');
      // URLSearchParams has already decoded the values; re-encode them for
      // the mailto parser, which keeps `+` literal (toString() would write
      // spaces as `+`). The recipients come from the `to=` param alone.
      const query = Array.from(search, ([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
      const parsed = to ? parseMailtoUrl(`mailto:?${query}`) : null;
      return {
        kind: 'compose',
        to: toAddresses(parsed?.to ?? []),
        cc: toAddresses(parsed?.cc ?? []),
        subject: parsed?.subject ?? search.get('subject') ?? undefined,
        body: parsed?.body ?? search.get('body') ?? undefined,
      };
    }
    default:
      return null;
  }
}

/**
 * The webmail's `parseContactsPath`: `/contacts/new`, `/contacts/<id>[/edit]`,
 * and the legacy query form its email viewer used to build (`?contactId=`,
 * `&view=edit`, `?addEmail=`, `?addName=`), which plugins and bookmarks still
 * emit. Null for the plain list.
 */
function parseContactsPath(segments: string[], search: URLSearchParams, accountId?: string): DeepLink | null {
  const account = accountId ? { accountId } : {};
  const [first, second] = segments;
  const create = (email: string | null, name: string | null): DeepLink => ({
    kind: 'contactNew',
    ...(email ? { email } : {}),
    ...(name ? { name } : {}),
    ...account,
  });
  const contact = (contactId: string, edit: boolean): DeepLink => ({
    kind: 'contact',
    contactId,
    ...(edit ? { edit: true } : {}),
    ...account,
  });

  if (first === 'new') {
    return create(search.get('email') ?? search.get('addEmail'), search.get('name') ?? search.get('addName'));
  }
  if (first) {
    const id = decodeSegment(first);
    if (id) return contact(id, second === 'edit');
  }
  const legacyId = search.get('contactId');
  if (legacyId) return contact(legacyId, search.get('view') === 'edit');
  const addEmail = search.get('addEmail');
  const addName = search.get('addName');
  if (addEmail || addName) return create(addEmail, addName);
  return null;
}

function isSignInSchemeUrl(url: string): boolean {
  return url.trim().toLowerCase().startsWith(`${SIGN_IN_SCHEME}:`);
}

/** A `bulwarkmail://pair|connect?…` link, parsed; null for any other URL. */
export function parseSignInLink(url: string | null | undefined): QrLoginPayload | null {
  if (!url || !isSignInSchemeUrl(url)) return null;
  return parseQrLoginPayload(url);
}

/**
 * Park a sign-in link the OS delivered (a tapped link, or another app firing
 * the intent) for the login screen, which takes it (the signed-out one, or
 * Add account when someone is signed in) and asks the user before running
 * it: whoever sent it chose the webmail and the code. A pairing link for a
 * plain-http webmail is parked as a refusal instead, for the login screen to
 * say why nothing happens. Returns whether `url` was a sign-in link.
 */
export function acceptSignInLink(url: string | null | undefined): boolean {
  const payload = parseSignInLink(url);
  if (payload) {
    setPendingSignInLink(payload, 'external');
    return true;
  }
  const refusal = url && isSignInSchemeUrl(url) ? insecurePairingLinkError(url) : null;
  if (!refusal) return false;
  usePendingSignInLinkStore.getState().refuse(refusal);
  return true;
}

/**
 * Signed in, where a parked sign-in link goes: Add account, whose login
 * screen takes it, or, with no room for another account, nowhere: the link
 * is dropped before a code is spent and the caller shows the limit. 'none'
 * when nothing is parked (taken meanwhile by an Add account already open).
 */
export function routeParkedSignInLink(accountCount: number): 'add-account' | 'account-limit' | 'none' {
  const links = usePendingSignInLinkStore.getState();
  if (!links.pending && !links.refusal) return 'none';
  if (accountCount >= MAX_ACCOUNTS) {
    links.dropParked();
    return 'account-limit';
  }
  return 'add-account';
}

export interface DeepLinkNavigator {
  navigation: NavigationContainerRefWithCurrent<RootStackParamList>;
  // Resolve a message id to its thread (EmailThread needs both). Returns
  // null when the message cannot be loaded. `jmapAccountId` names the
  // group/shared account holding it, when it is not the user's own.
  resolveThreadId: (emailId: string, jmapAccountId?: string) => Promise<string | null>;
  // Open the composer on a server draft. Resolve false when the draft cannot
  // be loaded.
  openDraft?: (emailId: string, jmapAccountId?: string) => Promise<boolean>;
  // Switch to the account a permalink names (`?account=`); resolves false
  // when that account is not signed in on this device.
  switchAccount?: (accountId: string) => Promise<boolean>;
  // The signed-in account now shown, for links that park a target for it.
  activeAccountId?: () => string | null;
  // The folder the mail list shows now, so a folder link that lands late
  // doesn't pull the user out of one they opened meanwhile.
  currentMailboxId?: () => string | null;
}

/**
 * `StackActions.push('ContactForm', params)`, built here: importing the
 * action creators would load React Native into this pure module.
 */
function pushContactForm(params: RootStackParamList['ContactForm']): StackActionType {
  return { type: 'PUSH', payload: { name: 'ContactForm', params } };
}

/** Navigate for a parsed link. Returns false when nothing could be opened. */
export async function handleDeepLink(link: DeepLink, nav: DeepLinkNavigator): Promise<boolean> {
  const { navigation } = nav;
  if (!navigation.isReady()) return false;

  if ('accountId' in link && link.accountId && nav.switchAccount) {
    if (!(await nav.switchAccount(link.accountId))) return false;
  }

  switch (link.kind) {
    case 'message': {
      const threadId = link.threadId ?? await nav.resolveThreadId(link.emailId, link.jmapAccountId);
      if (!threadId) return false;
      // A reply opens over the message, like the reader's own Reply: the
      // reader loads it (from its cache when offline) and then opens the
      // composer, or shows why it could not.
      navigation.navigate('EmailThread', {
        emailId: link.emailId,
        threadId,
        ...(link.jmapAccountId ? { jmapAccountId: link.jmapAccountId } : {}),
        ...(link.action === 'reply' ? { action: 'reply' as const } : {}),
      });
      return true;
    }
    case 'draft':
      return nav.openDraft ? nav.openDraft(link.emailId, link.jmapAccountId) : false;
    case 'unified':
      navigation.navigate('UnifiedInbox', {
        ...(link.role ? { role: link.role } : {}),
        ...(link.view ? { view: link.view } : {}),
      });
      return true;
    case 'scheduled':
      navigation.navigate('Scheduled');
      return true;
    case 'search':
      setPendingMailSearch(link.query);
      navigation.navigate('MainTabs', { screen: 'Mail' } as never);
      return true;
    case 'thread':
      // The reader keys on the message; without one, open the list.
      navigation.navigate('MainTabs', { screen: 'Mail' } as never);
      return true;
    case 'folder': {
      if (!link.ref) {
        navigation.navigate('MainTabs', { screen: 'Mail' } as never);
        return true;
      }
      // A unified or Scheduled view has no folder of its own to wait for.
      const virtual = virtualFolderTarget(link.ref);
      if (virtual?.kind === 'scheduled') {
        navigation.navigate('Scheduled');
        return true;
      }
      if (virtual) {
        navigation.navigate('UnifiedInbox', {
          ...(virtual.role ? { role: virtual.role } : {}),
          ...(virtual.view ? { view: virtual.view } : {}),
        });
        return true;
      }
      // Stamped after any account switch above: the mail list resolves it
      // against this account's folders only.
      const appAccountId = nav.activeAccountId?.();
      if (appAccountId) {
        setPendingMailFolder({ ref: link.ref, appAccountId, fromMailboxId: nav.currentMailboxId?.() ?? null });
      }
      navigation.navigate('MainTabs', { screen: 'Mail' } as never);
      return true;
    }
    case 'calendar':
      // An event link opens the event like a tapped reminder does: the
      // Calendar tab looks it up by its server id.
      if (link.eventId) {
        setPendingCalendarOpen({
          kind: 'event',
          eventId: link.jmapAccountId ? `${link.jmapAccountId}:${link.eventId}` : link.eventId,
          serverId: link.eventId,
          accountId: link.jmapAccountId,
        });
      }
      // A date or view link parks what to show; a link without one clears
      // any view an earlier link left unread.
      setPendingCalendarView(link.date || link.view ? { view: link.view, date: link.date } : null);
      navigation.navigate('MainTabs', { screen: 'Calendar' } as never);
      return true;
    case 'contact':
      navigation.navigate('ContactDetail', { contactId: link.contactId });
      // The form goes over the card, so Back from it lands on the card.
      // Pushed: navigating would hand a form already on top (another card's
      // edit, a new contact) these params while it keeps its own values.
      if (link.edit) navigation.dispatch(pushContactForm({ contactId: link.contactId }));
      return true;
    case 'contactNew': {
      const prefill = {
        ...(link.email ? { email: link.email } : {}),
        ...(link.name ? { name: link.name } : {}),
      };
      // Pushed, like an edit link: an open form must not turn into this one.
      navigation.dispatch(pushContactForm(Object.keys(prefill).length > 0 ? { prefill } : {}));
      return true;
    }
    case 'contacts':
      navigation.navigate('MainTabs', { screen: 'Contacts' } as never);
      return true;
    case 'files':
      // Stamped after any account switch above, so the Files tab never applies
      // it to another account's listing.
      if ((link.path?.length || link.preview) && nav.activeAccountId) {
        const appAccountId = nav.activeAccountId();
        if (appAccountId) {
          setPendingFilesOpen({ appAccountId, by: 'path', segments: link.path ?? [], preview: link.preview ?? null });
        }
      }
      navigation.navigate('MainTabs', { screen: 'Files' } as never);
      return true;
    case 'settings':
      setPendingSettingsTab(link.tab ?? null);
      navigation.navigate('MainTabs', { screen: 'Settings' } as never);
      return true;
    case 'compose':
      navigation.navigate('Compose', {
        prefillTo: link.to,
        prefillCc: link.cc.length > 0 ? link.cc : undefined,
        prefillBcc: link.bcc?.length ? link.bcc : undefined,
        prefillSubject: link.subject,
        prefillBody: link.body,
      });
      return true;
    default:
      return false;
  }
}

/** Share-sheet payload captured natively (ACTION_SEND / SEND_MULTIPLE). */
export interface SharePayload {
  text?: string;
  subject?: string;
  // content:// URIs of shared files, with their MIME types, display names
  // and sizes (-1 when unknown) as reported by the providing app.
  uris?: string[];
  mimeTypes?: string[];
  names?: string[];
  sizes?: number[];
}

/**
 * Turn a share payload into a compose link: a shared `mailto:` or address
 * becomes the recipient, everything else lands in the body.
 */
export function shareToDeepLink(share: SharePayload): DeepLink {
  const text = share.text?.trim() ?? '';
  if (/^mailto:/i.test(text)) {
    const link = parseDeepLink(text);
    if (link) return link;
  }
  const asAddress = parseMailtoUrl(`mailto:${text}`);
  if (asAddress && !text.includes(' ') && !text.includes('\n')) {
    return { kind: 'compose', to: toAddresses(asAddress.to), cc: [], subject: share.subject };
  }
  return {
    kind: 'compose',
    to: [],
    cc: [],
    subject: share.subject,
    body: text || undefined,
  };
}
