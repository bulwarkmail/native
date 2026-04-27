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
}

export interface JMAPAccountInfo {
  name: string;
  isPersonal: boolean;
  isReadOnly: boolean;
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
  textBody?: BodyPart[];
  htmlBody?: BodyPart[];
  bodyValues?: Record<string, { value: string; isEncodingProblem?: boolean }>;
  attachments?: Attachment[];
  blobId?: string;
  bodyStructure?: BodyPart;
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
  id: string;
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
  keywords?: Record<string, boolean>;
  members?: Record<string, boolean>;
  speakToAs?: ContactSpeakToAs;
  calendarUri?: string;
  schedulingUri?: string;
  freeBusyUri?: string;
  created?: string;
  updated?: string;
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
}

export interface AddressBookWithCount extends AddressBook {
  count: number;
}

// ─── Calendar (RFC 8984 JSCalendar) ─────────────────────

export interface Participant {
  name?: string;
  email?: string;
  sendTo?: Record<string, string>;
  kind?: string;
  roles?: Record<string, boolean>;
  participationStatus?: string;
  expectReply?: boolean;
}

export interface RecurrenceRule {
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
}

export interface Alert {
  trigger: { '@type': string; offset?: string; when?: string };
  action?: string;
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
  timeZone?: string;
  showWithoutTime?: boolean;
  utcStart?: string;
  utcEnd?: string;
  status?: string;
  freeBusyStatus?: string;
  participants?: Record<string, Participant>;
  recurrenceRules?: RecurrenceRule[];
  recurrenceOverrides?: Record<string, Partial<CalendarEvent>>;
  excludedRecurrenceRules?: RecurrenceRule[];
  recurrenceId?: string;
  originalId?: string;
  alerts?: Record<string, Alert>;
  links?: Record<string, { href: string; rel?: string }>;
  created?: string;
  updated?: string;
  progress?: string;
  due?: string;
  color?: string;
}

export interface Calendar {
  id: string;
  name: string;
  color?: string;
  isVisible?: boolean;
  sortOrder?: number;
  myRights?: Record<string, boolean>;
}

// ─── Files (FileNode) ───────────────────────────────────

export interface FileNode {
  id: string;
  name: string;
  parentId?: string | null;
  type: string;
  blobId?: string;
  size?: number;
  created?: string;
  updated?: string;
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
} as const;
