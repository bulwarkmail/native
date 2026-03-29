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

export interface ContactCard {
  id: string;
  uid?: string;
  addressBookIds: Record<string, boolean>;
  kind?: string;
  name?: { components: Array<{ kind: string; value: string }> };
  emails?: Record<string, {
    address: string;
    contexts?: Record<string, boolean>;
    label?: string;
    pref?: number;
  }>;
  phones?: Record<string, {
    number: string;
    features?: Record<string, boolean>;
    label?: string;
    pref?: number;
  }>;
  addresses?: Record<string, {
    components?: any[];
    full?: string;
    countryCode?: string;
  }>;
  organizations?: Record<string, {
    name: string;
    units?: Array<{ name: string }>;
  }>;
  titles?: Record<string, { name: string }>;
  notes?: Record<string, { note: string }>;
  media?: Record<string, { kind: string; uri?: string; mediaType?: string }>;
  keywords?: Record<string, boolean>;
}

export interface AddressBook {
  id: string;
  name: string;
  isDefault?: boolean;
  sortOrder?: number;
  myRights?: Record<string, boolean>;
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
  alerts?: Record<string, Alert>;
  links?: Record<string, { href: string; rel?: string }>;
  created?: string;
  updated?: string;
  progress?: string;
  due?: string;
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
