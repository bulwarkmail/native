# JMAP Implementation Prompt — Bulwark Mobile App

> Use this prompt to implement a full JMAP (JSON Meta Application Protocol) client layer in the React Native mobile app at `repos/react-native/`, connecting it to the same Stalwart JMAP backend the webmail uses.

---

## Goal

Replace all mock/hardcoded data in the mobile app with a working JMAP client that authenticates against the Stalwart server, fetches real mailboxes, emails, contacts, calendars, and files, and receives real-time state change notifications. The implementation must mirror the patterns already established in the webmail's `lib/jmap/client.ts`.

---

## Project Context

- **Mobile app location:** `repos/react-native/` (Expo + React Native + TypeScript)
- **Webmail JMAP client reference:** `lib/jmap/client.ts`
- **Webmail auth reference:** `lib/auth/crypto.ts`, `lib/auth/session-cookie.ts`
- **Webmail store reference:** `stores/`
- **Backend:** Stalwart JMAP server (RFC 8620, RFC 8621)
- **Current state:** All screens use `MOCK_EMAILS`, `MOCK_CONTACTS`, etc. No networking exists.

---

## Architecture

Create the following directory structure inside `repos/react-native/src/`:

```
src/
├── api/
│   ├── jmap-client.ts          # Core JMAP client (session, requests, auth)
│   ├── types.ts                # TypeScript interfaces for all JMAP objects
│   ├── email.ts                # Email/Mailbox/Thread operations
│   ├── contacts.ts             # AddressBook/ContactCard operations
│   ├── calendar.ts             # Calendar/CalendarEvent operations
│   ├── files.ts                # FileNode operations (if supported)
│   ├── identity.ts             # Identity operations
│   ├── submission.ts           # EmailSubmission (send)
│   ├── blob.ts                 # Upload/download blob helpers
│   └── push.ts                 # EventSource (SSE) real-time updates
├── stores/
│   ├── auth-store.ts           # Login state, credentials, tokens
│   ├── email-store.ts          # Mailboxes, emails, threads cache
│   ├── contacts-store.ts       # Address books, contact cards cache
│   ├── calendar-store.ts       # Calendars, events cache
│   └── settings-store.ts       # User preferences, identities
```

---

## Phase 1 — JMAP Client Core (`api/jmap-client.ts`)

### Session Discovery

Implement the JMAP session bootstrap per RFC 8620 §2:

```
GET /.well-known/jmap
Authorization: Basic <base64(username:password)>
```

Response shape:

```typescript
interface JMAPSession {
  apiUrl: string;
  downloadUrl: string; // RFC 6570 template: {accountId}/{blobId}/{name}?type={type}
  uploadUrl: string; // RFC 6570 template: {accountId}/
  eventSourceUrl: string; // SSE endpoint template: {types}/{closeafter}/{ping}
  primaryAccounts: Record<string, string>; // capability URN → accountId
  accounts: Record<
    string,
    { name: string; isPersonal: boolean; isReadOnly: boolean }
  >;
  capabilities: Record<string, unknown>;
  state: string;
}
```

### Authentication

Support two auth modes (match the webmail):

1. **Basic Auth** — `Authorization: Basic <base64(username:password)>`
2. **Bearer Token** — `Authorization: Bearer <accessToken>` (for OAuth flows)

Store credentials securely using `expo-secure-store`:

```typescript
import * as SecureStore from "expo-secure-store";

await SecureStore.setItemAsync(
  "jmap_credentials",
  JSON.stringify({ serverUrl, username, password }),
);
const creds = JSON.parse(
  (await SecureStore.getItemAsync("jmap_credentials")) ?? "",
);
```

On 401 response: attempt token refresh (bearer) or prompt re-login (basic).

### API Request Method

```typescript
type JMAPMethodCall = [string, Record<string, unknown>, string];

interface JMAPRequestBody {
  using: string[];
  methodCalls: JMAPMethodCall[];
}

interface JMAPResponseBody {
  methodResponses: Array<[string, Record<string, any>, string]>;
  sessionState?: string;
}

async function request(
  methodCalls: JMAPMethodCall[],
  using?: string[],
): Promise<JMAPResponseBody> {
  // POST to session.apiUrl
  // Headers: Content-Type: application/json, Authorization header
  // Body: { using: [...capabilities], methodCalls }
  // Handle 401 → re-auth, 429 → rate limit with Retry-After
}
```

### Capability URNs Used

Include all of these in the `using` array as needed:

| URN                                     | Purpose                   |
| --------------------------------------- | ------------------------- |
| `urn:ietf:params:jmap:core`             | Always required           |
| `urn:ietf:params:jmap:mail`             | Email, Mailbox, Thread    |
| `urn:ietf:params:jmap:submission`       | EmailSubmission (sending) |
| `urn:ietf:params:jmap:vacationresponse` | Vacation auto-reply       |
| `urn:ietf:params:jmap:contacts`         | AddressBook, ContactCard  |
| `urn:ietf:params:jmap:calendars`        | Calendar, CalendarEvent   |
| `urn:ietf:params:jmap:sieve`            | SieveScript (filters)     |
| `urn:ietf:params:jmap:quota`            | Quota info                |

Check `session.capabilities` before using any non-core capability.

---

## Phase 2 — TypeScript Interfaces (`api/types.ts`)

Define these interfaces matching both the JMAP RFCs and the webmail's existing types:

```typescript
// ─── Email (RFC 8621) ────────────────────────────────────
interface EmailAddress {
  name?: string;
  email: string;
}

interface Email {
  id: string;
  threadId: string;
  mailboxIds: Record<string, boolean>;
  keywords: Record<string, boolean>; // $seen, $flagged, $draft, $answered, $forwarded, $label:*
  size: number;
  receivedAt: string; // UTC ISO 8601
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

interface BodyPart {
  partId?: string;
  blobId?: string;
  type?: string;
  name?: string;
  disposition?: string;
  size?: number;
  cid?: string;
}

interface Attachment {
  blobId: string;
  type: string;
  name?: string;
  size?: number;
  disposition?: string;
}

interface Mailbox {
  id: string;
  name: string;
  parentId?: string | null;
  role?: string | null; // inbox, drafts, sent, trash, junk, archive, etc.
  sortOrder?: number;
  totalEmails: number;
  unreadEmails: number;
  totalThreads: number;
  unreadThreads: number;
  myRights: MailboxRights;
  isSubscribed?: boolean;
}

interface MailboxRights {
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

interface Thread {
  id: string;
  emailIds: string[];
}

// ─── Identity & Submission ───────────────────────────────
interface Identity {
  id: string;
  name: string;
  email: string;
  replyTo?: EmailAddress[];
  bcc?: EmailAddress[];
  textSignature?: string;
  htmlSignature?: string;
  mayDelete: boolean;
}

// ─── Contacts (RFC 9553 JSContact) ──────────────────────
interface ContactCard {
  id: string;
  uid?: string;
  addressBookIds: Record<string, boolean>;
  kind?: string;
  name?: { components: Array<{ kind: string; value: string }> };
  emails?: Record<
    string,
    {
      address: string;
      contexts?: Record<string, boolean>;
      label?: string;
      pref?: number;
    }
  >;
  phones?: Record<
    string,
    {
      number: string;
      features?: Record<string, boolean>;
      label?: string;
      pref?: number;
    }
  >;
  addresses?: Record<
    string,
    { components?: any[]; full?: string; countryCode?: string }
  >;
  organizations?: Record<
    string,
    { name: string; units?: Array<{ name: string }> }
  >;
  titles?: Record<string, { name: string }>;
  notes?: Record<string, { note: string }>;
  media?: Record<string, { kind: string; uri?: string; mediaType?: string }>;
  keywords?: Record<string, boolean>;
}

interface AddressBook {
  id: string;
  name: string;
  isDefault?: boolean;
  sortOrder?: number;
  myRights?: Record<string, boolean>;
}

// ─── Calendar (RFC 8984 JSCalendar) ─────────────────────
interface CalendarEvent {
  id: string;
  "@type"?: "Event" | "Task";
  uid: string;
  calendarIds: Record<string, boolean>;
  title: string;
  description?: string;
  start: string; // Local date-time "2026-03-29T10:00:00"
  duration?: string; // "PT1H", "P1D"
  timeZone?: string; // IANA tz "America/New_York"
  showWithoutTime?: boolean; // All-day event
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
  progress?: string; // Tasks: needs-action, in-process, completed, failed
  due?: string; // Tasks only
}

interface Calendar {
  id: string;
  name: string;
  color?: string;
  isVisible?: boolean;
  sortOrder?: number;
  myRights?: Record<string, boolean>;
}

interface Participant {
  name?: string;
  email?: string;
  sendTo?: Record<string, string>;
  kind?: string;
  roles?: Record<string, boolean>;
  participationStatus?: string; // needs-action, accepted, declined, tentative
  expectReply?: boolean;
}

interface RecurrenceRule {
  frequency: string; // daily, weekly, monthly, yearly
  interval?: number;
  until?: string;
  count?: number;
  byDay?: Array<{ day: string; nthOfPeriod?: number }>;
  byMonth?: string[];
  byMonthDay?: number[];
}

interface Alert {
  trigger: { "@type": string; offset?: string; when?: string };
  action?: string;
}

// ─── Files (FileNode) ───────────────────────────────────
interface FileNode {
  id: string;
  name: string;
  parentId?: string | null;
  type: string;
  blobId?: string;
  size?: number;
  created?: string;
  updated?: string;
}
```

---

## Phase 3 — Email Operations (`api/email.ts`)

### Fetch Mailboxes

```typescript
async function getMailboxes(): Promise<Mailbox[]> {
  const res = await request([["Mailbox/get", { accountId }, "0"]]);
  return res.methodResponses[0][1].list;
}
```

### Query Emails (Inbox List)

```typescript
const EMAIL_LIST_PROPERTIES = [
  "id",
  "threadId",
  "mailboxIds",
  "keywords",
  "size",
  "receivedAt",
  "from",
  "to",
  "cc",
  "subject",
  "preview",
  "hasAttachment",
];

async function queryEmails(
  mailboxId: string,
  options?: {
    position?: number;
    limit?: number;
    sort?: Array<{ property: string; isAscending: boolean }>;
    filter?: Record<string, unknown>;
  },
): Promise<{ ids: string[]; total: number }> {
  const res = await request([
    [
      "Email/query",
      {
        accountId,
        filter: { inMailbox: mailboxId, ...options?.filter },
        sort: options?.sort ?? [{ property: "receivedAt", isAscending: false }],
        position: options?.position ?? 0,
        limit: options?.limit ?? 50,
        calculateTotal: true,
      },
      "0",
    ],
  ]);
  return {
    ids: res.methodResponses[0][1].ids,
    total: res.methodResponses[0][1].total,
  };
}

async function getEmails(ids: string[]): Promise<Email[]> {
  const res = await request([
    [
      "Email/get",
      {
        accountId,
        ids,
        properties: EMAIL_LIST_PROPERTIES,
      },
      "0",
    ],
  ]);
  return res.methodResponses[0][1].list;
}
```

### Get Full Email (Thread View)

```typescript
async function getFullEmail(id: string): Promise<Email> {
  const res = await request([
    [
      "Email/get",
      {
        accountId,
        ids: [id],
        properties: [
          ...EMAIL_LIST_PROPERTIES,
          "bodyStructure",
          "textBody",
          "htmlBody",
          "attachments",
          "blobId",
        ],
        fetchHTMLBodyValues: true,
        fetchTextBodyValues: true,
        maxBodyValueBytes: 512000,
      },
      "0",
    ],
  ]);
  return res.methodResponses[0][1].list[0];
}

async function getThread(threadId: string): Promise<Thread> {
  const res = await request([
    ["Thread/get", { accountId, ids: [threadId] }, "0"],
  ]);
  return res.methodResponses[0][1].list[0];
}
```

### Mutate Emails

```typescript
// Mark read/unread
async function setEmailKeywords(
  emailId: string,
  keywords: Record<string, boolean>,
): Promise<void> {
  await request([
    [
      "Email/set",
      {
        accountId,
        update: { [emailId]: { keywords } },
      },
      "0",
    ],
  ]);
}

// Move to mailbox
async function moveEmail(
  emailId: string,
  fromMailboxId: string,
  toMailboxId: string,
): Promise<void> {
  await request([
    [
      "Email/set",
      {
        accountId,
        update: {
          [emailId]: {
            [`mailboxIds/${fromMailboxId}`]: null,
            [`mailboxIds/${toMailboxId}`]: true,
          },
        },
      },
      "0",
    ],
  ]);
}

// Delete (move to Trash, or destroy if already in Trash)
async function deleteEmail(
  emailId: string,
  trashMailboxId: string,
  currentMailboxId: string,
): Promise<void> {
  if (currentMailboxId === trashMailboxId) {
    await request([["Email/set", { accountId, destroy: [emailId] }, "0"]]);
  } else {
    await moveEmail(emailId, currentMailboxId, trashMailboxId);
  }
}
```

### Search

```typescript
async function searchEmails(
  query: string,
  mailboxId?: string,
  limit = 30,
): Promise<string[]> {
  const filter: Record<string, unknown> = {
    text: query.endsWith("*") ? query : `${query}*`,
  };
  if (mailboxId) filter.inMailbox = mailboxId;

  const res = await request([
    [
      "Email/query",
      {
        accountId,
        filter,
        sort: [{ property: "receivedAt", isAscending: false }],
        limit,
      },
      "0",
    ],
  ]);
  return res.methodResponses[0][1].ids;
}
```

### Send Email

```typescript
async function sendEmail(
  email: {
    from: EmailAddress[];
    to: EmailAddress[];
    cc?: EmailAddress[];
    bcc?: EmailAddress[];
    subject: string;
    htmlBody?: string;
    textBody?: string;
    attachments?: Array<{ blobId: string; type: string; name: string }>;
    inReplyTo?: string;
    references?: string;
  },
  identityId: string,
): Promise<void> {
  const emailCreate: Record<string, unknown> = {
    from: email.from,
    to: email.to,
    cc: email.cc,
    bcc: email.bcc,
    subject: email.subject,
    mailboxIds: { [sentMailboxId]: true },
    keywords: { $seen: true },
  };

  if (email.htmlBody) {
    emailCreate.htmlBody = [{ partId: "html", type: "text/html" }];
    emailCreate.bodyValues = { html: { value: email.htmlBody } };
  } else {
    emailCreate.textBody = [{ partId: "text", type: "text/plain" }];
    emailCreate.bodyValues = { text: { value: email.textBody ?? "" } };
  }

  if (email.attachments?.length) {
    emailCreate.attachments = email.attachments.map((a) => ({
      blobId: a.blobId,
      type: a.type,
      name: a.name,
      disposition: "attachment",
    }));
  }

  if (email.inReplyTo) {
    emailCreate["header:In-Reply-To:asText"] = email.inReplyTo;
    emailCreate["header:References:asText"] =
      email.references ?? email.inReplyTo;
  }

  await request(
    [
      ["Email/set", { accountId, create: { draft: emailCreate } }, "0"],
      [
        "EmailSubmission/set",
        {
          accountId,
          create: { "sub-1": { emailId: "#draft", identityId } },
        },
        "1",
      ],
    ],
    [
      "urn:ietf:params:jmap:core",
      "urn:ietf:params:jmap:mail",
      "urn:ietf:params:jmap:submission",
    ],
  );
}
```

---

## Phase 4 — Contacts Operations (`api/contacts.ts`)

```typescript
async function getAddressBooks(): Promise<AddressBook[]> {
  const res = await request(
    [["AddressBook/get", { accountId }, "0"]],
    ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:contacts"],
  );
  return res.methodResponses[0][1].list;
}

async function queryContacts(
  filter?: { text?: string; inAddressBook?: string },
  limit = 100,
): Promise<string[]> {
  const res = await request(
    [
      [
        "ContactCard/query",
        {
          accountId,
          filter: filter ?? {},
          sort: [{ property: "name", isAscending: true }],
          limit,
        },
        "0",
      ],
    ],
    ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:contacts"],
  );
  return res.methodResponses[0][1].ids;
}

async function getContacts(ids: string[]): Promise<ContactCard[]> {
  const res = await request(
    [["ContactCard/get", { accountId, ids }, "0"]],
    ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:contacts"],
  );
  return res.methodResponses[0][1].list;
}

async function createContact(
  contact: Partial<ContactCard>,
  addressBookId: string,
): Promise<ContactCard> {
  const res = await request(
    [
      [
        "ContactCard/set",
        {
          accountId,
          create: {
            "new-contact": {
              ...contact,
              addressBookIds: { [addressBookId]: true },
            },
          },
        },
        "0",
      ],
    ],
    ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:contacts"],
  );
  return res.methodResponses[0][1].created["new-contact"];
}

async function updateContact(
  id: string,
  changes: Partial<ContactCard>,
): Promise<void> {
  await request(
    [["ContactCard/set", { accountId, update: { [id]: changes } }, "0"]],
    ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:contacts"],
  );
}

async function deleteContacts(ids: string[]): Promise<void> {
  await request(
    [["ContactCard/set", { accountId, destroy: ids }, "0"]],
    ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:contacts"],
  );
}
```

---

## Phase 5 — Calendar Operations (`api/calendar.ts`)

```typescript
async function getCalendars(): Promise<Calendar[]> {
  const res = await request(
    [["Calendar/get", { accountId }, "0"]],
    ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:calendars"],
  );
  return res.methodResponses[0][1].list;
}

const CALENDAR_EVENT_PROPERTIES = [
  "id",
  "@type",
  "uid",
  "calendarIds",
  "title",
  "description",
  "start",
  "duration",
  "timeZone",
  "showWithoutTime",
  "utcStart",
  "utcEnd",
  "status",
  "freeBusyStatus",
  "participants",
  "alerts",
  "recurrenceRules",
  "recurrenceOverrides",
  "excludedRecurrenceRules",
  "links",
  "created",
  "updated",
];

async function queryEvents(
  calendarIds: string[],
  after: string,
  before: string,
): Promise<string[]> {
  const res = await request(
    [
      [
        "CalendarEvent/query",
        {
          accountId,
          filter: { inCalendars: calendarIds, after, before, types: ["Event"] },
          sort: [{ property: "start", isAscending: true }],
          limit: 500,
        },
        "0",
      ],
    ],
    ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:calendars"],
  );
  return res.methodResponses[0][1].ids;
}

async function getEvents(ids: string[]): Promise<CalendarEvent[]> {
  const res = await request(
    [
      [
        "CalendarEvent/get",
        { accountId, ids, properties: CALENDAR_EVENT_PROPERTIES },
        "0",
      ],
    ],
    ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:calendars"],
  );
  return res.methodResponses[0][1].list;
}

async function createEvent(
  event: Partial<CalendarEvent>,
  calendarId: string,
): Promise<CalendarEvent> {
  const res = await request(
    [
      [
        "CalendarEvent/set",
        {
          accountId,
          create: {
            "new-event": { ...event, calendarIds: { [calendarId]: true } },
          },
        },
        "0",
      ],
    ],
    ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:calendars"],
  );
  return res.methodResponses[0][1].created["new-event"];
}

async function updateEvent(
  id: string,
  changes: Partial<CalendarEvent>,
): Promise<void> {
  await request(
    [["CalendarEvent/set", { accountId, update: { [id]: changes } }, "0"]],
    ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:calendars"],
  );
}

async function deleteEvents(ids: string[]): Promise<void> {
  await request(
    [["CalendarEvent/set", { accountId, destroy: ids }, "0"]],
    ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:calendars"],
  );
}
```

---

## Phase 6 — Blob Upload/Download (`api/blob.ts`)

```typescript
async function uploadBlob(
  uri: string,
  type: string,
  name: string,
): Promise<{ blobId: string; size: number }> {
  // Use fetch with file URI from image picker / document picker
  const response = await fetch(
    session.uploadUrl.replace("{accountId}", accountId),
    {
      method: "POST",
      headers: {
        "Content-Type": type,
        Authorization: authHeader,
      },
      body: await fetch(uri).then((r) => r.blob()),
    },
  );
  return response.json();
}

function getDownloadUrl(blobId: string, name?: string, type?: string): string {
  return session.downloadUrl
    .replace("{accountId}", accountId)
    .replace("{blobId}", blobId)
    .replace("{name}", encodeURIComponent(name ?? "download"))
    .replace("{type}", encodeURIComponent(type ?? "application/octet-stream"));
}
```

---

## Phase 7 — Real-Time Push Updates (`api/push.ts`)

### Server-Sent Events (SSE)

```typescript
import EventSource from "react-native-sse"; // or polyfill

interface StateChange {
  "@type": "StateChange";
  changed: Record<string, Record<string, string>>;
  // e.g. { "account-id": { "Email": "state123", "Mailbox": "state456" } }
}

function connectEventSource(
  session: JMAPSession,
  accountId: string,
  onStateChange: (change: StateChange) => void,
): () => void {
  const url = session.eventSourceUrl
    .replace("{types}", "*")
    .replace("{closeafter}", "no")
    .replace("{ping}", "30");

  const es = new EventSource(url, {
    headers: { Authorization: authHeader },
  });

  es.addEventListener("state", (event) => {
    const data: StateChange = JSON.parse(event.data);
    onStateChange(data);
  });

  // Return cleanup function
  return () => es.close();
}
```

### Polling Fallback

If SSE is not available (no `eventSourceUrl` in session), fall back to polling every 5 seconds:

```typescript
function startPolling(interval = 5000): () => void {
  const timer = setInterval(async () => {
    const res = await request([
      ["Mailbox/get", { accountId, ids: null }, "m"],
      ["Email/get", { accountId, ids: [] }, "e"],
    ]);
    // Compare state strings with cached state
    // If different, trigger refresh
  }, interval);

  return () => clearInterval(timer);
}
```

### State Change Handler

When a state change is received:

| Changed Type    | Action                                 |
| --------------- | -------------------------------------- |
| `Mailbox`       | Re-fetch mailbox list (unread counts)  |
| `Email`         | Re-query current mailbox email list    |
| `Thread`        | Re-fetch open thread                   |
| `Calendar`      | Re-fetch calendar list                 |
| `CalendarEvent` | Re-query events for visible date range |
| `ContactCard`   | Re-fetch contact list                  |

---

## Phase 8 — State Management (`stores/`)

Use Zustand for lightweight state management (already common in Expo projects):

```bash
npx expo install zustand
```

### Auth Store (`stores/auth-store.ts`)

```typescript
interface AuthState {
  isAuthenticated: boolean;
  serverUrl: string | null;
  username: string | null;
  session: JMAPSession | null;
  accountId: string | null;

  login: (
    serverUrl: string,
    username: string,
    password: string,
  ) => Promise<void>;
  logout: () => void;
  restoreSession: () => Promise<boolean>;
}
```

### Email Store (`stores/email-store.ts`)

```typescript
interface EmailState {
  mailboxes: Mailbox[];
  currentMailboxId: string | null;
  emails: Email[];
  totalEmails: number;
  loading: boolean;
  error: string | null;

  fetchMailboxes: () => Promise<void>;
  fetchEmails: (mailboxId: string, position?: number) => Promise<void>;
  fetchMore: () => Promise<void>; // Infinite scroll
  refreshEmails: () => Promise<void>; // Pull-to-refresh
  getFullEmail: (id: string) => Promise<Email>;
  getThread: (threadId: string) => Promise<Email[]>;
  toggleStar: (emailId: string) => Promise<void>;
  markRead: (emailId: string) => Promise<void>;
  moveToTrash: (emailId: string) => Promise<void>;
  searchEmails: (query: string) => Promise<Email[]>;
}
```

### Contacts Store (`stores/contacts-store.ts`)

```typescript
interface ContactsState {
  addressBooks: AddressBook[];
  contacts: ContactCard[];
  loading: boolean;

  fetchContacts: () => Promise<void>;
  searchContacts: (query: string) => Promise<void>;
  createContact: (contact: Partial<ContactCard>) => Promise<void>;
  updateContact: (id: string, changes: Partial<ContactCard>) => Promise<void>;
  deleteContact: (id: string) => Promise<void>;
}
```

### Calendar Store (`stores/calendar-store.ts`)

```typescript
interface CalendarState {
  calendars: Calendar[];
  events: CalendarEvent[];
  loading: boolean;

  fetchCalendars: () => Promise<void>;
  fetchEvents: (start: string, end: string) => Promise<void>;
  createEvent: (event: Partial<CalendarEvent>) => Promise<void>;
  updateEvent: (id: string, changes: Partial<CalendarEvent>) => Promise<void>;
  deleteEvent: (id: string) => Promise<void>;
}
```

---

## Phase 9 — Wire Screens to Real Data

### LoginScreen

Replace the mock `handleLogin`:

```typescript
const { login } = useAuthStore();
await login(serverUrl, username, password);
// On success → navigate to main tabs
// On failure → show error below form
```

Add a **Server URL** input field above email/password (the webmail auto-detects, but the mobile app should let users enter their server URL since it connects directly).

### EmailListScreen

Replace `MOCK_EMAILS`:

```typescript
const {
  mailboxes,
  emails,
  currentMailboxId,
  fetchMailboxes,
  fetchEmails,
  loading,
} = useEmailStore();

useEffect(() => {
  fetchMailboxes().then(() => {
    const inbox = mailboxes.find((m) => m.role === "inbox");
    if (inbox) fetchEmails(inbox.id);
  });
}, []);

// FlatList data = emails
// Pull-to-refresh = refreshEmails()
// Infinite scroll = onEndReached → fetchMore()
```

### EmailThreadScreen

Replace mock thread data:

```typescript
const { getThread, getFullEmail } = useEmailStore();
const thread = await getThread(threadId);
const emails = await Promise.all(thread.emailIds.map((id) => getFullEmail(id)));
```

### ComposeScreen

Wire to `sendEmail()`:

```typescript
const { session } = useAuthStore();
// Upload attachments first → get blobIds
// Build email object
// Call sendEmail(email, identityId)
```

### ContactsScreen

Replace `MOCK_CONTACTS`:

```typescript
const { contacts, fetchContacts, searchContacts } = useContactsStore();
useEffect(() => {
  fetchContacts();
}, []);
```

### CalendarScreen

Replace `MOCK_EVENTS`:

```typescript
const { events, fetchEvents } = useCalendarStore();
useEffect(() => {
  const start = startOfMonth(currentDate).toISOString();
  const end = endOfMonth(currentDate).toISOString();
  fetchEvents(start, end);
}, [currentDate]);
```

---

## Phase 10 — Error Handling

### Rate Limiting

```typescript
class RateLimitError extends Error {
  retryAfterMs: number;
  constructor(retryAfterMs: number) {
    super(`Rate limited. Retry after ${retryAfterMs}ms`);
    this.retryAfterMs = retryAfterMs;
  }
}

// In request():
if (response.status === 429) {
  const retryAfter = response.headers.get("Retry-After");
  const ms = retryAfter
    ? Number(retryAfter) * 1000 || Date.parse(retryAfter) - Date.now()
    : 60000;
  throw new RateLimitError(Math.min(ms, 300000)); // Cap at 5 minutes
}
```

### JMAP Method Errors

```typescript
// Check each methodResponse for error tuples:
for (const [name, result, callId] of response.methodResponses) {
  if (name === "error") {
    throw new JMAPError(result.type, result.description);
  }
  // Also check notCreated, notUpdated, notDestroyed in /set responses
}
```

### Network Errors

```typescript
// Wrap all requests in try/catch
// On network failure → show offline banner
// On 401 → redirect to login
// On JMAP error → show toast with description
```

---

## Dependencies to Install

```bash
npx expo install zustand expo-secure-store
npm install react-native-sse   # SSE polyfill for React Native
```

---

## Implementation Order

1. `api/types.ts` — all interfaces (no dependencies)
2. `api/jmap-client.ts` — session + request core
3. `api/blob.ts` — upload/download helpers
4. `api/email.ts` — mailbox + email operations
5. `api/contacts.ts` — address book + contact operations
6. `api/calendar.ts` — calendar + event operations
7. `api/identity.ts` + `api/submission.ts` — sending
8. `stores/auth-store.ts` — login flow
9. `stores/email-store.ts` — wire EmailListScreen + EmailThreadScreen
10. `stores/contacts-store.ts` — wire ContactsScreen
11. `stores/calendar-store.ts` — wire CalendarScreen
12. `api/push.ts` — real-time updates (SSE + fallback polling)
13. Wire ComposeScreen to send flow
14. Wire SettingsScreen to Identity/get and VacationResponse

---

## Testing

- Test against Stalwart server at `https://your-server/.well-known/jmap`
- Verify session discovery returns valid `apiUrl`, `downloadUrl`, `uploadUrl`
- Verify Basic Auth login → session → Mailbox/get returns inbox
- Verify Email/query + Email/get returns real emails
- Verify Email/set can toggle `$seen` and `$flagged` keywords
- Verify EmailSubmission/set sends a real email
- Verify SSE connection receives state changes on new mail
- Test 401 re-auth flow and 429 rate limit backoff
