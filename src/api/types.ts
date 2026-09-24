// ─── JMAP Session & Core ─────────────────────────────────

export interface JMAPSession {
  apiUrl: string;
  downloadUrl: string;
  uploadUrl: string;
  eventSourceUrl: string;
  primaryAccounts: Record<string, string>;
  accounts: Record<string, JMAPAccountInfo>;
  capabilities: Record<string, unknown>;
  state: string;
  // RFC 8620 §2 — authenticated user identifier. Optional because not all
  // servers populate it; OAuth login uses it as the account label when
  // there's no password username to fall back on.
  username?: string;
}

export interface JMAPAccountInfo {
  name: string;
  isPersonal: boolean;
  isReadOnly: boolean;
  // Per-account capability objects (RFC 8620 §2). Optional because not every
  // server populates it; the Sieve panel reads its limits/extensions from here.
  accountCapabilities?: Record<string, unknown>;
}

export type JMAPMethodCall = [string, Record<string, unknown>, string];

export interface JMAPRequestBody {
  using: string[];
  methodCalls: JMAPMethodCall[];
}

export interface JMAPResponseBody {
  methodResponses: Array<[string, Record<string, any>, string]>;
  sessionState?: string;
}

// ─── Email (RFC 8621) ────────────────────────────────────

export interface EmailAddress {
  name?: string;
  email: string;
}

export interface BodyPart {
  partId?: string;
  blobId?: string;
  type?: string;
  name?: string;
  disposition?: string;
  size?: number;
  cid?: string;
}

export interface Attachment {
  blobId: string;
  type: string;
  name?: string;
  size?: number;
  disposition?: string;
  cid?: string;
}

export interface Email {
  id: string;
  threadId: string;
  mailboxIds: Record<string, boolean>;
  keywords: Record<string, boolean>;
  size: number;
  receivedAt: string;
  sentAt?: string;
  from?: EmailAddress[];
  to?: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  replyTo?: EmailAddress[];
  subject?: string;
  preview?: string;
  hasAttachment: boolean;
  // RFC 8621 §4.1.2.3 - bare msg-ids without angle brackets. Needed for
  // reply threading (In-Reply-To / References) and read-receipt dedupe.
  messageId?: string[] | null;
  inReplyTo?: string[] | null;
  references?: string[] | null;
  // Raw headers (RFC 8621 §4.1.3) when fetched with `headers`; the viewer
  // derives SPF/DKIM/DMARC chips, List-Unsubscribe, MDN requests from them.
  headers?: Array<{ name: string; value: string }>;
  textBody?: BodyPart[];
  htmlBody?: BodyPart[];
  bodyValues?: Record<string, { value: string; isEncodingProblem?: boolean; isTruncated?: boolean }>;
  attachments?: Attachment[];
  blobId?: string;
  bodyStructure?: BodyPart;
  /**
   * Client-side stamp, never sent by the server: the JMAP account a row of a
   * list that spans accounts (an "All folders" search, a tag view) was
   * fetched from, the user's own account included. Rows of a single folder carry none; they
   * belong to the folder's account.
   */
  jmapAccountId?: string;
}

export interface MailboxRights {
  mayReadItems: boolean;
  mayAddItems: boolean;
  mayRemoveItems: boolean;
  maySetSeen: boolean;
  maySetKeywords: boolean;
  mayCreateChild: boolean;
  mayRename: boolean;
  mayDelete: boolean;
  maySubmit: boolean;
}

export interface Mailbox {
  /**
   * Unique within the app. For the user's own folders this is the raw JMAP id;
   * for a shared (group) account's folders it's `<accountId>:<rawId>` so ids
   * from different accounts can't collide. Use `originalId` when talking to
   * the server. Mirrors the webmail's scheme in [lib/jmap/client.ts].
   */
  id: string;
  /** Raw JMAP id — set only on shared folders, where `id` carries a prefix. */
  originalId?: string;
  name: string;
  parentId?: string | null;
  role?: string | null;
  sortOrder?: number;
  totalEmails: number;
  unreadEmails: number;
  totalThreads: number;
  unreadThreads: number;
  myRights: MailboxRights;
  isSubscribed?: boolean;
  /** JMAP account the folder lives under (primary or a shared/group account). */
  accountId?: string;
  /** Display name of the owning account, used as the sidebar group header. */
  accountName?: string;
  /** True when the folder belongs to a shared/group account, not the user. */
  isShared?: boolean;
}

export interface Thread {
  id: string;
  emailIds: string[];
}

// ─── Identity & Submission ───────────────────────────────

export interface Identity {
  id: string;
  name: string;
  email: string;
  replyTo?: EmailAddress[];
  bcc?: EmailAddress[];
  textSignature?: string;
  htmlSignature?: string;
  mayDelete: boolean;
}

export interface EmailSubmission {
  id: string;
  emailId: string;
  identityId: string;
  sendAt?: string;
  undoStatus?: string;
}

// ─── Contacts (RFC 9553 JSContact) ──────────────────────

export type ContactKind = 'individual' | 'group' | 'org' | 'location' | 'device' | 'application';

export type NameComponentKind =
  | 'given' | 'surname' | 'middle' | 'prefix' | 'suffix'
  | 'additional' | 'separator' | 'credential' | 'title'
  | 'given2' | 'surname2' | 'generation';

export interface NameComponent {
  kind: NameComponentKind | string;
  value: string;
}

export interface ContactName {
  components?: NameComponent[];
  isOrdered?: boolean;
  full?: string;
  defaultSeparator?: string;
}

export interface ContactNickname {
  name: string;
  contexts?: Record<string, boolean>;
}

export interface ContactEmail {
  address: string;
  contexts?: Record<string, boolean>;
  label?: string;
  pref?: number;
}

export interface ContactPhone {
  number: string;
  contexts?: Record<string, boolean>;
  features?: Record<string, boolean>;
  label?: string;
  pref?: number;
}

export interface AddressComponent {
  kind: string;
  value: string;
  phonetic?: string;
}

export interface ContactAddress {
  components?: AddressComponent[];
  full?: string;
  isOrdered?: boolean;
  defaultSeparator?: string;
  // Legacy flat fields
  street?: string;
  locality?: string;
  region?: string;
  postcode?: string;
  country?: string;
  countryCode?: string;
  fullAddress?: string;
  coordinates?: string;
  timeZone?: string;
  contexts?: Record<string, boolean>;
  label?: string;
  pref?: number;
}

export interface ContactOrganization {
  name?: string;
  units?: Array<{ name: string }>;
  sortAs?: string;
}

export interface ContactTitle {
  name: string;
  kind?: 'title' | 'role';
  organizationId?: string;
}

export interface ContactOnlineService {
  service?: string;
  uri: string;
  user?: string;
  contexts?: Record<string, boolean>;
  label?: string;
  pref?: number;
}

export interface ContactLanguagePref {
  language: string;
  contexts?: Record<string, boolean>;
  pref?: number;
}

export interface PartialDate {
  '@type'?: 'PartialDate';
  year?: number;
  month?: number;
  day?: number;
  calendarScale?: string;
}

export interface Timestamp {
  '@type': 'Timestamp';
  utc: string;
}

export type AnniversaryDate = string | PartialDate | Timestamp;

export interface ContactAnniversary {
  '@type'?: 'Anniversary';
  kind: 'birth' | 'death' | 'wedding' | 'other' | string;
  date: AnniversaryDate;
  place?: ContactAddress;
}

export interface ContactPersonalInfo {
  kind: 'expertise' | 'hobby' | 'interest' | 'other' | string;
  value: string;
  level?: 'high' | 'medium' | 'low';
}

export interface ContactNote {
  note: string;
  created?: string;
  author?: { name?: string; uri?: string };
}

export interface ContactMedia {
  kind: 'photo' | 'sound' | 'logo' | string;
  uri: string;
  mediaType?: string;
}

export interface ContactRelation {
  relation?: Record<string, boolean>;
}

export interface ContactLink {
  uri: string;
  kind?: 'contact' | 'generic' | string;
  mediaType?: string;
  contexts?: Record<string, boolean>;
  label?: string;
  pref?: number;
}

export interface ContactCryptoKey {
  uri: string;
  mediaType?: string;
  contexts?: Record<string, boolean>;
}

export interface ContactDirectory {
  uri: string;
  kind?: 'directory' | 'entry' | string;
  mediaType?: string;
  pref?: number;
}

export interface ContactPronouns {
  pronouns: string;
  pref?: number;
  contexts?: Record<string, boolean>;
}

export interface ContactSpeakToAs {
  grammaticalGender?: string;
  pronouns?: Record<string, ContactPronouns>;
}

export interface ContactCard {
  id: string;
  originalId?: string;
  uid?: string;
  addressBookIds: Record<string, boolean>;
  kind?: ContactKind | string;
  language?: string;
  name?: ContactName;
  nicknames?: Record<string, ContactNickname>;
  emails?: Record<string, ContactEmail>;
  phones?: Record<string, ContactPhone>;
  onlineServices?: Record<string, ContactOnlineService>;
  preferredLanguages?: Record<string, ContactLanguagePref>;
  organizations?: Record<string, ContactOrganization>;
  titles?: Record<string, ContactTitle>;
  addresses?: Record<string, ContactAddress>;
  anniversaries?: Record<string, ContactAnniversary>;
  personalInfo?: Record<string, ContactPersonalInfo>;
  notes?: Record<string, ContactNote>;
  media?: Record<string, ContactMedia>;
  relatedTo?: Record<string, ContactRelation>;
  links?: Record<string, ContactLink>;
  cryptoKeys?: Record<string, ContactCryptoKey>;
  directories?: Record<string, ContactDirectory>;
  keywords?: Record<string, boolean>;
  members?: Record<string, boolean>;
  speakToAs?: ContactSpeakToAs;
  calendarUri?: string;
  schedulingUri?: string;
  freeBusyUri?: string;
  source?: string;
  prodId?: string;
  created?: string;
  updated?: string;
  // Client-only metadata for cards that live in a shared / group account.
  // Never sent to the server (api/contacts.ts strips them). `id` is
  // namespaced as `<accountId>:<originalId>` for shared cards.
  accountId?: string;
  accountName?: string;
  isShared?: boolean;
}

export interface AddressBookRights {
  mayRead?: boolean;
  mayWrite?: boolean;
  mayShare?: boolean;
  mayDelete?: boolean;
}

export interface AddressBook {
  id: string;
  name: string;
  description?: string | null;
  isDefault?: boolean;
  isSubscribed?: boolean;
  sortOrder?: number;
  myRights?: AddressBookRights;
  // RFC 9610 share map: principal id → rights.
  shareWith?: Record<string, AddressBookRights> | null;
  // Client-only metadata for books that live in a shared / group account.
  // `id` is namespaced as `<accountId>:<originalId>` for shared books so it
  // cannot collide with the user's own "default" book.
  originalId?: string;
  accountId?: string;
  accountName?: string;
  isShared?: boolean;
}

export interface AddressBookWithCount extends AddressBook {
  count: number;
}

// ─── Calendar (RFC 8984 JSCalendar) ─────────────────────

export interface Participant {
  '@type'?: 'Participant';
  name?: string;
  email?: string;
  sendTo?: Record<string, string>;
  // Stalwart uses calendarAddress (a `mailto:` URI) instead of email/sendTo.
  calendarAddress?: string;
  kind?: string;
  roles?: Record<string, boolean>;
  participationStatus?: 'needs-action' | 'accepted' | 'declined' | 'tentative' | 'delegated' | string;
  participationComment?: string;
  // 'server' asks Stalwart to deliver the iTIP messages for this participant.
  scheduleAgent?: 'server' | 'client' | 'none' | string;
  scheduleStatus?: string[];
  expectReply?: boolean;
  description?: string;
}

// JSCalendar Location (RFC 8984 §4.2.5) — a physical place.
export interface EventLocation {
  '@type'?: 'Location';
  name?: string;
  description?: string;
  locationTypes?: Record<string, boolean>;
  relativeTo?: string;
  timeZone?: string;
  coordinates?: string;
}

// JSCalendar VirtualLocation (RFC 8984 §4.2.6) — a video/online place.
export interface VirtualLocation {
  '@type'?: 'VirtualLocation';
  name?: string;
  description?: string;
  uri: string;
  features?: Record<string, boolean>;
}

export interface RecurrenceRule {
  '@type'?: 'RecurrenceRule';
  frequency: string;
  interval?: number;
  until?: string;
  count?: number;
  byDay?: Array<{ day: string; nthOfPeriod?: number }>;
  byMonth?: string[];
  byMonthDay?: number[];
  byYearDay?: number[];
  byWeekNo?: number[];
  byHour?: number[];
  byMinute?: number[];
  bySecond?: number[];
  bySetPosition?: number[];
  firstDayOfWeek?: string;
  rscale?: string;
  skip?: string;
}

export interface Alert {
  '@type'?: 'Alert';
  trigger: { '@type': string; offset?: string; when?: string; relativeTo?: 'start' | 'end' | string };
  action?: string;
  // UTCDateTime the user acknowledged the alert; null/absent when pending.
  acknowledged?: string | null;
}

export interface CalendarEvent {
  id: string;
  '@type'?: 'Event' | 'Task';
  uid: string;
  calendarIds: Record<string, boolean>;
  title: string;
  description?: string;
  start: string;
  duration?: string;
  // `null` on write clears a field the server holds (JSON drops `undefined`,
  // so an omitted key keeps the old value). All-day events carry a null zone.
  timeZone?: string | null;
  showWithoutTime?: boolean;
  utcStart?: string;
  utcEnd?: string;
  status?: string;
  freeBusyStatus?: string;
  participants?: Record<string, Participant> | null;
  // Scheduling (iTIP/iMIP). Stalwart derives the iCalendar ORGANIZER solely
  // from `organizerCalendarAddress` (a `mailto:` URI); RFC 8984's `replyTo` is
  // retired in jscalendarbis and only kept here so old values round-trip.
  replyTo?: Record<string, string> | null;
  organizerCalendarAddress?: string | null;
  sequence?: number;
  recurrenceRules?: RecurrenceRule[] | null;
  recurrenceOverrides?: Record<string, Partial<CalendarEvent>> | null;
  excludedRecurrenceRules?: RecurrenceRule[] | null;
  recurrenceId?: string;
  originalId?: string;
  // Client-only: the event's server-side calendarIds (raw, unprefixed), kept
  // when `calendarIds` is remapped to namespaced store ids for shared events.
  originalCalendarIds?: Record<string, boolean>;
  useDefaultAlerts?: boolean;
  alerts?: Record<string, Alert> | null;
  locations?: Record<string, EventLocation> | null;
  virtualLocations?: Record<string, VirtualLocation> | null;
  links?: Record<string, { href: string; rel?: string }>;
  created?: string;
  updated?: string;
  // Task-only (RFC 8984 JSTask) fields.
  progress?: 'needs-action' | 'in-process' | 'completed' | 'failed' | 'cancelled' | string;
  progressUpdated?: string;
  due?: string | null;
  priority?: number;
  percentComplete?: number;
  color?: string;
  // Client-only: account the event/occurrence belongs to (for shared/virtual).
  localAccountId?: string;
  // Client-only: JMAP account the event was fetched from. Absent for the
  // primary account; set for events on calendars shared with the user so
  // mutations can be routed to the owning account.
  accountId?: string;
  // Client-only: true when the event lives on a calendar shared with the user.
  isShared?: boolean;
}

export interface CalendarRights {
  mayReadFreeBusy?: boolean;
  mayReadItems?: boolean;
  mayWriteAll?: boolean;
  mayWriteOwn?: boolean;
  mayUpdatePrivate?: boolean;
  mayRSVP?: boolean;
  mayShare?: boolean;
  mayDelete?: boolean;
}

export interface Calendar {
  id: string;
  name: string;
  description?: string | null;
  color?: string;
  isVisible?: boolean;
  isSubscribed?: boolean;
  isDefault?: boolean;
  sortOrder?: number;
  myRights?: CalendarRights;
  // Principals this (owned) calendar is shared with and their rights.
  shareWith?: Record<string, CalendarRights> | null;
  // Alerts applied to events that set `useDefaultAlerts` (RFC 8620 calendars).
  defaultAlertsWithTime?: Record<string, Alert> | null;
  defaultAlertsWithoutTime?: Record<string, Alert> | null;
  // Client-only: JMAP account the calendar was fetched from. Absent for the
  // primary account; set for calendars shared with the user.
  accountId?: string;
  // Client-only: the real JMAP id of a shared calendar, before its `id` was
  // namespaced as `${accountId}:${id}` to stay unique in the store. Mutations
  // and event queries must use this raw id against the owning account.
  originalId?: string;
  // Client-only: true when the calendar lives in another account (shared
  // with the user by its owner).
  isShared?: boolean;
  // Client-only: set when `color` has been replaced by the viewer's local
  // override for a shared calendar (see lib/calendar-utils). When true, the
  // override wins over per-event colors so the whole shared calendar paints
  // uniformly.
  colorIsLocalOverride?: boolean;
}

// ─── Files (FileNode) ───────────────────────────────────

export interface FileNode {
  id: string;
  name: string;
  parentId?: string | null;
  type: string;
  blobId?: string | null;
  size?: number;
  created?: string;
  // Last modification time (UTCDate). Older builds asked for a non-existent
  // `updated` property, which the server silently left undefined (#700).
  modified?: string;
  // JMAP Sharing (RFC 9670). Populated only when the server advertises the
  // principals capability and the properties are requested explicitly. A node
  // is shared-out when `shareWith` has entries; `myRights` describes what the
  // viewer may do (always full rights on owned nodes).
  myRights?: FileNodeRights;
  shareWith?: Record<string, FileNodeRights> | null;
  // True when this node was fetched from another principal's account that was
  // shared with the logged-in user ("Shared with me").
  isShared?: boolean;
  // Owning account's JMAP id and display name, set when aggregating nodes
  // across accounts so blob downloads route to the right account.
  accountId?: string;
  accountName?: string;
}

// FileNode rights as defined by Stalwart's JmapSharedObject implementation.
export interface FileNodeRights {
  mayRead: boolean;
  mayAddChildren: boolean;
  mayRename: boolean;
  mayDelete: boolean;
  mayModifyContent: boolean;
  mayShare: boolean;
}

// RFC 9670 principal — an entity (user, group, resource) that files and
// calendars can be shared with. On Stalwart the principal id doubles as the
// account id of that user/group.
export interface Principal {
  id: string;
  type: 'individual' | 'group' | 'resource' | 'location' | 'other';
  name: string;
  description?: string | null;
  email?: string | null;
}

// ─── Push / SSE ─────────────────────────────────────────

export interface StateChange {
  '@type': 'StateChange';
  changed: Record<string, Record<string, string>>;
}

// RFC 8620 §7.2. A PushSubscription is session-scoped (not per-account) and
// tells the server where to deliver StateChange events for the listed types.
export interface PushSubscription {
  id: string;
  deviceClientId: string;
  url: string;
  keys?: { p256dh: string; auth: string } | null;
  verificationCode?: string | null;
  expires?: string | null;
  types?: string[] | null;
  emailPush?: Record<string, EmailPushConfig> | null;
}

// draft-ietf-jmap-emailpush EmailPushConfig: the server evaluates `filter`
// against every newly delivered message and only pushes when it matches, so a
// client can keep spam (Junk) out of its push channel server-side. Keyed by
// account id on PushSubscription.emailPush.
export interface EmailPushConfig {
  filter: Record<string, unknown> | null;
  properties: string[];
  urgency?: 'very-low' | 'low' | 'normal' | 'high';
}

// ─── Capability URNs ────────────────────────────────────

export const CAPABILITIES = {
  CORE: 'urn:ietf:params:jmap:core',
  MAIL: 'urn:ietf:params:jmap:mail',
  SUBMISSION: 'urn:ietf:params:jmap:submission',
  VACATION: 'urn:ietf:params:jmap:vacationresponse',
  CONTACTS: 'urn:ietf:params:jmap:contacts',
  CALENDARS: 'urn:ietf:params:jmap:calendars',
  SIEVE: 'urn:ietf:params:jmap:sieve',
  QUOTA: 'urn:ietf:params:jmap:quota',
  FILES: 'urn:ietf:params:jmap:filenode',
  PRINCIPALS: 'urn:ietf:params:jmap:principals',
  PRINCIPALS_OWNER: 'urn:ietf:params:jmap:principals:owner',
  EMAIL_PUSH: 'urn:ietf:params:jmap:emailpush',
} as const;
