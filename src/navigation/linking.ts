// Deep links: `bulwarkmobile://…` app links, webmail permalinks
// (https://<webmail>/mail/message/<id> etc. - same path grammar as the
// webmail's lib/deep-links.ts) and `mailto:` URLs. Parsing is pure so it can
// be unit-tested; `handleDeepLink` performs the navigation.
import type { NavigationContainerRefWithCurrent } from '@react-navigation/native';
import type { EmailAddress } from '../api/types';
import { parseMailtoUrl } from '../lib/mailto';
import type { RootStackParamList } from './types';
import { setPendingSettingsTab } from './pending-settings-tab';

export const APP_SCHEME = 'bulwarkmobile';

export type DeepLink =
  | { kind: 'message'; emailId: string; accountId?: string }
  | { kind: 'thread'; threadId: string; accountId?: string }
  | { kind: 'folder'; ref: string; accountId?: string }
  | { kind: 'calendar'; eventId?: string; date?: string }
  | { kind: 'contact'; contactId: string }
  | { kind: 'contacts' }
  | { kind: 'files' }
  | { kind: 'settings'; tab?: string }
  | { kind: 'compose'; to: EmailAddress[]; cc: EmailAddress[]; bcc?: EmailAddress[]; subject?: string; body?: string };

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
      if (kind === 'message' && value) return { kind: 'message', emailId: decodeSegment(value), accountId };
      if (kind === 'thread' && value) return { kind: 'thread', threadId: decodeSegment(value), accountId };
      if (kind === 'folder' && value) return { kind: 'folder', ref: decodeSegment(value), accountId };
      // Legacy `?email=<id>` from the webmail's older service worker.
      const legacyEmail = search.get('email');
      if (legacyEmail) return { kind: 'message', emailId: legacyEmail, accountId };
      return { kind: 'folder', ref: 'inbox', accountId };
    }
    case 'calendar': {
      if (kind === 'event' && value) return { kind: 'calendar', eventId: decodeSegment(value) };
      const date = [kind, value].find((s) => s && /^\d{4}-\d{2}-\d{2}$/.test(s));
      return { kind: 'calendar', date };
    }
    case 'contacts': {
      if (kind && kind !== 'new') return { kind: 'contact', contactId: decodeSegment(kind) };
      return { kind: 'contacts' };
    }
    case 'files':
      return { kind: 'files' };
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

export interface DeepLinkNavigator {
  navigation: NavigationContainerRefWithCurrent<RootStackParamList>;
  // Resolve a message id to its thread (EmailThread needs both). Returns
  // null when the message cannot be loaded.
  resolveThreadId: (emailId: string) => Promise<string | null>;
  // Switch to the account a permalink names (`?account=`); resolves false
  // when that account is not signed in on this device.
  switchAccount?: (accountId: string) => Promise<boolean>;
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
      const threadId = await nav.resolveThreadId(link.emailId);
      if (!threadId) return false;
      navigation.navigate('EmailThread', { emailId: link.emailId, threadId });
      return true;
    }
    case 'thread':
      // The reader keys on the message; without one, open the list.
      navigation.navigate('MainTabs', { screen: 'Mail' } as never);
      return true;
    case 'folder':
      navigation.navigate('MainTabs', { screen: 'Mail' } as never);
      return true;
    case 'calendar':
      navigation.navigate('MainTabs', { screen: 'Calendar' } as never);
      return true;
    case 'contact':
      navigation.navigate('ContactDetail', { contactId: link.contactId });
      return true;
    case 'contacts':
      navigation.navigate('MainTabs', { screen: 'Contacts' } as never);
      return true;
    case 'files':
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
