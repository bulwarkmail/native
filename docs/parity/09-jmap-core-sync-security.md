# JMAP client core, live sync, offline/outbox, network & error handling, security, S/MIME & encryption-at-rest

## Summary
RN's JMAP client (`src/api/jmap-client.ts`, 615 lines) is a thin transport: session discovery, Basic/Bearer auth with proactive+reactive OAuth refresh, 401/429 mapping, capability lookups, blob URL templating. It lacks essentially every robustness layer WEB grew between 1.4.5 and 1.9.2: request deadlines (#702), `maxConcurrentRequests` back-off (#780), transient-network retry, rate-limit pause/resume, `maxObjectsInSet`/`maxSizeUpload` awareness, relative-session-URL resolution, keep-alive ping with connection-lost signalling, and first-touch serialisation (#907). Most RN API functions index `methodResponses[0][1]` without checking for `error` / `notUpdated`, which combines badly with the outbox (a rejected mutation is treated as done). Live sync is the weakest area: there is no `AppState` handling at all, `react-native-sse` never re-polls after a network error (status 0), the SSE stream captures the Authorization header once (stale after OAuth refresh), the push effect does not re-run on account switch (stream stays bound to the previous account), and a client-cert user gets no SSE and no polling fallback. Security posture is decent (SecureStore, hardened WebView, no secret logging) but has gaps: `Linking.openURL` with unvalidated schemes from contact/calendar data, `Math.random` for OAuth `state` and TOTP secret, http:// server URLs accepted, AsyncStorage mail cache in Android auto-backup, password change leaving stored credentials stale (locks the account out). S/MIME is a mock UI; encryption-at-rest is read-only; List-Unsubscribe is absent.

## Findings

### JMAP client core (request pipeline)

- [x] **No request deadline: a stalled socket hangs send/save forever (#702)** — `P1` — `bugfix-parity` — fixed in 0b1c240
  - What WEB does: `timedFetch` puts a 30 s deadline on response headers (300 s for blob transfers), throws `RequestTimeoutError`, never retries a timed-out non-idempotent request (`lib/jmap/client.ts:629-634`, `786-816`, `836-846`; changelog 1.7.x "Time out stalled JMAP requests so a send can't hang forever (#702)").
  - What RN does: `request()`, `fetchSession()`, `fetchBlobArrayBuffer()` call `secureFetch` with no `AbortController`/timeout (`src/api/jmap-client.ts:405-447`, `363-386`, `568-584`). RN `fetch` has no timeout of its own; iOS suspends sockets in background and hands back dead pooled connections on resume, so the composer's Send stays disabled indefinitely. Only the client-cert native path has a 30 s timeout (`src/lib/client-cert.ts:250`).
  - Fix hint: wrap every fetch in `jmap-client.ts` with an `AbortController` + `setTimeout` (30 s API, 300 s blob), throw a `RequestTimeoutError` subclass, and make `isTransientNetworkError` classify it as transient only for idempotent ops (never re-send `EmailSubmission/set`).

- [x] **`maxConcurrentRequests` refusal (400 `jmap:error:limit`) is a hard failure (#780)** — `P2` — `bugfix-parity` — fixed in 0b1c240
  - What WEB does: `isConcurrentRequestRefusal` + 3 jittered retries (200/400/800 ms) before failing (`lib/jmap/client.ts:462-473`, `1136-1146`; changelog "Keep the folder tree when a refresh burst hits maxConcurrentRequests (#780)").
  - What RN does: any non-OK status throws `JMAP request failed: 400` (`src/api/jmap-client.ts:442-444`). A single StateChange fans out to `handleStateChange` in email, contacts and calendar stores concurrently (`App.tsx:391-396`), each of which issues 1-3 requests, so Stalwart's default ceiling of 4 is hit in ordinary use; the folder tree is preserved (`src/stores/email-store.ts:604-612`) but the refresh is dropped.
  - Fix hint: port `isConcurrentRequestRefusal` and the retry loop into `JMAPClient.request()`; read the body text before deciding.

- [x] **No transient-network retry** — `P2` — `missing` — fixed in 0b1c240
  - What WEB does: retries once after 1 s on a fetch `TypeError` unless already reconnecting or timed out (`lib/jmap/client.ts:836-846`).
  - What RN does: `request()` propagates the raw `TypeError("Network request failed")` (`src/api/jmap-client.ts:427`); `isTransientNetworkError` recognises it (`src/lib/network-error.ts:48-63`) but only the outbox uses that.
  - Fix hint: single retry for GET/idempotent bodies in `request()`; keep non-idempotent (`EmailSubmission/set`) un-retried.

- [x] **429 handling: no rate-limit state, no pause of live updates, HTTP-date `Retry-After` becomes NaN** — `P2` — `partial` — fixed in 0b1c240 (rate-limit window + `onRateLimit`; SSE/polling pause via the window check in `request()`)
  - What WEB does: `setRateLimited` blocks all requests until the window ends, tears down and re-arms push, notifies UI via `onRateLimit` and a throttled toast event; `parseRetryAfter` handles seconds and HTTP-date, caps at 5 min, defaults 60 s (`lib/jmap/client.ts:820-826`, `848-852`, `7421-7486`; `stores/auth-store.ts:208-226`).
  - What RN does: throws `RateLimitError(ms)` (`src/api/jmap-client.ts:436-440`) where `parseInt` of an HTTP-date yields `NaN*1000`; nobody catches it (grep: only tests). SSE reconnect (5 s), polling (5 s), outbox flush and stores keep hammering the server during the window.
  - Fix hint: add `rateLimitedUntil` to the client, short-circuit `request()` while limited, close SSE/polling and re-arm after the window, expose to `OfflineBanner`.

- [x] **HTTP error body and cause not surfaced; JSON parse unguarded** — `P3` — `partial` — fixed in 0b1c240
  - What WEB does: error message includes status + first 200 chars of body, JSON parse failure mapped to a clear error (`lib/jmap/client.ts:1147-1156`; changelog "Surface the underlying network error cause in passthrough failures").
  - What RN does: `JMAP request failed: ${status}` and `response.json()` unguarded (`src/api/jmap-client.ts:442-446`); `loadAccount` wraps into `NetworkError` but `request()` throws bare `TypeError`.
  - Fix hint: read text, include in message, wrap `JSON.parse`; throw `NetworkError` from `request()` too.

- [x] **Method-level `error` / `notUpdated` / `notDestroyed` unchecked in most RN API functions** — `P1` — `rn-only-bug` — fixed in ccbe67c (mail/identity/push; contacts, calendar, files done by their agents)
  - What WEB does: mutations inspect `notUpdated`/`notDestroyed` (`lib/jmap/client.ts:2282-2286` moveEmail; `3290-3345` sendEmail), reads check the method name before indexing (`1207-1208`).
  - What RN does: `res.methodResponses[0][1].list` / `.ids` indexed blindly in `getMailboxesWithState` (`src/api/email.ts:61-70`), `getEmails` (`322-327`), `getEmailsWithState` (`338-343`), `getThread` (`428-434`), `queryEmails` (`244-260`), `getIdentities` (`src/api/identity.ts:5-12`); `Email/set` mutations never look at the response: `setEmailKeywords` (`email.ts:436-445`), `moveEmail`/`moveEmails` (`447-480`), `deleteEmails` (`483-495`), `setKeywordsForEmails` (`527-539`), `restoreEmailMailboxes`/`setEmailMailboxes` (`541-575`), `destroyEmails` (`581-586`), `updateIdentity`/`deleteIdentity` (`identity.ts:27-45`). An `['error', {type:'forbidden'}]` response makes the read path throw a `TypeError` (classified transient by `network-error.ts:51`, see outbox finding) and makes the write path report success: the outbox removes the entry (`src/stores/outbox-store.ts:199-200`), the optimistic list/cache edit is never reverted.
  - Fix hint: add a shared `requireMethodResult(res, callId)` (like `resultFor` in `src/api/account-security.ts:59-67`) and an `assertSetResult(body, ids)` that throws on `notUpdated`/`notDestroyed`; use them in every `src/api/*.ts` function.

- [x] **`Email/get` and `Email/set` not split to `maxObjectsInGet`/`maxObjectsInSet`; no `getMaxObjectsInSet`** — `P2` — `bugfix-parity` — fixed in ccbe67c
  - What WEB does: `batched(ids, getMaxObjectsInGet())` for gets (`lib/jmap/client.ts:713-727`), `getMaxObjectsInSet()` for `batchMarkAsRead`, `batchDeleteEmails`, `batchMoveEmails`, `batchUpdateKeywords` (`1885-1894`, `2109-2136`, `1953-1961`, `4194-4197`; `lib/jmap/request-limits.ts`; changelog "Split requests to stay inside the server's advertised limits").
  - What RN does: `getEmailsWithState` (`src/api/email.ts:338-343`) is called from the incremental refresh with an unbounded `addedIds + updatedIds` list (`src/stores/email-store.ts:848-857`), `getMailboxesByIds` after `Mailbox/changes` is unbounded (`email.ts:114-127`, store `565-567`), `listScheduledEmails` fetches up to 200 ids in one get (`email.ts:922-928`); `setKeywordsForEmails`, `moveEmails`, `restoreEmailMailboxes`, `destroyEmails`, `archiveEmails` put every selected id into one `Email/set` (no `maxObjectsInSet` accessor exists in `jmap-client.ts`). Only `fetchEmailsChunked` (`email-store.ts:371-381`), `getEvents`/`getContacts` (`src/api/calendar.ts:214`, `contacts.ts:45`) and `offline-sync.ts:92` chunk. Over-limit requests fail whole, so a long offline gap (many updated ids) breaks the incremental refresh until the snapshot is dropped.
  - Fix hint: add `getMaxObjectsInSet()` + a `batched()` helper to `jmap-client.ts`; apply in the listed functions.

- [x] **`maxSizeUpload` / `maxSizeRequest` ignored** — `P3` — `missing` — fixed in 0b1c240 (accessors; enforced by the files/composer agents)
  - What WEB does: `getMaxSizeUpload()` (`lib/jmap/client.ts:4179-4182`) gates attachment/file uploads with a clear message (changelog 1.6.x "Use dynamic server-configured maximum upload sizes"; "maxSizeRequest").
  - What RN does: no reference to `maxSizeUpload` anywhere (`grep -rn maxSizeUpload src` empty); `uploadBlob` (`src/api/blob.ts:5-62`) surfaces an opaque `Upload failed: 413`.
  - Fix hint: expose `getMaxSizeUpload()` and check before `File(uri).bytes()` in `blob.ts`/ComposeScreen.

- [x] **Relative session URLs are not resolved (37f830da)** — `P2` — `bugfix-parity` — fixed in 0b1c240 (unified-inbox.ts with the mail-list agent)
  - What WEB does: `rewriteSessionUrl` rebases both absolute and relative (`/jmap/`) `apiUrl`/`downloadUrl`/`uploadUrl`/`eventSourceUrl` onto the login origin without touching `{accountId}` templates (`lib/jmap/client.ts:1091-1114`; changelog 1.9.x "Resolve relative session URLs without corrupting URI templates").
  - What RN does: `rewriteSessionUrls` only rewrites when `extractOrigin(url)` matches `^https?://` (`src/api/jmap-client.ts:320-340`); a relative `apiUrl` is returned unchanged and `fetch('/jmap/')` then fails with "Network request failed". Same gap in `src/api/unified-inbox.ts:55-60`. (RN correctly avoids `new URL()` so templates are not corrupted.)
  - Fix hint: in `rewrite()`, when `extractOrigin` is null and the string starts with `/`, return `serverOrigin + url`.

- [x] **Capability check uses the broad `principals` URN, not `principals:owner` (44360024)** — `P2` — `bugfix-parity` — fixed in a0ce925; since Stalwart advertises `principals:owner` nowhere, that also hid sharing, so since caea3d0 the sharing UI is gated on `principals` and `principals:owner` only goes into `using` when advertised
  - What WEB does: declares `urn:ietf:params:jmap:principals:owner` in `using` only when that exact capability is advertised in session or account capabilities (`lib/jmap/client.ts:4689-4698`, `6472`; changelog "Check the specific capability a request declares (principals:owner), not a broader one").
  - What RN does: `supportsSharing()` checks `CAPABILITIES.PRINCIPALS` (`src/api/files.ts:23-25`) and then pushes `PRINCIPALS_OWNER` into `using` (`files.ts:40-43`). A server advertising `principals` but not `principals:owner` rejects every FileNode request with `unknownCapability`.
  - Fix hint: check `hasCapability(CAPABILITIES.PRINCIPALS_OWNER) || accountCapabilities[...]` before adding it.

- [x] **PatchObject pointer keys not JSON-Pointer escaped (5c484af1)** — `P3` — `bugfix-parity` — fixed in ccbe67c
  - What WEB does: `keywordPointer()`/`pointerToken()` escape `~` and `/` (`lib/jmap/patch-pointer.ts:39-55`); mailbox moves use a whole-map replacement (`lib/jmap/client.ts:66-74`).
  - What RN does: `moveEmail`/`moveEmails` build `mailboxIds/${id}` pointers unescaped (`src/api/email.ts:456-457`, `473-474`). Stalwart ids never contain `/`, so exposure is limited to non-Stalwart servers; keywords are always sent as a whole map (`email.ts:436-445`), so tag names with `/` are safe. (Since 5041897 keywords are sent as `keywords/<name>` pointers too, escaped by `keywordPointer` in `src/api/patch-pointer.ts`.)
  - Fix hint: add `pointerToken()` or switch `moveEmail(s)` to the full `mailboxIds` replacement RN already uses in `restoreEmailMailboxes`.

- [x] **Send: message created directly in Sent instead of Drafts + `onSuccessUpdateEmail` (#188)** — `P2` — `bugfix-parity` — fixed in ccbe67c
  - What WEB does: creates in Drafts with `$draft`, submits, and moves to Sent via `onSuccessUpdateEmail` (full `mailboxIds` replacement, `keywords/$draft: null`) so the SMTP send happens before the message lands in Sent; needed for servers that encrypt on append (`lib/jmap/client.ts:3186-3190`, `3231-3238`, `3272-3287`; changelog "File the post-send message with a full mailboxIds replacement").
  - What RN does: `emailCreate.mailboxIds = { [sentMailboxId]: true }`, `keywords: { $seen: true }`, no `onSuccessUpdateEmail` (`src/api/email.ts:786-793`, `836-846`). With Stalwart encryption-at-rest + `encryptOnAppend` the copy is encrypted before `EmailSubmission/set` reads it; and if the submission fails, a never-sent copy sits in Sent.
  - Fix hint: mirror WEB: create in Drafts (needs the drafts mailbox id), `onSuccessUpdateEmail: { '#draft': { mailboxIds: {sent: true}, 'keywords/$draft': null } }`, and report `notUpdated` as a filing warning.

- [x] **Message-ID / In-Reply-To handling diverges from WEB** — `P3` — `bugfix-parity` — fixed in ccbe67c
  - What WEB does: generates `messageId` client-side from the sender domain, strips angle brackets from `inReplyTo`/`references` and sends them as JMAP arrays (`lib/jmap/client.ts:546-570`, `3177-3180`, `3186-3188`; changelog "Generate the Message-ID client-side using the sender's domain").
  - What RN does: relies on the server for Message-ID; uses raw `header:In-Reply-To:asText` / `header:References:asText` strings (`src/api/email.ts:823-826`).
  - Fix hint: port `generateMessageId` + `stripMessageIdBrackets`, use `inReplyTo`/`references` arrays.

- [x] **Dead duplicate `src/api/submission.ts` with zero error checking** — `P3` — `rn-only-bug` — fixed in 42ab246
  - What RN does: `submission.ts:140-199` is an older `sendEmail` that ignores `notCreated`/errors; no importers (`grep api/submission` empty). Risk is someone wiring it back in.
  - Fix hint: delete the file.

- [x] **No keep-alive ping / connection-lost signalling / session refresh** — `P2` — `missing` — fixed in edc26ce
  - What WEB does: `Core/echo` every 30 s with exponential skip back-off, `reconnect()` on failure, `onConnectionChange` drives the "connection lost" banner and per-account `isConnected` (`lib/jmap/client.ts:1010-1075`; `stores/auth-store.ts:199-206`); basic-auth 401 re-fetches the session and re-prompts TOTP (`client.ts:862-897`).
  - What RN does: no ping (`grep Core/echo src` empty); connectivity comes only from NetInfo (`src/stores/network-store.ts`), so a reachable-but-down server never surfaces, and the session document (capabilities, shared accounts, `eventSourceUrl`) is never re-fetched until restart. A basic-auth 401 throws `AuthenticationError` straight away (`src/api/jmap-client.ts:432-434`).
  - Fix hint: add a 30 s `Core/echo` while foregrounded (see AppState finding) feeding `network-store.online`/`account-store.isConnected`; on 401 for basic auth re-fetch the session once before failing.

- [x] **Password change leaves the stored credential stale, then evicts the account** — `P1` — `rn-only-bug` — fixed in 032732c
  - What WEB does: (same class of exposure via cookie, but the server-side passthrough re-reads; out of scope). `stores/account-security-store.ts:503-526`.
  - What RN does: `changePassword` succeeds (`src/api/account-security.ts:185-197`, `src/components/settings/AccountSecuritySettings.tsx:137-141`) but `JMAPClient.credentials.password` and the SecureStore entry keep the old password. The next request gets 401 -> `AuthenticationError`; on the next launch `restoreSession` clears credentials and removes the account (`src/stores/auth-store.ts:516-523`), and `retrySession` does the same (`571-587`). Push background task also starts failing.
  - Fix hint: add `jmapClient.updatePassword(newPassword)` that rewrites `credentials` and persists via `setStoredCredentials`; call it after a successful `changePassword` (and after TOTP enable/disable if the password format changes).

- [x] **First-touch serialisation for Calendar/Contacts (#907)** — `P3` — `bugfix-parity` — fixed in 0b1c240
  - What WEB does: `FirstTouchGate` holds later Calendar*/AddressBook*/ContactCard* requests per account until the first one settles, so clustered Stalwart doesn't create two default calendars (`lib/jmap/first-touch-gate.ts`, `lib/jmap/client.ts:1121-1128`).
  - What RN does: `refetchFeatureStores` fires `fetchContacts`, `fetchCalendars`, `refresh` concurrently on every login/restore/switch (`src/stores/auth-store.ts:81-99`).
  - Fix hint: port `first-touch-gate.ts` and wrap `request()`; reset it in `reset()`/`loadAccount`.

- [x] **Mailbox fetch not retried on first login (lazy provisioning, #217)** — `P3` — `bugfix-parity` — fixed in 3194b5e
  - What WEB does: retries the initial mailbox fetch when a freshly created account returns no folders (changelog 1.6.x "Retry mailbox fetch on first login to handle lazy provisioning (#217)").
  - What RN does: `fetchMailboxes` does one `Mailbox/get`; an empty list on a brand-new Stalwart account stays empty until pull-to-refresh (`src/stores/email-store.ts:584-588`).
  - Fix hint: if the list is empty and there is no `inbox` role, retry after ~1 s up to 3 times.

- [x] **Session redirect with dropped Authorization not handled** — `P3` — `partial` — fixed in 0b1c240; the check keyed on `response.redirected`, which React Native's fetch never sets, so it only works since 859770b (audit B15)
  - What WEB does: detects `response.redirected` + empty accounts/username and refetches the final URL with the header (`lib/jmap/client.ts:911-925`).
  - What RN does: `fetchSession` accepts whatever comes back; `resolveAccountId` then throws "No account found in JMAP session" (`src/api/jmap-client.ts:363-401`). iOS strips Authorization on cross-origin redirects.
  - Fix hint: same detection; retry against `response.url`.

### Live updates (SSE / polling / state changes)

- [x] **No `AppState` handling: SSE never paused in background nor recovered on foreground; no refresh on resume** — `P1` — `missing` — fixed in edc26ce
  - What WEB does: `visibilitychange` -> immediate `checkForStateChanges()` + `recycleStaleSSE()`; `online` -> reconnect SSE or poll; polls pause while hidden; 90 s ping-timeout monitor (`lib/jmap/client.ts:7332-7400`, `6992-6996`; changelog #702/#781 notes).
  - What RN does: `grep -rn AppState src App.tsx` is empty. The EventSource is opened once (`App.tsx:380-418`, `src/api/push.ts:120-157`). `react-native-sse` re-polls only when the XHR reaches DONE with a status (`node_modules/react-native-sse/src/EventSource.js:118-131`); on `onerror`/status 0 (socket dropped, iOS suspension, Wi-Fi to cellular) nothing schedules a reconnect (`137-149`). Result: after the first network blip, push is dead for the rest of the process lifetime with no visible sign; the app also keeps the socket (and 30 s server pings) alive while backgrounded.
  - Fix hint: `AppState.addEventListener('change')`: on `background` close the EventSource; on `active` recreate it and call `fetchMailboxes()`/`refreshEmails()`/outbox `flush()`; also subscribe to `useNetworkStore` `online` transitions to recreate. Listen for the SSE `error` event and schedule a reconnect with back-off.

- [x] **SSE Authorization header captured once; stale after OAuth token refresh** — `P1` — `rn-only-bug` — fixed in edc26ce
  - What WEB does: `authenticatedFetch` reads `this.authHeader` on every (re)connect, and `onTokenRefresh` retries a 401 SSE connect (`lib/jmap/client.ts:7049-7053`, `855-863`).
  - What RN does: `connectEventSource` passes `{ headers: { Authorization: jmapClient.authHeader } }` at construction (`src/api/push.ts:136-138`); `react-native-sse` reuses `this.headers` on every reconnect (`EventSource.js:83-87`). After the access token expires (`ensureFreshToken` rotates it for normal requests) every SSE reconnect sends the old Bearer -> 401 -> `error` -> re-poll every 5 s forever (battery drain, server log spam, no push).
  - Fix hint: on `error` with `xhrStatus === 401` close and recreate with the current `authHeader`; better, recreate the EventSource whenever `persistRefreshedTokens` runs.

- [x] **Push effect keyed on the singleton `client`: SSE stays bound to the previous account after `switchAccount`** — `P1` — `rn-only-bug` — fixed in edc26ce
  - What WEB does: per-account clients; the push effect depends on `activeAccountId` and the connected-accounts signature, tearing down and re-creating streams on switch (`components/mail/mail-app.tsx:1220-1263`).
  - What RN does: the effect deps are `[client, isAuthenticated]` (`App.tsx:418`); `client` is always the same `jmapClient` object (`src/stores/auth-store.ts:155`), and `isAuthenticated` stays true across `switchAccount` (`auth-store.ts:360-432`), so the effect never re-runs. The open EventSource keeps the old account's `eventSourceUrl` + credentials; its events are then dropped by `jmapClientServesActiveAccount` (`src/stores/email-store.ts:986`), and the new account gets no live updates until logout/login. The FCM setup effect already includes `activeAccountId` (`App.tsx:378`).
  - Fix hint: add `activeAccountId` (and `haveLiveSession`) to the push effect deps.

- [x] **No SSE failure/fallback path (server 4xx/5xx, proxy without SSE, client cert)** — `P2` — `partial` — fixed in edc26ce
  - What WEB does: non-OK SSE response -> `fallbackToPolling`; stream end -> reconnect after 3 s (rate-limit aware); `closeafter/ping` template substitution (`lib/jmap/client.ts:7049-7066`, `7129-7155`).
  - What RN does: `startPolling` is used only when `eventSourceUrl` is absent (`src/api/push.ts:228-230`); no `error`/`open` listeners on the EventSource. A user with a TLS client certificate (native issue #3) is worst hit: `react-native-sse` is XHR-based and cannot present the KeyChain cert (`src/lib/client-cert.ts:40-43` explains why `fetchSecure` exists), so the SSE handshake is rejected and no polling starts -> no live updates at all.
  - Fix hint: in `connectEventSource`, if `await getClientCertAlias()` is non-null skip SSE and return `startPolling(...)`; add an `error` handler that, after N consecutive non-401 failures, closes the source and falls back to polling.

- [x] **StateChange coverage: EmailSubmission, SieveScript, Identity, VacationResponse, FileNode ignored** — `P2` — `partial` — fixed in a071d05 (Sieve/vacation refetch; EmailSubmission/FileNode via `state-change-bus`)
  - What WEB does: handles `Email`, `EmailSubmission` (scheduled list/metadata), `Mailbox` (any account), `Calendar`/`CalendarEvent` (+tasks), `SieveScript` (filters) (`stores/email-store.ts:3242-3310`).
  - What RN does: `Email`/`EmailDelivery`/`Mailbox` (`src/stores/email-store.ts:981-1020`), `AddressBook`/`ContactCard`/`Contact` (`src/stores/contacts-store.ts:152-168`), `Calendar`/`CalendarEvent` incl. shared accounts (`src/stores/calendar-store.ts:261-283`). `ScheduledScreen`, `filter-store`, `vacation-store`, Files and Identity never refresh on push (`grep handleStateChange src/stores/filter-store.ts src/stores/vacation-store.ts` empty).
  - Fix hint: add `EmailSubmission` -> scheduled list refresh (when the Scheduled screen is mounted), `SieveScript` -> `filter-store.fetch`, `VacationResponse` -> vacation store, `FileNode` -> Files screen refresh; dispatch from the `onStateChange` fan-out in `App.tsx:391-396`.

- [x] **Contacts state changes ignore shared/group accounts** — `P3` — `partial` — done in 26a34d5 (`handleStateChange` walks `getContactCapableAccountIds()`)
  - What WEB does: per-account clients; `handleStateChange` reacts to the client's own account (`stores/email-store.ts:3255-3257`); calendar/contacts stores use the account of the shared collection.
  - What RN does: `contacts-store.handleStateChange` only reads `change.changed[jmapClient.accountId]` (`src/stores/contacts-store.ts:154-156`) although address books from shared accounts are shown; `calendar-store` already folds shared accounts in (`calendar-store.ts:263-272`).
  - Fix hint: mirror the calendar store's `known` set using `addressBook.accountId`.

- [x] **Polling fallback is coarse: primary account only, fixed 5 s, no in-flight coalescing, no pause in background** — `P3` — `partial` — fixed in edc26ce
  - What WEB does: polls every session account plus Calendar/CalendarEvent/SieveScript, 3 s active / 20 s slow, skips when `document.hidden`, coalesces overlapping polls (#781) (`lib/jmap/client.ts:6948-6954`, `7157-7301`).
  - What RN does: `startPolling` polls `Mailbox/get` + `Email/get` for the primary account every 5 s with `setInterval`, no in-flight guard, never paused (`src/api/push.ts:163-202`); shared accounts, calendar, contacts and sieve never change under polling.
  - Fix hint: reuse the WEB request shape (`mbx:<id>`/`eml:<id>` call ids), add an in-flight flag and AppState pause, 20 s cadence in fallback.

- [x] **SSE stream keeps the whole response in memory; no periodic recycle** — `P3` — `rn-only-bug` — fixed in edc26ce
  - What WEB does: reads the body as a stream and discards processed chunks; recycles a silent stream after 90 s (`lib/jmap/client.ts:7070-7105`, `7332-7373`).
  - What RN does: `react-native-sse` accumulates `xhr.responseText` for the life of the connection (`EventSource.js:108`, `_lastIndexProcessed`), and RN requests `{ping}=30`, `{closeafter}=no` (`src/api/push.ts:126-129`), so memory grows for every ping/event until reconnect. No ping-timeout detection either.
  - Fix hint: either request `closeafter=state` (server closes after each event; library auto-reconnects) or recycle the EventSource every ~30 min / when no `ping` event arrived in 90 s (add a `ping` listener).

- [x] **Push subscription `types` include `Email` and `Mailbox`; no `emailPush` spam filter** — `P2` — `partial` — fixed in 00faceb; the `emailPush` map was refused for ACL-shared mailboxes and never read back until d8046a8 and ccaa24e (audit B18)
  - What WEB does: subscribes to `EmailDelivery` only, plus an `emailPush` filter excluding `$junk`/Junk when the server advertises `urn:ietf:params:jmap:emailpush` (`lib/web-push.ts:39-52`, `lib/jmap/client.ts:8085-8142`; changelog 1.9.x "Stop sending notifications for spam").
  - What RN does: `PUSH_TYPES = ['Email', 'EmailDelivery', 'Mailbox']` (`src/lib/push-notifications.ts:104`); `createPushSubscription` has no `emailPush` support (`src/api/push.ts:23-57`). Every read/flag/move on any device wakes the relay -> FCM -> headless task, which then re-queries the inbox (`src/lib/push-background-task.ts:452-455`); a spam delivery still triggers a push (only the inbox `notKeyword $seen` query hides it, at the cost of a wake-up).
  - Fix hint: subscribe to `EmailDelivery` only; add `hasEmailPushCapability()` + `emailPush` filter as in WEB; the relay must forward it (see memory note: relay lacks EmailPush).

- [x] **Headless push task re-binds the singleton client while the UI may be running** — fixed in 1f2df5f — `P2` — `rn-only-bug`
  - What WEB does: N/A (service worker has its own fetch path).
  - What RN does: `processAccountForPush` calls `jmapClient.loadAccount(accountId)` for each candidate account (`src/lib/push-background-task.ts:445`) and the `finally` re-loads the active one (`438-440`, errors swallowed). HeadlessJS tasks run inside the live RN instance when the app is foregrounded, so UI requests issued during that window are sent with another account's credentials/session, and a failing final `loadAccount` leaves `session = null` (`jmap-client.ts:269-270`) until the next network event.
  - Fix hint: use a detached fetch path like `src/api/unified-inbox.ts:116-131` (credentials read from SecureStore, own `apiUrl`) instead of mutating the singleton.

### Offline cache & outbox

- [x] **Outbox retries forever on errors that look transient but are permanent** — `P2` — `rn-only-bug` — fixed in 0205aa0
  - What RN does: `isTransientNetworkError` treats any `TypeError` and messages containing `session expired`/`not connected` as transient (`src/lib/network-error.ts:48-63`). (a) A JMAP method error makes the unchecked read path throw `TypeError: Cannot read property 'list' of undefined` (see method-error finding) -> transient -> `recordError(..., false)` never increments `attempts` (`src/stores/outbox-store.ts:203-206`, `243-254`) -> the queue is wedged on that entry until reinstall. (b) `AuthenticationError('Session expired')` from a revoked password is also transient -> same wedge. WEB has no outbox (N/A) but never mis-classifies auth errors as transient.
  - Fix hint: classify by error class (`NetworkError`, `RequestTimeoutError`, `RateLimitError`) not by `TypeError`/message; treat `AuthenticationError` as terminal and pause the queue.

- [x] **Permanently failed outbox ops are dropped silently; optimistic state never reverted** — `P2` — `rn-only-bug` — fixed in 0205aa0
  - What RN does: after 5 attempts the entry is removed with `console.warn` (`src/stores/outbox-store.ts:210-216`); the list/cache was already patched optimistically (`offline-cache-store.patch`, email-store mutations) and nothing refetches, so the UI shows a move/flag the server rejected until the next full refresh; `OfflineBanner` only shows the count.
  - Fix hint: keep a `failed: OutboxEntry[]` in the store, surface it in `OfflineBanner`/AboutDataSettings, and trigger `refreshEmails()` for the affected mailbox when an op is dropped.

- [x] **Interrupted flush is not resumed until the next online transition or launch** — `P3` — `rn-only-bug` — fixed in 0205aa0
  - What RN does: `flush()` breaks on the first transient error (`src/stores/outbox-store.ts:203-206`); the only triggers are `haveLiveSession` and NetInfo `online` flips (`App.tsx:289-295`). A blip that NetInfo never reports (server hiccup) leaves the queue idle.
  - Fix hint: schedule a retry with back-off after a transient break; also flush on AppState `active`.

- [x] **Offline `onlineRun` fallback silently changes semantics (archive auto-foldering)** — `P3` — `rn-only-bug` — fixed in 0205aa0
  - What RN does: `applyOrQueueBatch` runs the richer `onlineRun` (e.g. year/month archive foldering) and on transient failure re-queues the plain `mailboxes` primitives (`src/stores/outbox-store.ts:279-292`), so the replay lands in the top-level Archive without the year/month folder the user configured.
  - Fix hint: encode the folder creation into the queued op (or queue an `archive` op kind that re-runs the foldering logic on replay).

- [x] **`Email/changes.hasMoreChanges` ignored in the incremental refresh** — `P3` — `partial` — fixed in f07e039
  - What WEB does: WEB refetches the page instead of diffing, so it is not exposed.
  - What RN does: `getEmailChanges` returns `hasMoreChanges` (`src/api/email.ts:355-376`) but `refreshEmails` uses `updated`/`destroyed` once (`src/stores/email-store.ts:836-846`); after a long offline gap the truncated lists leave stale keywords on some rows until the snapshot is invalidated. (The mailbox path does drain, `email-store.ts:575-579`, `601`.)
  - Fix hint: loop while `hasMoreChanges`, or drop the snapshot and fall back to the full re-query when it is set.

- [x] **Offline cache + outbox land in Android auto-backup** — `P2` — `missing` (security) — fixed in 7f9f5af
  - What WEB does: N/A (no persistent mail cache).
  - What RN does: `android:allowBackup="true"` with `@xml/secure_store_backup_rules` from the expo-secure-store plugin, which only excludes SecureStore's own prefs (`android/app/src/main/AndroidManifest.xml:16`); the AsyncStorage SQLite DB (full cached bodies `webmail:offline-cache:entry:v2:*`, outbox, settings, account registry) is backed up to the user's Google account.
  - Fix hint: add an app-owned `fullBackupContent`/`dataExtractionRules` excluding `databases/RKStorage` (AsyncStorage) or set `allowBackup=false` via an Expo config plugin.

- [ ] **Send has no offline path and no draft fallback** — `P2` — `missing` — partly: drafts autosave to the server since 5b72c4d, and since 92b42e4 the close dialog no longer drops the text when the draft can't be saved; an offline send is still not queued, and a draft can't be saved offline
  - What WEB does: no offline queue either, but send failures leave the composer open with the draft autosaved (composer agent's area); send itself has a deadline (#702).
  - What RN does: `ComposeScreen` shows `Alert('Send failed')` and keeps the modal (`src/screens/ComposeScreen.tsx:975-979`); there is no draft API in `src/api/email.ts` (`grep -n '[Dd]raft' src/api/email.ts` only finds the send create id), so the body is lost if the user leaves, and an offline send is not queued although the outbox exists.
  - Fix hint: either add an `outbox` `send` op kind (blob uploads must already be done) or at minimum persist the composer state locally on failure.

### Security hardening (RN)

- [x] **`Linking.openURL` with unvalidated URIs from server data (contacts, calendar invitations)** — `P2` — `rn-only-bug` — fixed in 96272b6 (contacts 63bf392, calendar/invitation links confirm the host)
  - What WEB does: links are sanitized in the viewer; iCal/vCard URLs open via anchor with `rel=noopener` (viewer agent's area); `isValidUnsubscribeUrl` gates unsubscribe links (`components/email/unsubscribe-banner.tsx:63`).
  - What RN does: `openUrl(uri)` on a contact's stored URL (`src/screens/ContactDetailScreen.tsx:173-175`) and `Linking.openURL(videoUri)` on `virtualLocations[0].uri` from an incoming invitation (`src/components/calendar/EventDetailSheet.tsx:169`, `234`; `src/components/email/CalendarInvitationBanner.tsx:92`, `159`) accept any scheme: `intent://...#Intent;component=...;end` launches arbitrary exported activities on Android, `file://`, `content://`, or third-party deep links. EmailBodyView already restricts to `https?|mailto|tel|sms` (`src/components/EmailBodyView.tsx:715-723`).
  - Fix hint: a shared `openExternalUrl()` that allows only `https?:`, `mailto:`, `tel:`, `sms:` and shows the host in a confirmation for invitation links.

- [x] **Password handoff over a custom-scheme redirect (`bulwarkmobile://…#password=`) is interceptable; OAuth `state` uses `Math.random`** — `P1` — `rn-only-bug` — fixed in 2c0dbd1 (CSPRNG state + endpoint validation; moving the password out of the fragment is a webmail change)
  - What WEB does: the mobile handoff page redirects with credentials in the fragment (`lib/deep-link-handoff.ts`, changelog "Mobile handoff page with JMAP authentication verification").
  - What RN does: the `password` flow returns the clear-text password in the redirect fragment (`src/lib/oauth.ts:92-99`); the scheme is a plain `intent-filter` (`AndroidManifest.xml:25-30`), which any installed app can also register (no App Links verification), so a malicious app can receive the redirect. `state` is 16 bytes of `Math.random` (`oauth.ts:41-47`) - it prevents a forged callback from being *accepted* only if unpredictable; and the fragment's `server_url`, `token_endpoint`, `client_id` are trusted as-is (`oauth.ts:101-121`), so a forged callback can point refresh traffic at an attacker host.
  - Fix hint: never send the password in the redirect (mint short-lived tokens or a one-time pairing code like `redeemPairingCode`, `oauth.ts:165-208`); generate `state` with `expo-crypto` `getRandomBytes`; validate `server_url`/`token_endpoint` are https and the token endpoint host matches the server host.

- [x] **`http://` server URLs accepted without a warning; cleartext then fails opaquely** — `P2` — `missing` — fixed in ce97232
  - What WEB does: warns when the JMAP URL points at a local-only host (changelog "Setup: Warn when the JMAP URL points at a local-only host"); Basic auth travels server-to-server.
  - What RN does: `normalizeServerInput` accepts `http` (`src/lib/server-discovery.ts:28-30`), QR payloads accept `http` (`src/lib/oauth.ts:144`, `155`), `connect()` never checks the scheme. Android has no `usesCleartextTraffic` (`app.config.js` has no `android.usesCleartextTraffic`; manifest has none) so http fails with "Network request failed" on API 28+, while iOS ATS may or may not allow it, so the user gets an unexplained error - or, worse, Basic credentials in clear on iOS.
  - Fix hint: reject `http://` in `normalizeServerInput` except `localhost`/RFC-1918 in dev builds, with a clear message.

- [x] **Weak randomness for TOTP secret / UUIDs (falls back to `Math.random`)** — `P2` — `rn-only-bug` — fixed in 2c0dbd1
  - What WEB does: server-side `otpauth` `Secret({size:20})` from Node crypto; `generateUUID()` guarded (changelog "Replace unguarded crypto.randomUUID() with safe generateUUID()").
  - What RN does: `randomBytes` tries `crypto.getRandomValues`, then `crypto.randomUUID`, then `Math.random` (`src/lib/totp.ts:404-437`). `expo-crypto` is not a dependency (`package.json`), Hermes exposes no `crypto` global by default, so a long-lived 2FA secret is minted from `Math.random`; the same fallback is documented for `lib/uuid.ts` and `lib/oauth.ts`.
  - Fix hint: add `expo-crypto` and use `Crypto.getRandomBytes(20)` / `Crypto.randomUUID()`; remove the Math.random branches.

- [x] **Client-cert native fetch follows redirects with Authorization and turns POST into GET (#627 class)** — `P3` — `bugfix-parity` — fixed in 6f747db
  - What WEB does: `postJmap` follows redirects manually, keeps POST, only to the same host or an https upgrade (`lib/stalwart/jmap-api.ts:44-93`).
  - What RN does: `instanceFollowRedirects = true` on `HttpURLConnection` (`android/app/src/main/java/com/anonymous/bulwarkmobile/BulwarkClientCertModule.kt:144`); a 301 in front of `/jmap/` re-issues as GET (Stalwart answers 404 problem+json) and cross-host redirects re-send the header. The non-cert `fetch` path has the same POST->GET behaviour but that matches browser semantics WEB also lives with client-side.
  - Fix hint: `instanceFollowRedirects = false`, return the 3xx to JS, and handle the redirect in `secureFetch` with the same host/https-upgrade rule.

- [x] **Client-cert path buffers whole bodies through base64 over the bridge with a 30 s cap** — `P3` — `rn-only-bug` — fixed in 6f747db (blob deadline raised to 300 s; streaming still deferred)
  - What RN does: the whole response is read into memory and base64-encoded (`BulwarkClientCertModule.kt:170-190`, `src/lib/client-cert.ts:204-216`); attachment downloads for cert users go through `secureFetch(...).arrayBuffer()` (`src/lib/email-export.ts:100-110`) and uploads through `bodyToBase64` (`client-cert.ts:171-188`), so a 50 MB attachment costs ~200 MB of JS heap and can time out at 30 s (`client-cert.ts:250`; WEB uses 300 s for transfers, `lib/jmap/client.ts:634`).
  - Fix hint: stream to a file in the native module (`FileOutputStream`) and return the path; raise the transfer timeout.

- [x] **Blob downloads via `File.downloadFileAsync` bypass token refresh** — `P2` — `rn-only-bug` — fixed in d2ed27f
  - What WEB does: `fetchBlob` goes through `authenticatedFetch`, which refreshes a Bearer token on 401 (`lib/jmap/client.ts:4150-4157`, `855-863`).
  - What RN does: `downloadInto` builds the header from `jmapClient.authHeader` without `ensureFreshToken()` and does not retry on 401 (`src/lib/email-export.ts:93-97`); after the access token expires, attachment/EML download fails until some other JMAP call has refreshed the token. `fetchBlobArrayBuffer` does refresh (`src/api/jmap-client.ts:575-581`).
  - Fix hint: expose `ensureFreshToken()` publicly, call it before `downloadFileAsync`, and on 401 call `forceRefreshToken()` and retry once.

- [x] **Downloaded attachment temp files are never cleaned up** — `P3` — `rn-only-bug` — fixed in d2ed27f (launch sweep wired in App.tsx)
  - What RN does: `shareAttachment`/`openAttachment` write into `Paths.cache` (`src/lib/email-export.ts:127`, `195`) and only delete when the same name is reused; the APK installer deletes on failure (`src/lib/install-update.ts:78`, `143`). Cache may be purged by the OS but shared files linger (readable to apps that were granted the URI).
  - Fix hint: delete the file after the share sheet resolves, and sweep `Paths.cache` older than a day at launch.

- [x] **WebView: `data:` navigations allowed inside the message frame** — `P3` — `partial` — fixed in 06742ef
  - What WEB does: message HTML is sandboxed in an `srcDoc` iframe with a CSP meta tag (changelog 1.5.x); `data:` top-level navigation is blocked by the browser.
  - What RN does: `onShouldStartLoadWithRequest` returns `true` for any `data:` URL (`src/components/EmailBodyView.tsx:715-718`), so `<a href="data:text/html,...">` replaces the message with attacker HTML rendered inside the app chrome (phishing form); the WebView is otherwise well hardened (`originWhitelist=['about:blank']`, file access off, `mixedContentMode="never"`, `setSupportMultipleWindows={false}`, `incognito`, `domStorageEnabled={false}`, `EmailBodyView.tsx:675-712`).
  - Fix hint: allow `data:` only for `request.isTopFrame === false` or block it entirely (the body is loaded via `source={{html}}`, not a data: URL).

- [ ] **No screenshot / recent-apps protection option** — `P3` — `missing`
  - What WEB does: N/A.
  - What RN does: no `FLAG_SECURE`/`expo-screen-capture` anywhere; mail content appears in the Android recents thumbnail.
  - Fix hint: optional "Hide content in app switcher" setting using `expo-screen-capture` `preventScreenCaptureAsync`.

- [x] **Sender/subject of every FCM message logged to logcat** — fixed in 00faceb — `P3` — `rn-only-bug`
  - What RN does: `console.log('[push] fcm message', payload.title)` in production (`App.tsx:301-303`). No credential logging found (grep for password/token/secret in console calls is empty).
  - Fix hint: drop or guard with `__DEV__`.

- [x] **Custom SHA-256 implementation (verified correct) could use `expo-crypto`** — `P3` — `rn-only-bug` — fixed in n/a (kept: PKCE needs a synchronous digest; expo-crypto digest is async)
  - What RN does: `src/lib/sha256.ts` is a straight FIPS 180-4 implementation (padding, 64-bit length split, unsigned hex output all correct) used only for APK checksum verification (`src/lib/install-update.ts:118-127`); verification is opt-in when the release body carries a hash.
  - Fix hint: once `expo-crypto` is added (see randomness finding) replace with `Crypto.digest('SHA-256', bytes)`; keep the size check.

- [x] **TOTP helper: RFC 6238 compatible; issuer hard-coded** — `P3` — `partial` — fixed in ce97232
  - What WEB does: server-verified via `x:AccountPassword/set otpAuth.otpCode`; enrolment via `otpauth` with the app/brand as issuer.
  - What RN does: `generateTotpEnrolment` produces `otpauth://totp/Stalwart:<label>?secret=…&algorithm=SHA1&digits=6&period=30` (`src/lib/totp.ts:469-485`) - correct parameters, base32 without padding correct; verification is server-side (comment `totp.ts:391-396`). Issuer `Stalwart` instead of the server host/brand.
  - Fix hint: use the server hostname (or configured brand) as issuer.

- [x] **Relay base URL stored unvalidated (http allowed)** — `P3` — `rn-only-bug` — fixed in f6f26f7
  - What RN does: `setStoredRelayBaseUrl` only trims slashes (`src/lib/push-notifications.ts:170-176`); the relay receives the FCM token and the JMAP push-subscription URL slot. WEB's telemetry/push endpoints are validated server-side against internal hosts (changelog "Block telemetry endpoint from pointing at internal/loopback hosts").
  - Fix hint: require `https://` in the settings input.

### Stalwart admin/self-service, S/MIME, encryption at rest

- [x] **Encryption at rest is read-only; no public-key management** — fixed in ddae1e6 — `P2` — `partial` — fixed in 69bedf0 (API; settings UI with the settings agent)
  - What WEB does: `fetchCryptoInfo`/`updateEncryptionAtRest` with `@type` (`Disabled|Aes128|Aes256`), `publicKey`, `encryptOnAppend`, `allowSpamTraining` (spam training before encryption) and `x:PublicKey/query|get|set` CRUD with `emailAddresses`/`expiresAt` (`stores/account-security-store.ts:355-448`, `625-700`; changelog 1.7.x "Manage S/MIME and PGP public keys and configure Stalwart encryption at rest", 1.9.x "Per-account isolation for encryption at rest").
  - What RN does: `fetchEncryptionType` returns only the `@type` (`src/api/account-security.ts:150-155`); shown read-only in `AccountSecuritySettings.tsx:595`. No `x:PublicKey/*`, no set path. Per-account isolation is inherent (single-session client uses `jmapClient.accountId`).
  - Fix hint: port `updateEncryptionAtRest`, `fetchPublicKeys`, `createPublicKey`, `removePublicKey` into `account-security.ts` (same `STALWART_USING`) and a key list/paste screen.

- [x] **S/MIME settings screen is a mock; no S/MIME detection in the viewer** — `P2` — `missing` — fixed in 06742ef (viewer banner; settings stub hidden in 3d0d440; crypto deferred)
  - What WEB does: built-in S/MIME was removed from core into the privileged crypto plugin (changelog 1.5.0 note, "S/MIME: The built-in S/MIME implementation has been removed from core"); core keeps only detection (`isSmimeEmail`, `lib/jmap/client.ts:484-505`), the range-limited blob read for signature checks (`7503-7550`), and the plugin hook surface. Per-account key isolation, legacy 3DES/PBE and self-signed detection live in the plugin.
  - What RN does: `SmimeSettings` renders `MOCK_KEYS`/`MOCK_CERTS` and three settings that nothing reads (`src/components/settings/SmimeSettings.tsx:32-61`; `src/stores/settings-store.ts:203-205`, `308-310`), reachable from Settings as `encryption` (`src/screens/SettingsScreen.tsx:130`). Nothing detects `application/pkcs7-mime`/`multipart/signed` bodies, so an encrypted message shows as an empty body with a `smime.p7m` attachment.
  - Fix hint: parity for RN *core* = (1) port `isSmimeEmail` and show a "signed/encrypted with S/MIME - not supported on mobile" banner, (2) remove or hide the mock section. Full sign/verify/decrypt needs WebCrypto, which Hermes lacks: it would require `react-native-quick-crypto` (OpenSSL) plus a PKCS#7/CMS parser (`pkijs` runs on WebCrypto and would need a shim), private keys in SecureStore/Keychain, and per-account isolation of the key store; there is no plugin tier in RN to host it. Treat as a separate project.

- [x] **Display name not refreshed from the Stalwart principal on login/restore/switch (#900)** — `P3` — `bugfix-parity` — fixed in b52768e
  - What WEB does: refreshes the account label from `x:Account/get` on login, restore and switch (changelog 1.9.x "#900"; memory note: principal name is copied into the Identity only once).
  - What RN does: `fetchPrincipal` exists (`src/api/account-security.ts:157-181`) but is only called from the security screen (`AccountSecuritySettings.tsx:595`); `addAccount` uses `displayName: username` (`src/stores/auth-store.ts:187-195`, `123-131`).
  - Fix hint: call `fetchPrincipal()` (guarded by `isStalwartSupported()`) after `applyConnectedState` and `updateAccount({displayName})`.

- [x] **Native issue #47 "Account security not accessible" - likely gating** — `P3` — `rn-only-bug` (unverified) — fixed in 032732c
  - What RN does: the screen hides password/TOTP for Bearer sessions (`src/api/jmap-client.ts:66-68`) and shows "not available" when `urn:stalwart:jmap` is absent (`src/api/account-security.ts:51-55`); an OAuth handoff login therefore has no password management even on Stalwart. WEB shows the same sections for OAuth users via the passthrough with stored basic credentials.
  - Fix hint: confirm against the issue; consider allowing app-password/API-key management for Bearer sessions (they only need `x:*` methods, not the password).

### Newsletter unsubscribe

- [x] **List-Unsubscribe not parsed or offered** — `P2` — `missing` — fixed in d2ed27f
  - What WEB does: `extractListHeaders` parses `List-Unsubscribe`/`List-Id`/`List-Help`/`List-Post` (`lib/email-headers.ts:253-300`); the banner opens http links in a new tab (no RFC 8058 one-click POST) and sends `mailto:` unsubscribes itself via JMAP (`components/email/unsubscribe-banner.tsx:63-110`; changelog 1.5.x "Send mailto: unsubscribe ourselves instead of via the OS handler").
  - What RN does: `EMAIL_FULL_PROPERTIES` requests no headers (`src/api/email.ts:11-15`); no parsing, no banner (`grep -rln unsubscribe src` hits only unrelated store code).
  - Fix hint: add `header:List-Unsubscribe:asText` and `header:List-Unsubscribe-Post:asText` to the full properties; port `parseUnsubscribeUrls`; for http+`List-Unsubscribe=One-Click` do the RFC 8058 POST (`application/x-www-form-urlencoded`, body `List-Unsubscribe=One-Click`) in-app, otherwise open the link; for `mailto:` reuse `sendEmail`.

### Misc network

- [x] **Unified inbox detached fetch: no timeout, no 429/`maxConcurrentRequests` handling, N parallel sessions** — `P3` — `partial` — fixed in 6ae21d5
  - What WEB does: per-account clients share the retry/timeout/rate-limit pipeline; unified fetch errors are collected per account (`stores/email-store.ts:3325-3345`).
  - What RN does: `jmapPost`/`fetchInboxForAccount` do a bare `secureFetch` per account and per shared account in parallel (`src/api/unified-inbox.ts:116-131`, `215-233`), swallowing shared-account errors and only mapping 401 to "Session expired".
  - Fix hint: route through the same `request()` helper once it has deadlines/back-off (pass explicit credentials instead of the singleton).

## Verified at parity (brief list, so the fixer knows what NOT to redo)
- Session discovery, `primaryAccounts` selection (mail -> core -> first account), shared/group account detection (`src/api/jmap-client.ts:388-401`, `480-493` vs `lib/jmap/client.ts:988-995`, `4421-4463`).
- Per-capability account ids for Sieve and Files (`src/api/sieve.ts:20-23`, `src/api/files.ts:27-31`); calendar/contacts use the primary account on both sides in practice.
- OAuth proactive refresh with 60 s leeway, reactive refresh on 401, single-flight refresh promise, refresh-token rotation fallback (`src/api/jmap-client.ts:193-221`, `src/lib/oauth.ts:210-265`).
- Blob download/upload URL templating with `encodeURIComponent` and RN-safe string splitting (no `new URL()`), shared-account `accountId` override (`src/api/jmap-client.ts:557-566`, `src/api/blob.ts`).
- Upload response parsing accepts both `{blobId}` and `{[accountId]: {blobId}}` shapes (`src/api/blob.ts:38-61`).
- `Mailbox/changes` incremental sync with `hasMoreChanges` drain and `cannotCalculateChanges` fallback; folder tree kept on failure (#780 behaviour) (`src/stores/email-store.ts:528-612`).
- `Email/queryChanges` + `Email/changes` incremental list refresh with snapshot guard (issue #10) and full re-query fallback (`src/stores/email-store.ts:770-980`).
- `null` for patch removal, `false` stripped from `mailboxIds` maps (`src/api/email.ts:456`, `551-556`).
- FilterOperator/FilterCondition kept separate in query filters (`src/api/email.ts:225-237`).
- `getSharedMailboxes` chunks to `maxCallsInRequest` (`src/api/email.ts:84-105`); `getEvents`/`getContacts`/offline sync chunk to `maxObjectsInGet`, and list pages are capped at it since `queryEmailPage` replaced `fetchEmailsChunked` (d987930).
- Send: `/error`, `notCreated` checked; HOLDFOR envelope for scheduled send; FUTURERELEASE capability check (`src/api/email.ts:836-873`, `src/api/jmap-client.ts:505-531`). Two gaps found later: the capability was read from the session instead of the account until e28e8b4 (#57, audit B8), and a method error after a created submission (Stalwart's failed filing into Sent) was reported as a failed send until c51a848 (audit B23).
- Push subscription create/verify/update/destroy with `using: [core]` and 90-day expiry refresh (`src/api/push.ts:9-114`, `src/lib/push-notifications.ts`); calls that read or write `emailPush` also name `urn:ietf:params:jmap:emailpush` since ccaa24e, and every call checks the response since ddfe85a.
- Outbox: idempotent full-state ops, per-account buckets, destroy-wins coalescing, oldest-first replay, account-switch guards (`src/stores/outbox-store.ts`).
- Offline cache: per-account buckets, index + entry keys, eviction by `receivedAt`, optimistic `patch`, abort on account switch (`src/stores/offline-cache-store.ts`); the offline copy is shown before the network since 33e303e (`src/lib/email-detail-cache`, which replaced `getEmailDetail`).
- Credentials in `expo-secure-store` (never AsyncStorage); SecureStore key sanitising; per-account keys; legacy migration.
- Client-cert module uses the platform default `X509TrustManager` (no trust-all) (`BulwarkClientCertModule.kt:216-222`).
- WebView hardening: `originWhitelist=['about:blank']`, no file/universal access, `mixedContentMode="never"`, no multiple windows, no cookies/DOM storage, `incognito`, external links limited to `https?|mailto|tel|sms` (`src/components/EmailBodyView.tsx:675-724`).
- No secrets in `console.*` output; `usesNonExemptEncryption: false` declared (`app.config.js:370`).
- Stalwart self-service via `urn:stalwart:jmap`: password change, display name, TOTP enable/disable, app passwords and API keys with IP allow-list, principal read (`src/api/account-security.ts`), with proper `error`/`notUpdated` checks.
- SHA-256 implementation correct (FIPS 180-4) and APK size + optional checksum verification (`src/lib/sha256.ts`, `src/lib/install-update.ts:100-127`).

## N/A on mobile
- Server-side SSRF/DNS-rebinding guard, endpoint allow-list, `OAUTH_ALLOW_PRIVATE_ENDPOINTS`, IPv6 transition-address checks (`lib/security/url-guard.ts`, `lib/stalwart/server-fetch.ts`; GHSA-24w9): RN talks to the server directly from the device; the only analogue is scheme validation (covered above).
- CSP `frame-src`/`connect-src`/`object-src` changes, `srcDoc` iframe sandbox, plugin bundle signing, admin dashboard, setup wizard, `SESSION_SECRET`, session-cookie slots, Stalwart JMAP passthrough (#627) and auth-context binding: RN has no proxy tier; it holds credentials itself and calls `x:*` methods directly.
- `MAX_SSE_STREAMS`/per-tab socket budget (#702), "one SSE stream per client", browser `visibilitychange`/`online` events, `document.hidden` poll pausing: RN is single-session; the equivalent concern is AppState (listed as a gap).
- Service-worker PWA caching, `blob:` object URLs, `URL.revokeObjectURL`, `window.open` for unsubscribe links.
- WEB S/MIME plugin (privileged same-origin plugin tier), `onBeforeBlobUpload` offload hooks, plugin crypto API: no plugin system in RN.
- `x-www-form-urlencoded` TOTP token exchange on the WEB server (`/api/auth/totp`): RN verifies TOTP through Stalwart's `otpCode` directly.
