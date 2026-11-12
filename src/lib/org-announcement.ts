import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { OrgAnnouncement } from './org-organisation';

// The organisation announcement (policy.json `organisation.announcement`,
// webmail lib/org-announcement.ts): which text a user sees, whether it is
// showing now, when that changes next, and the dismissal memory. The banner
// is components/OrgAnnouncementBanner.tsx.
//
// A dismissal is kept per account under the announcement's id and a hash of
// its content, so an edited announcement shows again.

export type Announcement = OrgAnnouncement;

/**
 * The text for `locale`: the exact locale, then its language (pt-BR → pt),
 * then the admin's fallback locale, then the first text there is. '' when
 * the announcement has no text.
 */
export function announcementText(announcement: Announcement | undefined | null, locale: string): string {
  const text = announcement?.text ?? {};
  const entries = Object.entries(text).filter(([, value]) => typeof value === 'string' && value.trim() !== '');
  if (entries.length === 0) return '';
  const find = (code: string | undefined) => {
    if (!code) return undefined;
    const lower = code.toLowerCase();
    return entries.find(([key]) => key.toLowerCase() === lower)?.[1];
  };
  const language = locale.split('-')[0];
  return find(locale)
    ?? find(language)
    ?? entries.find(([key]) => key.split('-')[0].toLowerCase() === language.toLowerCase())?.[1]
    ?? find(announcement?.fallbackLocale)
    ?? entries[0][1];
}

function time(value: string | undefined): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

/** Whether the announcement is inside its start and end time at `now`. */
export function announcementActive(announcement: Announcement | undefined | null, now: number): boolean {
  if (!announcement) return false;
  const start = time(announcement.startsAt);
  const end = time(announcement.endsAt);
  if (start !== null && now < start) return false;
  if (end !== null && now >= end) return false;
  return true;
}

/** The next moment the announcement starts or ends after `now`, or null when nothing changes any more. */
export function nextAnnouncementChange(announcement: Announcement | undefined | null, now: number): number | null {
  if (!announcement) return null;
  const times = [time(announcement.startsAt), time(announcement.endsAt)].filter((t): t is number => t !== null && t > now);
  return times.length > 0 ? Math.min(...times) : null;
}

/** FNV-1a over what the message says: a new text or severity is a new announcement for dismissals. */
export function announcementHash(announcement: Announcement): string {
  const content = JSON.stringify([
    Object.entries(announcement.text ?? {}).sort(([a], [b]) => a.localeCompare(b)),
    announcement.severity,
  ]);
  let hash = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/** What a dismissal remembers: the id and the content hash. */
export function announcementKey(announcement: Announcement): string {
  return `${announcement.id}:${announcementHash(announcement)}`;
}

/** Same link pattern as the webmail's plain-text reader. */
const URL_RE = /https?:\/\/[^\s<>"']+/g;
const TRAILING_PUNCTUATION = /[.,;:!?)\]]+$/;

export type AnnouncementPart = { kind: 'text'; text: string } | { kind: 'link'; href: string };

/** The text split into plain parts and links. */
export function announcementParts(text: string): AnnouncementPart[] {
  const parts: AnnouncementPart[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_RE)) {
    const start = match.index ?? 0;
    let href = match[0];
    const trailing = href.match(TRAILING_PUNCTUATION)?.[0] ?? '';
    if (trailing) href = href.slice(0, -trailing.length);
    if (start > last) parts.push({ kind: 'text', text: text.slice(last, start) });
    parts.push({ kind: 'link', href });
    last = start + href.length;
  }
  if (last < text.length) parts.push({ kind: 'text', text: text.slice(last) });
  return parts;
}

const STORAGE_KEY = 'bulwark.announcement.dismissed';

interface DismissalState {
  /** The dismissed announcement key, by local account id ('default' without one). */
  byAccount: Record<string, string>;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  dismiss: (announcement: Announcement, accountId: string | null | undefined) => void;
}

const slot = (accountId: string | null | undefined) => accountId || 'default';

export const useAnnouncementDismissals = create<DismissalState>((set, get) => ({
  byAccount: {},
  hydrated: false,
  hydrate: async () => {
    if (get().hydrated) return;
    let stored: Record<string, string> = {};
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        stored = Object.fromEntries(Object.entries(parsed).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
      }
    } catch {
      // Unreadable: the banner shows until closed again.
    }
    set({ byAccount: { ...stored, ...get().byAccount }, hydrated: true });
  },
  dismiss: (announcement, accountId) => {
    const byAccount = { ...get().byAccount, [slot(accountId)]: announcementKey(announcement) };
    set({ byAccount });
    void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(byAccount)).catch(() => undefined);
  },
}));

/** Whether this account dismissed exactly this announcement. */
export function isAnnouncementDismissed(
  byAccount: Record<string, string>,
  announcement: Announcement,
  accountId: string | null | undefined,
): boolean {
  return byAccount[slot(accountId)] === announcementKey(announcement);
}

/**
 * What the banner shows at `now`: the text, or null when there is nothing
 * (no text, outside its time, or dismissed by this account).
 */
export function visibleAnnouncement(
  announcement: Announcement | undefined | null,
  opts: { locale: string; now: number; accountId: string | null | undefined; dismissed: Record<string, string> },
): { text: string; announcement: Announcement } | null {
  if (!announcement) return null;
  const text = announcementText(announcement, opts.locale);
  if (!text || !announcementActive(announcement, opts.now)) return null;
  if (announcement.dismissible && isAnnouncementDismissed(opts.dismissed, announcement, opts.accountId)) return null;
  return { text, announcement };
}
