// The data every home-screen widget renders from. The app (or the headless
// widget task) fetches it from the server, stores it in AsyncStorage and asks
// the launcher to redraw; layouts only ever read this object, so a widget can
// draw without the network and without the React tree.
//
// Times are epoch milliseconds. Views that depend on "now" (what's next,
// what's overdue, free time) are derived at render time in ./derive.ts so a
// snapshot stays correct as the day moves on.

import AsyncStorage from '@react-native-async-storage/async-storage';

export const SNAPSHOT_KEY = 'widgets:snapshot:v1';

export interface MailItem {
  id: string;
  threadId: string;
  /** Signed-in account (app registry id) the message belongs to. */
  accountId: string;
  /** JMAP account owning the message when it is not the user's own. */
  jmapAccountId?: string;
  fromName: string;
  fromEmail: string;
  initials: string;
  /** Avatar colour, `#rrggbb`. */
  color: string;
  subject: string;
  preview: string;
  receivedAt: number;
  unread: boolean;
  starred: boolean;
  hasAttachment: boolean;
  /** Messages in the thread; 1 when unknown. */
  threadSize: number;
}

export interface FolderCount {
  role: 'inbox' | 'drafts' | 'sent' | 'archive' | 'junk' | 'trash' | 'scheduled';
  name: string;
  unread: number;
  total: number;
}

export interface AccountSummary {
  id: string;
  label: string;
  color: string;
  unread: number;
}

export interface ScheduledItem {
  id: string;
  to: string;
  subject: string;
  sendAt: number;
}

export interface Person {
  name: string;
  email: string;
  initials: string;
  color: string;
  unread: number;
  lastAt: number;
}

export interface TagCount {
  keyword: string;
  name: string;
  color: string;
  unread: number;
  total: number;
  latestFrom?: string;
  latestAt?: number;
}

export interface AttachmentGroup {
  emailId: string;
  accountId: string;
  fromName: string;
  receivedAt: number;
  files: Array<{ name: string; type: string }>;
}

export interface EventParticipant {
  name: string;
  email: string;
  initials: string;
  color: string;
}

export interface EventItem {
  /** Store id (occurrence-specific for a recurring series). */
  id: string;
  /** Server id of the stored event, for deep links. */
  serverId: string;
  jmapAccountId?: string;
  title: string;
  start: number;
  end: number;
  allDay: boolean;
  color: string;
  calendarName: string;
  location?: string;
  videoUrl?: string;
  videoName?: string;
  participants: EventParticipant[];
  /** The user's own participation status when they are invited. */
  myStatus?: 'needs-action' | 'accepted' | 'tentative' | 'declined';
  organizerName?: string;
}

export interface Invitation extends EventItem {
  /** Participant id of the user in the event, for the RSVP call. */
  participantId: string;
}

export interface Birthday {
  name: string;
  email?: string;
  initials: string;
  color: string;
  /** Next occurrence, local midnight. */
  date: number;
}

export interface TaskItem {
  id: string;
  /** Raw JMAP id, for CalendarEvent/set. */
  serverId: string;
  jmapAccountId?: string;
  title: string;
  due?: number;
  /** false for date-only due dates. */
  dueHasTime: boolean;
  done: boolean;
  calendarName: string;
  color: string;
}

export interface FileItem {
  id: string;
  name: string;
  isFolder: boolean;
  size: number;
  modified: number;
  type: string;
}

export interface VacationState {
  enabled: boolean;
  from?: number;
  to?: number;
  subject?: string;
}

export interface QuotaState {
  used: number;
  limit: number;
}

export interface WidgetSnapshot {
  version: 1;
  generatedAt: number;
  /**
   * When calendar, tasks, files and scheduled mail were last loaded. Those
   * need the running app (see build.ts); 0 until it has run once.
   */
  appDataAt: number;
  /** False when no account is signed in; widgets then ask the user to sign in. */
  signedIn: boolean;
  /** The app's theme preference; 'system' lets each widget follow the launcher. */
  theme: 'light' | 'dark' | 'system';
  /** Resolved app language (for date names). */
  locale: string;
  hour12: boolean;
  /** First day of the week, 0 = Sunday, 1 = Monday. */
  weekStart: 0 | 1;
  accounts: AccountSummary[];
  /** The signed-in account the single-account widgets show. */
  activeAccountId: string | null;
  mail: {
    folders: FolderCount[];
    inbox: MailItem[];
    unified: MailItem[];
    starred: MailItem[];
    starredCount: number;
    drafts: MailItem[];
    draftCount: number;
    scheduled: ScheduledItem[];
    /** Changes made offline that have not reached the server yet. */
    pendingChanges: number;
    favourites: Person[];
    recentSearches: string[];
    tags: TagCount[];
    attachments: AttachmentGroup[];
  };
  calendar: {
    supported: boolean;
    /** Events from the start of the current month through five weeks ahead. */
    events: EventItem[];
    invitations: Invitation[];
    birthdays: Birthday[];
  };
  tasks: { supported: boolean; items: TaskItem[] };
  files: { supported: boolean; items: FileItem[] };
  vacation: VacationState | null;
  quota: QuotaState | null;
}

export function emptySnapshot(): WidgetSnapshot {
  return {
    version: 1,
    generatedAt: 0,
    appDataAt: 0,
    signedIn: false,
    theme: 'system',
    locale: 'en',
    hour12: false,
    weekStart: 1,
    accounts: [],
    activeAccountId: null,
    mail: {
      folders: [],
      inbox: [],
      unified: [],
      starred: [],
      starredCount: 0,
      drafts: [],
      draftCount: 0,
      scheduled: [],
      pendingChanges: 0,
      favourites: [],
      recentSearches: [],
      tags: [],
      attachments: [],
    },
    calendar: { supported: false, events: [], invitations: [], birthdays: [] },
    tasks: { supported: false, items: [] },
    files: { supported: false, items: [] },
    vacation: null,
    quota: null,
  };
}

export async function loadSnapshot(): Promise<WidgetSnapshot | null> {
  try {
    const raw = await AsyncStorage.getItem(SNAPSHOT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as WidgetSnapshot;
    return parsed?.version === 1 ? parsed : null;
  } catch {
    return null;
  }
}

export async function saveSnapshot(snapshot: WidgetSnapshot): Promise<void> {
  await AsyncStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshot));
}

export async function clearSnapshot(): Promise<void> {
  await AsyncStorage.removeItem(SNAPSHOT_KEY);
}
