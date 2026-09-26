// Builds the widget snapshot. Mail comes from JMAP on a client of the widgets'
// own (./jmap.ts) and works from a cold headless start. Calendar, tasks,
// birthdays, files and scheduled sends reuse the app's helpers, which are
// bound to the `jmapClient` singleton; they only run when that singleton is
// already connected to the active account (the app's JS runtime is alive).
// Otherwise those parts carry over from the previous snapshot, and the
// time-dependent views are still recomputed when a widget draws.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { jmapClient } from '../api/jmap-client';
import { CAPABILITIES, type CalendarEvent, type ContactCard } from '../api/types';
import { generateAccountId } from '../lib/account-utils';
import { generateEmailAvatarColor, getEmailInitials } from '../lib/avatar-utils';
import { getEventEndDate, getEventStartDate } from '../lib/calendar-utils';
import { getUserParticipantId, getUserStatus } from '../lib/calendar-participants';
import { getBirthday, getContactDisplayName, getDateParts } from '../lib/contact-utils';
import { notificationLocale } from '../lib/push-background-task';
import { useSettingsStore } from '../stores/settings-store';
import { useKeywordsStore, keywordToken } from '../stores/keywords-store';
import { LIGHT_COLORS } from '../theme/tokens';
import { addDays, startOfDay } from './format';
import { startOfWeek } from './derive';
import { fetchInboxPreview, fetchMailSection, openClient, type MailSection } from './jmap';
import { normalizeHex } from './theme';
import {
  emptySnapshot,
  loadSnapshot,
  saveSnapshot,
  type AccountSummary,
  type Birthday,
  type EventItem,
  type FileItem,
  type Invitation,
  type ScheduledItem,
  type TagCount,
  type TaskItem,
  type WidgetSnapshot,
} from './snapshot';

interface RegistryAccount {
  id: string;
  email?: string;
  displayName?: string;
  username?: string;
  avatarColor?: string;
}

export async function readRegistry(): Promise<{ accounts: RegistryAccount[]; activeAccountId: string | null }> {
  try {
    const raw = await AsyncStorage.getItem('account-registry');
    const state = raw ? (JSON.parse(raw) as { state?: { accounts?: RegistryAccount[]; activeAccountId?: string | null } }).state : null;
    const accounts = Array.isArray(state?.accounts) ? state!.accounts! : [];
    const active = state?.activeAccountId && accounts.some((a) => a.id === state.activeAccountId)
      ? state.activeAccountId
      : accounts[0]?.id ?? null;
    return { accounts, activeAccountId: active };
  } catch {
    return { accounts: [], activeAccountId: null };
  }
}

async function readRecentSearches(): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem('search-history-storage');
    const list = raw ? (JSON.parse(raw) as { state?: { recentSearches?: unknown } }).state?.recentSearches : null;
    return Array.isArray(list) ? list.filter((s): s is string => typeof s === 'string').slice(0, 8) : [];
  } catch {
    return [];
  }
}

async function readPendingChanges(accountId: string): Promise<number> {
  try {
    const raw = await AsyncStorage.getItem(`webmail:outbox:v1:${accountId}`);
    const list = raw ? JSON.parse(raw) : null;
    return Array.isArray(list) ? list.length : 0;
  } catch {
    return 0;
  }
}

/** True when the app's singleton is signed in to `registryAccountId` (live runtime). */
export function singletonServes(registryAccountId: string): boolean {
  if (!jmapClient.isConnected) return false;
  const { username, serverUrl } = jmapClient;
  return !!username && !!serverUrl && generateAccountId(username, serverUrl) === registryAccountId;
}

function tagColor(color: string): string {
  const tags = LIGHT_COLORS.tags;
  return (color in tags ? tags[color as keyof typeof tags] : tags.gray).dot;
}

function tagCounts(section: MailSection): TagCount[] {
  const { keywords } = useKeywordsStore.getState();
  const out: TagCount[] = [];
  for (const kw of keywords) {
    const counts = section.tagCounts.get(keywordToken(kw.id));
    if (!counts || counts.total === 0) continue;
    out.push({
      keyword: keywordToken(kw.id),
      name: kw.label,
      color: tagColor(kw.color),
      unread: counts.unread,
      total: counts.total,
      ...(counts.latest ? { latestFrom: counts.latest.fromName, latestAt: counts.latest.receivedAt } : {}),
    });
  }
  return out.sort((a, b) => b.unread - a.unread || b.total - a.total);
}

// ── App-backed sections (live runtime only) ──────────────────────────────

function participantAddress(p: { email?: string; calendarAddress?: string; sendTo?: Record<string, string> }): string {
  const raw = p.email || p.calendarAddress || p.sendTo?.imip || '';
  return raw.replace(/^mailto:/i, '');
}

function toEventItem(
  event: CalendarEvent,
  calendarsById: Map<string, { name: string; color?: string }>,
  selfEmails: string[],
): EventItem {
  const calId = Object.keys(event.calendarIds ?? {}).find((id) => event.calendarIds[id]);
  const cal = calId ? calendarsById.get(calId) : undefined;
  const start = getEventStartDate(event).getTime();
  const end = Math.max(start, getEventEndDate(event).getTime());
  const location = Object.values(event.locations ?? {}).find((l) => l?.name)?.name;
  const video = Object.values(event.virtualLocations ?? {}).find((v) => /^https?:\/\//i.test(v?.uri ?? ''));
  const self = new Set(selfEmails.map((e) => e.toLowerCase()));
  // Other people only: "who is coming" and the running-late mail leave the
  // user out.
  const participants = Object.values(event.participants ?? {})
    .filter((p) => !self.has(participantAddress(p).toLowerCase()))
    .map((p) => {
      const email = participantAddress(p);
      const name = p.name?.trim() || email;
      return {
        name,
        email,
        initials: getEmailInitials(p.name ?? '', email) || '?',
        color: normalizeHex(generateEmailAvatarColor(p.name ?? '', email)),
      };
    })
    .filter((p) => p.name);
  const organizer = Object.values(event.participants ?? {}).find((p) => p.roles?.owner);
  const status = getUserStatus(event, selfEmails);
  // A timed event from midnight to midnight is a whole-day event in all but
  // name (some clients write holidays that way); show it as all-day rather
  // than as "00:00 - 00:00".
  const wholeDays = !event.showWithoutTime
    && start === startOfDay(start)
    && end > start
    && end === startOfDay(end);
  return {
    id: event.id,
    serverId: event.originalId || event.id,
    ...(event.accountId ? { jmapAccountId: event.accountId } : {}),
    title: event.title || '',
    start,
    end,
    allDay: !!event.showWithoutTime || wholeDays,
    color: normalizeHex(event.color || cal?.color),
    calendarName: cal?.name ?? '',
    ...(location ? { location } : {}),
    ...(video ? { videoUrl: video.uri, videoName: video.name || '' } : {}),
    participants,
    ...(status === 'needs-action' || status === 'accepted' || status === 'tentative' || status === 'declined'
      ? { myStatus: status }
      : {}),
    ...(organizer ? { organizerName: organizer.name || participantAddress(organizer) } : {}),
  };
}

async function buildCalendar(now: number, selfEmails: string[], previous: WidgetSnapshot): Promise<WidgetSnapshot['calendar']> {
  const calendarsSupported = jmapClient.hasAccountCapability(CAPABILITIES.CALENDARS);
  if (!calendarsSupported) return { supported: false, events: [], invitations: [], birthdays: await buildBirthdays(now) };
  const { useCalendarStore, loadEventsInRange } = require('../stores/calendar-store') as typeof import('../stores/calendar-store');
  // Always refetch: the persisted list can predate a calendar deleted and
  // re-created on the server under the same id, which would put events under
  // the old name and colour.
  try {
    await useCalendarStore.getState().fetchCalendars();
  } catch {
    // fall back to the cached list
  }
  const { calendars, hiddenCalendarIds } = useCalendarStore.getState();
  const visible = calendars.filter((c) => !hiddenCalendarIds.includes(c.id));
  const byId = new Map(calendars.map((c) => [c.id, { name: c.name, color: c.color }]));

  const first = new Date(now);
  first.setDate(1);
  const rangeStart = startOfWeek(first.getTime(), useSettingsStore.getState().calendarFirstDayOfWeek === 0 ? 0 : 1);
  const rangeEnd = Math.max(addDays(startOfDay(now), 36), addDays(rangeStart, 42));
  let raw: CalendarEvent[];
  try {
    raw = visible.length === 0
      ? []
      : await loadEventsInRange(calendars, visible.map((c) => c.id), new Date(rangeStart).toISOString(), new Date(rangeEnd).toISOString());
  } catch (err) {
    console.warn('[widgets] calendar refresh failed', err);
    return { ...previous.calendar, birthdays: await buildBirthdays(now) };
  }
  const live = raw.filter((e) => e.status !== 'cancelled');
  const events = live
    .map((e) => toEventItem(e, byId, selfEmails))
    .filter((e) => e.end >= rangeStart && e.start < rangeEnd)
    .sort((a, b) => a.start - b.start);

  // One entry per series: answering an invitation answers the whole event.
  const invitations: Invitation[] = [];
  const seen = new Set<string>();
  for (const e of live) {
    if (getUserStatus(e, selfEmails) !== 'needs-action') continue;
    const participantId = getUserParticipantId(e, selfEmails);
    const key = e.originalId || e.id;
    if (!participantId || seen.has(key)) continue;
    const item = toEventItem(e, byId, selfEmails);
    if (item.end < now) continue;
    seen.add(key);
    invitations.push({ ...item, participantId });
  }

  return {
    supported: true,
    events,
    invitations: invitations.sort((a, b) => a.start - b.start).slice(0, 10),
    birthdays: await buildBirthdays(now),
  };
}

async function buildBirthdays(now: number): Promise<Birthday[]> {
  const { useContactsStore } = require('../stores/contacts-store') as typeof import('../stores/contacts-store');
  // The Contacts tab loads the address book lazily; the widget may be first.
  if (jmapClient.isConnected) {
    try {
      await useContactsStore.getState().fetchContactsIfStale();
    } catch {
      // use whatever is cached
    }
  }
  const contacts: ContactCard[] = useContactsStore.getState().contacts ?? [];
  const today = startOfDay(now);
  const out: Birthday[] = [];
  for (const contact of contacts) {
    const date = getBirthday(contact);
    if (!date) continue;
    const { month, day } = getDateParts(date);
    if (!month || !day) continue;
    const thisYear = new Date(new Date(today).getFullYear(), month - 1, day).getTime();
    const next = thisYear >= today ? thisYear : new Date(new Date(today).getFullYear() + 1, month - 1, day).getTime();
    const name = getContactDisplayName(contact);
    const email = Object.values(contact.emails ?? {})[0]?.address;
    out.push({
      name,
      ...(email ? { email } : {}),
      initials: getEmailInitials(name, email) || '?',
      color: normalizeHex(generateEmailAvatarColor(name, email)),
      date: next,
    });
  }
  return out.sort((a, b) => a.date - b.date).slice(0, 20);
}

async function buildTasks(previous: WidgetSnapshot): Promise<WidgetSnapshot['tasks']> {
  if (!useSettingsStore.getState().enableCalendarTasks) return { supported: false, items: [] };
  const { useCalendarStore } = require('../stores/calendar-store') as typeof import('../stores/calendar-store');
  try {
    const store = useCalendarStore.getState();
    if (store.tasks.length === 0) await store.fetchTasks();
    const { tasks, calendars } = useCalendarStore.getState();
    const byId = new Map(calendars.map((c) => [c.id, c]));
    const items: TaskItem[] = tasks
      .filter((t) => t.progress !== 'cancelled')
      .map((t) => {
        const calId = Object.keys(t.calendarIds ?? {}).find((id) => t.calendarIds[id]);
        const cal = calId ? byId.get(calId) : undefined;
        // A LocalDateTime without an offset parses as device-local time.
        const due = t.due ? Date.parse(t.due) : NaN;
        return {
          id: t.id,
          serverId: t.originalId || t.id,
          ...(t.accountId ? { jmapAccountId: t.accountId } : {}),
          title: t.title || '',
          ...(Number.isFinite(due) ? { due } : {}),
          dueHasTime: !!t.due && !t.showWithoutTime && !/T00:00(:00)?$/.test(t.due),
          done: t.progress === 'completed',
          calendarName: cal?.name ?? '',
          color: normalizeHex(t.color || cal?.color),
        };
      });
    return { supported: true, items: items.slice(0, 40) };
  } catch {
    return previous.tasks;
  }
}

async function buildFiles(previous: WidgetSnapshot): Promise<WidgetSnapshot['files']> {
  const files = require('../api/files') as typeof import('../api/files');
  if (!files.supportsFiles()) return { supported: false, items: [] };
  try {
    const nodes = await files.getAllFileNodes();
    const items: FileItem[] = nodes
      .filter((n) => !!n.name)
      .map((n) => ({
        id: n.id,
        name: n.name,
        isFolder: files.isFolder(n),
        size: n.size ?? 0,
        modified: Date.parse(n.modified || n.created || '') || 0,
        type: n.type || '',
      }))
      .sort((a, b) => b.modified - a.modified)
      .slice(0, 6);
    return { supported: true, items };
  } catch {
    return previous.files;
  }
}

async function buildScheduled(previous: WidgetSnapshot): Promise<ScheduledItem[]> {
  try {
    if (!jmapClient.hasDelayedSend()) return [];
    const { listScheduledEmails } = require('../api/email') as typeof import('../api/email');
    const list = await listScheduledEmails();
    return list.slice(0, 6).map((s) => {
      const to = s.to?.[0];
      return {
        id: s.emailSubmissionId,
        to: to?.name || to?.email || '',
        subject: s.subject ?? '',
        sendAt: Date.parse(s.sendAt) || 0,
      };
    });
  } catch {
    return previous.mail.scheduled;
  }
}

// ── Assembly ─────────────────────────────────────────────────────────────

async function buildSnapshot(previous: WidgetSnapshot): Promise<WidgetSnapshot> {
  const now = Date.now();
  const { accounts, activeAccountId } = await readRegistry();
  if (!activeAccountId) return { ...emptySnapshot(), generatedAt: now };

  const settings = useSettingsStore.getState();
  if (!settings.hydrated) await settings.hydrate();
  const keywordsState = useKeywordsStore.getState();
  if (!keywordsState.hydrated) await keywordsState.hydrate();
  const { theme, timeFormat, calendarFirstDayOfWeek } = useSettingsStore.getState();

  const live = singletonServes(activeAccountId);
  const client = live ? jmapClient : await openClient(activeAccountId);
  const next: WidgetSnapshot = {
    ...previous,
    version: 1,
    generatedAt: now,
    signedIn: true,
    theme,
    locale: await notificationLocale(),
    hour12: timeFormat === '12h',
    weekStart: calendarFirstDayOfWeek === 0 ? 0 : 1,
    activeAccountId,
  };
  if (previous.activeAccountId !== activeAccountId) {
    // Nothing of another account's data may linger in a widget.
    const blank = emptySnapshot();
    next.mail = blank.mail;
    next.calendar = blank.calendar;
    next.tasks = blank.tasks;
    next.files = blank.files;
    next.vacation = null;
    next.quota = null;
    next.appDataAt = 0;
  }
  if (!client) return next;

  const keywordTokens = useKeywordsStore.getState().keywords.map((k) => keywordToken(k.id));
  const section = await fetchMailSection(client, activeAccountId, keywordTokens);

  const others = accounts.filter((a) => a.id !== activeAccountId);
  const previews = await Promise.all(others.map(async (a) => {
    try {
      const c = await openClient(a.id);
      return c ? { account: a, ...(await fetchInboxPreview(c, a.id)) } : null;
    } catch {
      return null;
    }
  }));
  const inboxUnread = section.folders.find((f) => f.role === 'inbox')?.unread ?? 0;
  const summaries: AccountSummary[] = accounts.map((a) => {
    const preview = previews.find((p) => p?.account.id === a.id);
    return {
      id: a.id,
      label: a.displayName || a.email || a.username || a.id,
      color: normalizeHex(a.avatarColor),
      unread: a.id === activeAccountId ? inboxUnread : preview?.unread ?? 0,
    };
  });
  const unified = [
    ...section.inbox.slice(0, 6),
    ...previews.flatMap((p) => p?.items ?? []),
  ].sort((a, b) => b.receivedAt - a.receivedAt).slice(0, 8);

  next.accounts = summaries;
  next.mail = {
    ...next.mail,
    folders: section.folders,
    inbox: section.inbox,
    unified,
    starred: section.starred,
    starredCount: section.starredCount,
    drafts: section.drafts,
    draftCount: section.draftCount,
    favourites: section.favourites,
    recentSearches: await readRecentSearches(),
    tags: tagCounts(section),
    attachments: section.attachments,
    pendingChanges: await readPendingChanges(activeAccountId),
  };
  next.vacation = section.vacation;
  next.quota = section.quota;

  if (live) {
    const [calendar, tasks, files, scheduled] = await Promise.all([
      buildCalendar(now, section.selfEmails, next),
      buildTasks(next),
      buildFiles(next),
      buildScheduled(next),
    ]);
    next.calendar = calendar;
    next.tasks = tasks;
    next.files = files;
    next.mail.scheduled = scheduled;
    next.appDataAt = now;
  }
  return next;
}

let inflight: Promise<WidgetSnapshot> | null = null;
let localChanges = 0;

/**
 * A widget button just edited the stored snapshot. A refresh that started
 * before it read the server before the change, so its result is dropped
 * rather than saved over the edit.
 */
export function noteLocalChange(): void {
  localChanges++;
}

/**
 * Fetch fresh data and store it. Concurrent callers share one run: every
 * placed widget gets its own update broadcast, and they would otherwise each
 * start a refresh. On failure the previous snapshot is returned unchanged.
 *
 * `after` is for callers that just changed something on the server (a widget
 * button): a run already in flight may have read the server before that
 * change, so they wait for it and start (or join) the next one instead.
 */
export async function refreshSnapshot(opts?: { after?: 'change' }): Promise<WidgetSnapshot> {
  if (opts?.after === 'change' && inflight) {
    await inflight.catch(() => undefined);
    return refreshSnapshot();
  }
  if (inflight) return inflight;
  inflight = (async () => {
    const changesAtStart = localChanges;
    const previous = (await loadSnapshot()) ?? emptySnapshot();
    try {
      const next = await buildSnapshot(previous);
      if (localChanges !== changesAtStart) return (await loadSnapshot()) ?? next;
      await saveSnapshot(next);
      return next;
    } catch (err) {
      console.warn('[widgets] refresh failed', err);
      return previous;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}
