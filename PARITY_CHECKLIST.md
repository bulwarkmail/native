# Webmail parity checklist

Audit of **Bulwark Mobile** (`bulwarkmail/native`, v0.1.58 @ `82b97fa`) against
**Bulwark Webmail** (`bulwarkmail/webmail`, v1.9.2 @ `39dcc6b2`), taken on
2026-08-29. The goal is feature *and* bugfix parity: every user-facing webmail
behaviour, and every webmail changelog fix since the native app was started
(1.4.5 → 1.9.2), was checked against the native code.

The audit was done by reading code on both sides, not by running the app. Every
finding cites `file:line` on both sides so it can be re-verified quickly; a
sample of the 32 P1 findings was additionally spot-checked by hand.

## How to use this document

- The detailed findings live in [docs/parity/](docs/parity/), one file per area.
  Tick the `- [ ]` boxes there as you fix things; this file is the index.
- Each finding has a **priority** and a **category**:

  | Priority | Meaning |
  |---|---|
  | `P1` | data loss, wrong send/delete, security, crash, or a core flow that is blocked |
  | `P2` | notable feature missing or visibly wrong |
  | `P3` | polish, nice-to-have, minor divergence |

  | Category | Meaning |
  |---|---|
  | `missing` | webmail has it, native does not |
  | `partial` | native has a reduced version |
  | `bug` | native has it, but it is wrong |
  | `bugfix-parity` | a bug the webmail fixed (changelog / issue number cited) that is still live in native |
  | `rn-only-bug` | a bug that only exists in native (found while reading) |

- `WEB` paths are relative to the webmail repo, `RN` paths to this repo.
  Issue numbers `#NNN` refer to the **webmail** tracker unless prefixed
  "native #NN".
- Each area file ends with **Verified at parity** (do not redo) and
  **N/A on mobile** (deliberately out of scope) lists.
- A few findings appear in two areas because they sit on a boundary (e.g.
  "forward drops attachments" is in both viewer and composer). Fix once, tick
  both.

## Baseline health of this repo (2026-08-29)

- [x] **`npm test` is red on `main`** — `P2` — `rn-only-bug` *(fixed in b84d4d8)*
  - `src/stores/__tests__/auth-store.test.ts` fails to load with
    `SyntaxError: Unexpected token 'typeof'`. The chain
    `auth-store → email-store → outbox-store → network-store` imports
    `@react-native-community/netinfo`, which `src/test-setup.ts` never mocks
    (it mocks `react-native`, `expo-secure-store`, `expo-web-browser`,
    AsyncStorage only). Broken since `5d47f47` (2026-05-30) when the outbox
    import was added; `email-store.test.ts` only passes because it mocks
    `../outbox-store` itself.
  - Fix hint: add `vi.mock('@react-native-community/netinfo', () => ({ default: { addEventListener: vi.fn(() => () => {}), fetch: vi.fn(async () => ({ isConnected: true, isInternetReachable: true })) } }))`
    to `src/test-setup.ts`. Expected afterwards: 31/31 suites (432+ tests).
- [x] **CI runs neither `tsc` nor `vitest`** — `P2` — `missing` *(fixed in fb4796e)*
  - `.github/workflows/` only has `release-android.yml` and `release-ios.yml`.
    Add a `ci.yml` running `npm ci && npm run typecheck && npm test` on push/PR.
- `npx tsc --noEmit` is clean.
- Uncommitted work in the tree at audit time: ascending/descending mail sort
  (native #5) in `src/stores/email-store.ts`, `src/stores/settings-store.ts`,
  `src/screens/EmailListScreen.tsx`, `src/stores/__tests__/email-store.test.ts`.
  Findings that touch list ordering assume that lands.
- [x] **README is stale** — `P3` — it says "Filters & rules, S/MIME, plugins, *(fixed in 9ae91a6)*
  themes, file storage – UI stubs only". Filters, Files and file sharing are
  real (see areas 07); S/MIME, plugins, themes and sidebar apps are still
  stubs (area 08).

## Status after the 2026-08-29 fix pass

Worked down the same day, area by area, by one orchestrating session plus one
agent per area, each change committed on its own (`type: short description`).
Per-area counts of ticked items are in the area files; every tick carries the
commit hash. The remaining `- [ ]` items are either deferred with a note
("deferred: …") or need work outside this repo (webmail hand-off `flow=oauth`
for TOTP accounts, relay APNs/UnifiedPush transports, a server-side settings
store for native #1).

## Status after the 2026-09-24 fix pass

The native audit of 2026-09-22 ([docs/audit-2026-09.md](docs/audit-2026-09.md))
spot-checked this list and found 14 ticks that were broken or overstated and 11
open items that were already done. The 2026-09-24 fix pass fixed 13 of the 14
(their ticks now also name the fixing commit; the date-locale item is open
again), dropped three obsolete items and ticked what it completed: 379 of 415
items are done, 36 open. What still needs a device check or a decision is in
the audit's "Fix pass, 2026-09-24" section.

## Areas

| # | Area | File | Items | Done | Open | P1 | P2 | P3 |
|---|---|---|---|---|---|---|---|---|
| 01 | Authentication, login, session, multi-account | [docs/parity/01-auth-accounts.md](docs/parity/01-auth-accounts.md) | 30 | 29 | 1 | 4 | 8 | 18 |
| 02 | Mail list, folders, unified views, search, tags | [docs/parity/02-mail-list-folders.md](docs/parity/02-mail-list-folders.md) | 54 | 50 | 4 | 1 | 20 | 33 |
| 03 | Email viewer, thread view, rendering, attachments | [docs/parity/03-email-viewer.md](docs/parity/03-email-viewer.md) | 46 | 45 | 1 | 6 | 13 | 26 |
| 04 | Composer, drafts, sending, identities, templates, scheduled send | [docs/parity/04-composer-send.md](docs/parity/04-composer-send.md) | 51 | 46 | 5 | 5 | 14 | 32 |
| 05 | Calendar and tasks | [docs/parity/05-calendar.md](docs/parity/05-calendar.md) | 50 | 43 | 7 | 5 | 20 | 25 |
| 06 | Contacts and address books | [docs/parity/06-contacts.md](docs/parity/06-contacts.md) | 50 | 46 | 4 | 1 | 18 | 31 |
| 07 | Filters (Sieve), vacation responder, Files | [docs/parity/07-filters-vacation-files.md](docs/parity/07-filters-vacation-files.md) | 32 | 29 | 3 | 3 | 8 | 21 |
| 08 | Settings, sync, push, i18n, themes, updates, misc UI | [docs/parity/08-settings-push-i18n-ui.md](docs/parity/08-settings-push-i18n-ui.md) | 46 | 37 | 9 | 0 | 14 | 32 |
| 09 | JMAP client core, live sync, offline, security, S/MIME | [docs/parity/09-jmap-core-sync-security.md](docs/parity/09-jmap-core-sync-security.md) | 56 | 54 | 2 | 7 | 23 | 26 |
| | **Total** | | **415** | **379** | **36** | **32** | **138** | **244** |

Counts are of the `- [ ]` and `- [x]` items per file as of 2026-09-24. Done and
Open split them by tick; the P columns count the priority tags on those items
(one item carries none).

## All P1 findings (fix these first)

### Data loss / wrong send
- [x] No draft autosave, no save-on-close, and the OS back gesture bypasses the discard guard — closing a compose loses everything. → [04](docs/parity/04-composer-send.md) *(fixed in 5b72c4d)*
- [x] Cannot open or edit an existing draft (Drafts folder opens the read-only viewer). → [04](docs/parity/04-composer-send.md) *(fixed in 5b72c4d)*
- [x] Message is filed into **Sent before `EmailSubmission/set`**; a failed send leaves a never-sent copy in Sent and a retry duplicates it. → [04](docs/parity/04-composer-send.md) *(fixed in ccbe67c)*
- [x] `In-Reply-To` / `References` are written with the **JMAP email id** instead of the RFC Message-ID (`messageId`/`references` are never even fetched) — every reply breaks threading in recipients' clients. → [03](docs/parity/03-email-viewer.md), [04](docs/parity/04-composer-send.md) *(fixed in 7f956d6)*
- [x] Reply addressing: `Reply-To` ignored, the user's own address kept on reply-all, wrong recipients on self-sent replies (#703, 1.9.0). → [03](docs/parity/03-email-viewer.md) *(fixed in 7f956d6)*
- [x] **Forward drops every attachment.** → [03](docs/parity/03-email-viewer.md), [04](docs/parity/04-composer-send.md) *(fixed in 7f956d6)*
- [x] Sieve: RN generator has no `attachment` field and emits `header :contains "undefined" ""` for webmail-authored attachment rules — **any save on the phone corrupts the shared server script**. → [07](docs/parity/07-filters-vacation-files.md) *(fixed in 1c6aa68)*
- [x] Sieve: multi-value conditions (`string[]`, webmail 1.7.3) make the whole script "opaque" on RN; "Reset to visual builder" then wipes all rules. → [07](docs/parity/07-filters-vacation-files.md) *(fixed in 1c6aa68)*
- [x] `FilterRuleModal` is always mounted and never re-seeds: editing rule B shows and **saves rule A's fields under B's id**. → [07](docs/parity/07-filters-vacation-files.md) *(fixed in 1c6aa68)*
- [x] Calendar recurrence scope dialog is a stub: "This event" / "This and following" act as "All events" — deleting one occurrence **destroys the series**. → [05](docs/parity/05-calendar.md) *(fixed in 161baf1)*
- [x] Editing an expanded occurrence rewrites the master's `start` to the occurrence date (series shifts, earlier occurrences vanish). → [05](docs/parity/05-calendar.md) *(fixed in 161baf1)*
- [x] All-day events grow by one day on every create-via-toggle and every re-save. → [05](docs/parity/05-calendar.md) *(fixed in 58a6f45)*
- [x] Events are created without `timeZone` (floating time). → [05](docs/parity/05-calendar.md) *(fixed in 58a6f45)*
- [x] Invitations are never sent: participants use the retired `sendTo`, no organizer participant, no `organizerCalendarAddress` (#500, #731). → [05](docs/parity/05-calendar.md) *(fixed in 5dc4070)*
- [x] vCard import writes dates as raw strings instead of RFC 9553 PartialDate (#224) — Stalwart rejects the whole card, so any contact with a birthday is lost on import. → [06](docs/parity/06-contacts.md) *(fixed in e650cb2)*

### Core flow blocked / wrong content shown
- [x] TOTP / 2FA password login is impossible (402 is shown as a generic failure). → [01](docs/parity/01-auth-accounts.md) *(fixed in b52768e)*
- [x] Webmail password handoff breaks for TOTP-protected accounts (cross-repo: webmail should hand off `flow=oauth` after a TOTP-upgraded login). → [01](docs/parity/01-auth-accounts.md) *(fixed in 0d94d76)*
- [x] A failed "add account" resets the singleton client before connecting, killing the live session until relaunch. → [01](docs/parity/01-auth-accounts.md) *(fixed in b52768e)*
- [x] Account Security screen is dead against every Stalwart server: it checks `session.capabilities` but Stalwart advertises `urn:stalwart:jmap` only in `accountCapabilities` (verified on 0.16.19) — **native #47**. → [01](docs/parity/01-auth-accounts.md) *(fixed in 032732c)*
- [x] Thread view: only the newest message of a thread is reachable; older messages cannot be opened unless threading is disabled. → [03](docs/parity/03-email-viewer.md) *(fixed in d2ed27f)*
- [x] Pager shows another message's body (or nothing) when the opened id is not in the active folder page — unified inbox, group inboxes, contact activity. → [02](docs/parity/02-mail-list-folders.md), [03](docs/parity/03-email-viewer.md) *(fixed in c8be383)*
- [x] HTML-only messages are rendered — and quoted in replies — as raw HTML source (**native #46**). `<style>` stripping and an old dark-mode CSS revision are the likely cause of **native #49**. → [03](docs/parity/03-email-viewer.md) *(fixed in 06742ef)*

### JMAP client, live sync, security
- [x] No request deadline on any fetch — a stalled socket (iOS background suspension, dead pooled connection) hangs send/save forever (#702). → [09](docs/parity/09-jmap-core-sync-security.md) *(fixed in 0b1c240)*
- [x] Most `src/api/*.ts` functions index `methodResponses[0][1]` blindly and never check `error` / `notUpdated` / `notDestroyed` — a rejected mutation is reported as success and the outbox drops it. → [09](docs/parity/09-jmap-core-sync-security.md) *(fixed in ccbe67c)*
- [x] Password change leaves the stored credential stale; the next launch evicts the account. → [09](docs/parity/09-jmap-core-sync-security.md) *(fixed in 032732c)*
- [x] No `AppState` handling: SSE is never paused in background nor recovered on foreground, and `react-native-sse` never reconnects after a status-0 network error — push is silently dead after the first blip. → [09](docs/parity/09-jmap-core-sync-security.md) *(fixed in edc26ce)*
- [x] SSE `Authorization` header is captured once; after an OAuth refresh every reconnect sends the stale token (401 → re-poll every 5 s forever). → [09](docs/parity/09-jmap-core-sync-security.md) *(fixed in edc26ce)*
- [x] Push effect is keyed on the singleton client, so the SSE stream stays bound to the previous account after `switchAccount`. → [09](docs/parity/09-jmap-core-sync-security.md) *(fixed in edc26ce)*
- [x] Webmail password handoff sends the clear-text password in a custom-scheme redirect fragment that any app can register; OAuth `state` uses `Math.random`; `server_url`/`token_endpoint` in the callback are trusted as-is. → [09](docs/parity/09-jmap-core-sync-security.md), [01](docs/parity/01-auth-accounts.md) *(fixed in 2c0dbd1)*

### Repo health
- [x] `npm test` is red on `main` (see Baseline health above). *(fixed in b84d4d8)*

## Native issues mapped to findings

| Native issue | Where it is explained |
|---|---|
| #49 Unreadable text in dark-mode emails | [03](docs/parity/03-email-viewer.md) `<style>` stripping + stale dark-mode CSS |
| #48 / #44 UnifiedPush / non-FCM push | [08](docs/parity/08-settings-push-i18n-ui.md) push section |
| #47 Account security not accessible | [01](docs/parity/01-auth-accounts.md) capability map bug (P1) |
| #46 email preview shows css | [03](docs/parity/03-email-viewer.md) HTML-only body detection (P1) |
| #45 error when re-registering to relay | [08](docs/parity/08-settings-push-i18n-ui.md) push section |
| #34 Native contacts/calendar sync adapters | feature request, out of parity scope; noted in [06](docs/parity/06-contacts.md) |
| #5 Sort ascending/descending | in progress in the working tree; ordering presets in [02](docs/parity/02-mail-list-folders.md) |
| #3 TLS client auth | Android-only today; gaps in [01](docs/parity/01-auth-accounts.md) and [09](docs/parity/09-jmap-core-sync-security.md) |
| #1 Shared settings between webmail and native | [08](docs/parity/08-settings-push-i18n-ui.md) — webmail sync is server-side/cookie-bound; a JMAP-blob design is sketched there |

## Cross-cutting themes

These come up in nearly every area; fixing them centrally pays off more than
per-screen patches.

1. **Email headers are never fetched.** `EMAIL_FULL_PROPERTIES` lacks
   `messageId`, `inReplyTo`, `references`, `headers`, `replyTo` usage. This
   single gap causes the broken threading headers, missing Reply-To handling,
   no SPF/DKIM/DMARC chips, no List-Unsubscribe, no read receipts, no details
   panel. (03, 04)
2. **No thread model.** The list collapses threads but the viewer is a
   single-message pager over the folder page. (02, 03)
3. **Hard-coded English.** RN has an i18n layer and 15 vendored locales, but
   84 of 94 screen/component files never call `t()`; calendar, files,
   vacation, scheduled, login and every settings pane except Language and
   Filters are English-only. Catalogs are ~6 weeks behind webmail (640 missing
   keys), and there is no interpolation, plurals or RTL. (all areas, 08)
4. **Single-account assumptions.** Contacts, calendars (subscriptions), filters,
   vacation and Files are primary-account only; shared/group accounts work
   for mail folders but not elsewhere. (01, 05, 06, 07)
5. **Webmail bugfixes that are one-line ports:** `$junk`/`$notjunk` flip on
   spam (#850), search defaults to all folders (#788), folder substring dedup
   (#771), permanent-delete confirmation, `$pinned` vs `$important`, FileNode
   `modified` vs `updated` (#700), percent-decoding WebDAV names (#869),
   RSCALE/SKIP=OMIT removal (#805), first-touch gate for lazy default
   calendar/address book creation (#907), `supported-calendar-component-set`
   pinning (#760), request timeouts (#702), relative session URL resolution.
6. **Settings that do nothing.** 16–17 persisted keys are never read outside
   the settings UI (layout, sound, calendar notifications, sidebar apps,
   S/MIME, plugins, theme id, files thumbnails, …). Either wire them or remove
   the toggles. (08, table in that file)
7. **Deep links / intents.** `bulwarkmobile://` is registered but nothing
   handles it; no `mailto:` or share-to-app intent filters. (04, 08)
8. **Push.** Subscribes to `Email`+`Mailbox` instead of `EmailDelivery`, no
   `emailPush` spam filter, ignores relay-forwarded ids and guesses "newest
   unread", never matches the payload to an account, no device list/revoke,
   Android/FCM only. (08)
9. **JMAP client robustness.** `src/api/jmap-client.ts` is a thin transport
   with none of the layers webmail added since 1.4.5: request deadlines,
   `maxConcurrentRequests` back-off, transient retry, rate-limit pause,
   `maxObjectsInSet` / `maxSizeUpload` chunking, keep-alive monitoring,
   first-touch serialisation, and — most importantly — method-error checking.
   A shared `requireMethodResult` / `assertSetResult` helper used by every
   `src/api/*.ts` function fixes a whole class of silent failures. (09)
10. **Live sync lifecycle.** No `AppState` or connectivity hooks around the
    EventSource; reconnect, token refresh, account switch and client-cert
    users all leave the stream dead or stale. (09)

## Suggested order of work

1. Repo health: fix `test-setup.ts`, add CI. Half a day.
2. The P1 list above, roughly in the order given (composer/send correctness,
   Sieve corruption, calendar write path, vCard dates, auth blockers, viewer,
   JMAP client + SSE lifecycle).
3. Cross-cutting themes 1, 2 and 9 (fetch headers, thread view, method-error
   checking + request deadline) — they unlock a large slice of the P2 items in
   03/04/09 and make the outbox trustworthy.
4. P2 items per area, starting with 02 (spam keywords, search scope, unified
   inbox actions/paging, tags in rows) and 08 (push correctness, i18n
   catalogs + `t()` sweep).
5. P3 items opportunistically while touching the same files.

## Explicitly out of scope on mobile

Collected from the per-area N/A lists so nobody re-litigates them: keyboard
shortcuts, drag & drop, three-pane / Pro split-screen shell, browser
back/forward and permalinks in the address bar, PWA install / service worker,
print, guided tour, CSP nonces / server-side SSRF guards, admin dashboard and
setup wizard, plugin sandbox and marketplace (a minimal "sidebar apps in a
WebView" subset is described in 08), impersonation, TOTP re-auth dialog for
cookie sessions, server-side telemetry, OpenGraph cards. Where a webmail
feature is server-mediated (settings sync, iCal fetch proxy, TOTP token
exchange, push relay list) the area file says what the native equivalent
would be.

## Keeping this current

Re-run the audit after each webmail release: read the new changelog "Fixes"
bullets, decide `RN affected / not affected / N/A`, and append to the matching
area file. When a finding is fixed, tick it and add the native commit hash in
the same line so the next audit can skip it.
