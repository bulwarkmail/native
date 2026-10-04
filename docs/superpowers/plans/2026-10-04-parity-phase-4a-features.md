# Parity Phase 4a: Webmail Features for the Phone Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the well-defined webmail features that a phone user will expect:
- copy chips for verification codes;
- inbox-only notifications;
- sign-in with an access token, including Fastmail's separate download domain;
- copying messages;
- server and directory search in recipient autocomplete;
- server-side invitation notices;
- meeting join links and maps;
- working hours in the day and week views;
- a collapsible all-day strip.

**Architecture:**
- Every behaviour has a webmail implementation. Port its pure logic (detection, link parsing, display ranges) with its tests into `src/lib/*`.
- Wire it into stores and screens. Screens stay thin because vitest has no React Native render harness.
- Each setting follows the existing `settings-store` pattern: a type, a default and a validator. Webmail key names are used as they are.

**Tech Stack:** React Native / Expo, TypeScript, Zustand, vitest (`npm test`), JMAP (RFC 8620/8621, JSCalendar, `CalendarEventNotification`, `Principal`) against Stalwart and Fastmail, `expo-clipboard`.

**Spec:**
- the Phase 4 rows of [2026-10-04-webmail-parity-roadmap.md](2026-10-04-webmail-parity-roadmap.md), minus the two large items (see "Not in this phase");
- the findings in [02](../../parity/02-mail-list-folders.md), [03](../../parity/03-email-viewer.md), [05](../../parity/05-calendar.md), [06](../../parity/06-contacts.md), [01](../../parity/01-auth-accounts.md) and [08](../../parity/08-settings-push-i18n-ui.md).

Webmail reference: `origin/main` at `7e1a659` (2026-10-04).

## Global Constraints

- **Branch:** `parity/phase-4a-features`, created from `main`.
- **Webmail reference:** `git clone https://github.com/bulwarkmail/webmail <dir> && git -C <dir> checkout 7e1a659`. "WEB `path`" means a path in that checkout.
- **Gate on every commit:** `npm run typecheck && npm test && npm run i18n:check` must all pass.
- **Strings:**
  - Use `t('key', 'English fallback')`, with the webmail key the task names.
  - Run `npm run i18n:harvest` for any key that is not in the vendored catalog.
  - Dynamic keys go into `locales/rn/en.json` by hand.
- **Commits:** one per task, with the subject the task gives. End each with a `Co-Authored-By:` trailer naming the model that wrote it.
- **Parity docs:** do not edit `docs/parity/*.md` or `PARITY_CHECKLIST.md` in a task. They are ticked with hashes after the final review.
- **Tests:** vitest runs only `src/**/__tests__/**/*.test.ts`, in node. Write tests first and record RED.
- **Outbox:** never delete `webmail:outbox:v1:*` keys.

## Not in this phase

- **"Rules" from a message** (retroactive apply, undo) and the **offline send queue**. Both are large and need design decisions; they get their own plan (Phase 4b).
- **Tasks in the month view (#1107).** Due-dated tasks are already drawn as calendar items (`CalendarScreen.tsx` ~365-390). The remaining gaps are polish: no calendar-visibility filter, no strike-through for completed tasks, no completion circle.
- **A "partially tagged" state in the batch tag sheet** (WEB b51de3b `partialIds`). Native already tags a whole selection at once.

## Review Focus

1. **A message with no code-like text** (newsletters, receipts with order numbers, status codes) shows no verification chip. Owned by Task 1, through the ported webmail "does not take …" cases.
2. **Accounts that sign in with a password or OAuth** keep every session URL rewritten as today. Only an absolute HTTPS download, upload or eventSource URL on another origin than the session's own `apiUrl` is kept. Owned by Task 4, test `still rewrites a localhost or http URL`.
3. **With working hours off (`calendarLimitHours: false`)**, the day and week grids draw all 24 hours, positioned exactly as before. Owned by Task 10, test `the full day is unchanged when limiting is off`.
4. **Copying a message never removes or moves the original.** Owned by Task 6, test `a copy keeps the original where it was`.
5. **With "Inbox only" off**, the push filter is exactly today's junk exclusion. Owned by Task 3, test `the default filter is unchanged`.

---

### Task 1: Detect verification codes

**Files:**
- Create: `src/lib/verification-code.ts`, a port of WEB `lib/verification-code.ts`.
- Test: `src/lib/__tests__/verification-code.test.ts`, a port of WEB `lib/__tests__/verification-code.test.ts`, including its real-mail fixtures.

**Interfaces** (WEB names):
- `findVerificationCode(subject, text): string | null`
- `VERIFICATION_CODE_MAX_AGE_MS`
- `isFreshForVerificationCode(receivedAt, now?)`
- `listVerificationCode(email: Pick<Email,'subject'|'preview'|'receivedAt'>, now?)`
- `verificationCodeBodyText(email): string`

Native has no `htmlToPlainText`. Port a minimal one inside this module:
- strip `style`, `script` and `title` elements;
- turn `br`, `p`, `div`, `tr` and `li` into newlines;
- drop all other tags;
- decode entities;
- keep WEB's 200k/50k caps.

For a plain-text message, use the text part from `bodyValues`, falling back to `plainTextBody` in `src/lib/email-body.ts`.

- [ ] **Step 1: Write the failing tests.** Port every WEB case unchanged: `findVerificationCode`, `listVerificationCode`, `verificationCodeBodyText`, and the real-mail describe (copy its fixtures).
- [ ] **Step 2: Run them to verify they fail.** Expected: the module is missing.
- [ ] **Step 3: Implement.** A line-for-line port; native types replace WEB's.
- [ ] **Step 4: Run them to verify they pass.**
- [ ] **Step 5: Commit** `feat: detect verification codes in sign-in and confirmation mail`

---

### Task 2: Offer a copy chip for verification codes

**Files:**
- Create: `src/components/email/VerificationCodeChip.tsx`
- Modify:
  - `src/stores/settings-store.ts`: add `showVerificationCodes` (default `true`) with its type and validator, following `showPreview`.
  - `src/components/settings/ReadingSettings.tsx`: a toggle next to `show_preview`.
  - `src/screens/EmailListScreen.tsx`: the list row, near `ListAttachmentChips` (~:253). Not gated by `showPreview`.
  - `src/components/email/MessageContent.tsx`: the viewer, near the header and banners (~:74-103).

**Interfaces:**
- Consumes `listVerificationCode`, `findVerificationCode` and `verificationCodeBodyText` from Task 1.
- The chip copies with `expo-clipboard` `setStringAsync`, the same pattern as `AddressActionSheet.tsx:5,41`.
- It shows `toast.success(t('email_viewer.verification_code.copied'))` on success, or `toast.error(t('email_viewer.verification_code.copy_failed'))` on failure.
- Its `accessibilityLabel` is `t('email_viewer.verification_code.copy', { code })`.
- In the list, a press on the chip must not open the row.
- Setting labels: `settings.email_behavior.show_verification_codes.label` and `.description`. These are WEB keys; harvest any that are missing.

- [ ] **Step 1: Write the failing tests.**
  - Extract the "which code to show" decision into a pure function, `chipCodeFor(email, { enabled, inList, now })`. In the list it uses `listVerificationCode`; in the viewer it uses `findVerificationCode(subject, verificationCodeBodyText(email))`.
  - Test: setting off gives null; a list row older than a day gives null; the viewer has no age limit.
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement the chip and the wiring.**
- [ ] **Step 4: Run them to verify they pass.** Then run `npm run typecheck && npm run i18n:check`.
- [ ] **Step 5: Commit** `feat: show a copy chip for verification codes in the list and the message`

---

### Task 3: Notify for Inbox mail only

**Files:**
- Modify:
  - `src/lib/push-notifications.ts`: `buildEmailPushConfig` (~:309), and its caller (~:1000).
  - `src/stores/settings-store.ts`: add `pushNotifyInboxOnly`, default `false`.
  - `src/components/settings/NotificationSettings.tsx`: the toggle under the email notifications switch, disabled when that switch is off.
  - The re-sync on change.
- Test: `src/lib/__tests__/push-config-mailboxes.test.ts`

**Interfaces:**
- `buildEmailPushConfig(inboxOnly = false)` (WEB `lib/web-push.ts:90-135`):
  - **Default:** `[{ notKeyword: '$junk' }, { inMailboxOtherThan: junkIds }]`, unchanged from today.
  - **inboxOnly:** `[{ notKeyword: '$junk' }, { inMailbox: inboxRawId }]`.
  - **An account with no visible Inbox:** `{ hasKeyword: '$junk' }`, which never matches.
- The caller reads the setting at call time.
- When the setting flips, re-run the active account's push setup: `resyncPushNotifications` with the stored relay URL, the same way `App.tsx` does. `refreshSubscriptionExpires` already rewrites a changed `emailPush`. Non-active accounts pick the change up on their next renewal: route `renewDetachedPushSubscription` through the same builder, or note it as a follow-up if that path doesn't write `emailPush`.
- Keys: `settings.notifications.email.inbox_only` and `settings.notifications.email.inbox_only_desc` (WEB). Harvest if missing.

- [ ] **Step 1: Write the failing tests.**
  - `the default filter is unchanged` (Review Focus 5)
  - `inbox only filters to the Inbox`
  - `an account without an Inbox never matches`
  - shared accounts use raw ids
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to verify they pass.**
- [ ] **Step 5: Commit** `feat: offer notifications for Inbox mail only`

---

### Task 4: Keep session URLs that a server hosts on another domain

**Files:**
- Modify: `src/api/jmap-client.ts` (`rewriteSessionUrls` ~:575-598; pure `rewriteSessionUrl` ~:1217)
- Test: `src/api/__tests__/jmap-client-hardening.test.ts` (~:113-120)

**Interfaces** (WEB 29c74c3 `rewriteSessionUrls`):
- `apiUrl` is always rewritten.
- `downloadUrl`, `uploadUrl` and `eventSourceUrl` are kept unchanged when all of these hold:
  - the URL is absolute;
  - it is on an origin that starts with `https:`;
  - that origin differs from the origin of the session's own reported `apiUrl`;
  - `apiUrl` is itself absolute.
- Every other case is rewritten as today.
- Keep the string-based parsing. The existing comment explains that the RN URL polyfill mangles RFC 6570 templates.

- [ ] **Step 1: Write the failing tests.**
  - `keeps a download URL on another HTTPS domain` (Fastmail: `apiUrl` `https://api.fastmail.com/jmap/api/`, `downloadUrl` `https://www.fastmailusercontent.com/jmap/download/{accountId}/{blobId}/{name}?type={type}`).
  - `still rewrites a localhost or http URL` (Review Focus 2).
  - `rewrites a relative URL`.
  - `always rewrites apiUrl`.
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to verify they pass.**
- [ ] **Step 5: Commit** `fix: keep download and upload URLs a server hosts on another domain`

---

### Task 5: Sign in with an access token

**Files:**
- Modify:
  - `src/api/jmap-client.ts`: `connectWithToken` ~:297-306 persists credentials the way `connectWithOAuth` ~:310-347 does.
  - `src/stores/auth-store.ts`: a new `loginWithToken`, shaped like `completeOAuthHandoff` ~:262.
  - `src/screens/LoginScreen.tsx`: a new `'token'` step.
  - `src/screens/login/ChooseStep.tsx` or `PasswordStep.tsx`: the entry link.
  - `src/components/settings/AccountSettings.tsx` (~:55): the auth label.
- Create: `src/screens/login/TokenStep.tsx`
- Test: `src/stores/__tests__/auth-store-token.test.ts` (new), `src/api/__tests__/jmap-client.test.ts`

**Interfaces:**
- `jmapClient.connectWithToken(serverUrl, accessToken)`:
  - fetches the session;
  - takes the username from `session.username`, and throws `AuthenticationError` if it is missing;
  - stores `{ serverUrl, username, password: '', accessToken }` under `credentialsKey(generateAccountId(username, serverUrl))` with no `refreshToken`, `expiresAt` or `tokenEndpoint`;
  - returns the session.
- Confirm that `currentOAuthTokens()` returns null for such credentials, so nothing ever tries a refresh.
- `useAuthStore.loginWithToken(serverUrl: string, typedToken: string, opts?: { addAccount?: boolean })`:
  - cleans the token with `trim().replace(/^Bearer\s+/i, '')`;
  - rejects an empty token, or one containing whitespace, with error `'invalid_token'`;
  - maps a 401 or 403 to `'invalid_token'`;
  - otherwise behaves like `login`: snapshot and rollback, `assertRoomForAccount`, `addAccount`, `setActiveAccount`, `applyConnectedState`, `fetchMailboxes`.
- An expired token behaves like a revoked password today: the account is signed out and the user signs in again. WEB documents the same.
- UI: a TokenStep with a server URL field (pre-filled from known or discovered servers) and a token field (`secureTextEntry`, no autocorrect). Reach it from a link on the password step: `login.token_toggle` "Sign in with an access token". Its labels are `login.token_label`, `login.token_placeholder` and `login.token_hint`, and its error is `login.error.invalid_token`.
- AccountSettings: show `auth_method_token` for a bearer account with no refresh token, and keep `oauth` for the others. Expose this from the client as `jmapClient.authKind: 'basic' | 'oauth' | 'token'`.

- [ ] **Step 1: Write the failing tests.**
  - Token cleaning: the `Bearer ` prefix, whitespace, empty.
  - A successful token login registers the account under the session username.
  - A 401 gives `'invalid_token'` and leaves no account behind.
  - `connectWithToken` persists credentials without refresh fields.
  - `authKind` returns `'token'`.
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to verify they pass.** Then run `npm run typecheck && npm run i18n:check`.
- [ ] **Step 5: Commit** `feat: sign in with an access token`

Device check: sign in to Fastmail with an API token. The inbox loads and an attachment downloads.

---

### Task 6: Copy messages to a folder or another account

**Files:**
- Modify:
  - `src/stores/email-store.ts`. Change `crossAccountMove` (~:2241-2257) to take `{ keepOriginal }`. Add `copyToMailbox(emailId, toMailboxId)` and `copyEmailsToMailbox(ids, toMailboxId)` next to the move actions (~:1555-1575, ~:1800-1818).
  - `src/api/email.ts`: a same-account copy.
  - `src/components/MoveSheet.tsx`: add a `title` prop.
  - `src/screens/EmailThreadScreen.tsx`: a "Copy to…" item next to "Move to…" (~:1258), plus a second sheet or a mode.
  - `src/screens/EmailListScreen.tsx`: a batch "Copy" action next to Move (~:1029).
- Test: `src/stores/__tests__/email-store-copy.test.ts` (new), `src/api/__tests__/email.test.ts`

**Interfaces:**
- Across accounts, follow WEB f02dbf3:
  - reuse `crossAccountMove` with `keepOriginal: true` (blob, upload, `importEmailBlob` with `receivedAt` and keywords);
  - skip the destroy;
  - leave the open list, the selection and the viewer as they are;
  - refresh the destination account's mailboxes.
- Within the same account (an addition to WEB, which only copies across accounts):
  - `copyEmailsWithinAccount(ids, toMailboxId, accountId?)` sends `Email/set` with `update: { [id]: { ['mailboxIds/' + escapedId]: true } }`;
  - use `assertSetResult`;
  - the message then sits in both folders.
- The picker is `MoveSheet` with `title={t('context_menu.copy_to', 'Copy to…')}`. This key is new; WEB has only `context_menu.copy_to_account`, because it copies across accounts only. It excludes the current folder and folders the user can't add to.
- Failures use Phase 3's `withFailureToast` / `reportActionFailure` with `notifications.copy_failed` (harvest if missing).
- Copies are online only, like the cross-account move. They are never queued in the outbox.

- [ ] **Step 1: Write the failing tests.**
  - `a copy keeps the original where it was` (Review Focus 4).
  - A cross-account copy imports into the destination with the original date and keywords, and destroys nothing.
  - A same-account copy patches `mailboxIds/<dest>` only.
  - `reports a failed copy as a copy`.
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to verify they pass.** Then run `npm run typecheck && npm run i18n:check`.
- [ ] **Step 5: Commit** `feat: copy messages to another folder or account`

---

### Task 7: Search the server and the directory when picking recipients

**Files:**
- Modify:
  - `src/stores/contacts-store.ts` (`getAutocomplete` ~:691-735; `searchRecipients` ~:679-689, currently uncalled)
  - `src/screens/ComposeScreen.tsx` (suggestions ~:818-850, list UI ~:235-246, ~:2438)
- Create: a directory loader. Either generalise `getPrincipals` in `src/api/files.ts:507-531` into `src/api/principals.ts` and reuse it from Files, or add a contacts-specific loader that also returns `email` and `description`.
- Test: `src/stores/__tests__/contacts-store.test.ts` (or the existing autocomplete test file), `src/api/__tests__/principals.test.ts`

**Interfaces** (WEB `stores/contact-store.ts:668-757, 1194`; `components/email/email-composer.tsx:1360-1414`):
- Directory principals:
  - Loaded once per account when the composer first needs suggestions, and only when the `Principal` capability exists.
  - Principals with no email are dropped. The name is `description || name`.
  - Matched on name, address and description.
  - Merged after contacts and groups, before recent recipients.
  - A principal whose address a contact already matched is skipped, but the contact borrows the principal's name when it has none.
- Server search:
  - When the typed query has at least 2 characters, the suggestion list ends with a "Search the server" row.
  - The row is `t('email_composer.autocomplete_search_server', 'Search the server')` (WEB key).
  - Tapping it runs `searchRecipients(q)` and merges the hits into the open list, deduped by email.
  - No debounce, because the search runs on tap.
- Keep `normalizeSuggestions`. Keep the native cap of 8 shown suggestions.
- Port WEB tests `should augment results with directory principals` and `should not duplicate a directory principal already matched as a contact`.

- [ ] **Step 1: Write the failing tests.**
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to verify they pass.** Then run `npm run typecheck && npm run i18n:check`.
- [ ] **Step 5: Commit** `feat: suggest directory people and search sent mail for recipients`

---

### Task 8: Show invitations the server sent or received for you

**Files:**
- Create: `src/api/calendar-event-notifications.ts`, `src/stores/calendar-event-notification-store.ts`
- Modify:
  - `App.tsx`: subscribe with `onStateChangeType('CalendarEventNotification', …)` from `src/lib/state-change-bus.ts` (example at `src/lib/calendar-notifications.ts:399-400`), and fetch once after sign-in and on resume.
  - The foreground FCM path (`App.tsx:~506`): if it receives the state-change map, it should also call `dispatchStateChange`. Check this, and wire it only if it is a one-line change.
- Test: `src/api/__tests__/calendar-event-notifications.test.ts`, `src/stores/__tests__/calendar-event-notification-store.test.ts`

**Interfaces** (WEB `lib/jmap/client.ts:5887-5927`, `lib/pending-notification-store.ts:28-77`, `components/layout/calendar-event-notification-toaster.tsx`):
- `getCalendarEventNotifications(): Promise<CalendarEventNotification[]>`:
  - one request, `CalendarEventNotification/query` sorted by `created` ascending, with a back-referenced `/get` (WEB property list);
  - returns `[]` without the calendar capability (`hasCalendarCapability`).
- `destroyCalendarEventNotifications(ids)`: `/set destroy`, batched by `maxObjectsInSet`.
- Store `{ pending, fetch, acknowledge, reset }`:
  - `fetch` coalesces calls in flight and dedupes with a `seen` set;
  - `acknowledge` removes the notices locally first, then destroys on the server, and only logs a failure.
- Presentation: skip `isDraft`. For each other notice:
  - `created` → `toast.info(t('calendar_event_notifications.invited', { name, title }))`;
  - `destroyed` → `toast.warning(…cancelled…)`;
  - anything else → `toast.info(…updated…)`;
  - the body is `comment`, the name is `changedBy.name || changedBy.email || t('…someone')`, and the title is `event.title || t('…untitled')`.
- Then refresh the calendar store (`refresh()`) and acknowledge the shown ids.
- Add an "Open" action when the event is loadable. Navigate the way the event deep link does (`src/navigation/linking.ts`).
- Reset the store on sign-out and on account switch, next to the calendar store's reset.

- [ ] **Step 1: Write the failing tests.**
  - The API's request shape and the no-capability `[]`.
  - Store: dedupe, coalescing, acknowledge removes locally then destroys, and a destroy failure doesn't re-add the notice.
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to verify they pass.** Then run `npm run typecheck && npm run i18n:check`.
- [ ] **Step 5: Commit** `feat: tell the user about invitations the server delivered`

---

### Task 9: Open meeting links and map locations from an event

**Files:**
- Create: `src/lib/event-links.ts`, a port of WEB `lib/event-links.ts`
- Modify: `src/components/calendar/EventDetailSheet.tsx` (~:186-187, ~:265-279)
- Test: `src/lib/__tests__/event-links.test.ts`, a port of WEB `lib/__tests__/event-links.test.ts`

**Interfaces** (WEB names): `unwrapSafeLink`, `meetingProviderOf`, `findMeetingLink(event)`, `primaryLocationName`, `isMeetingLabel`, `locationAction(location, meeting): 'url' | 'maps'`, `mapsUrl(q)`.

- The detail sheet's join button uses `findMeetingLink` and replaces the `virtualLocations`-only `videoUri`. It opens through `openExternalUrl(uri, { confirm: true })`.
- The location row becomes tappable:
  - a `'url'` action opens the URL the same way;
  - a `'maps'` action opens `mapsUrl(location)` through `Linking.openURL`, with the `ContactDetailScreen.tsx:236-239` failure alert;
  - long-press copies the location.
- Script and `UNSAFE_SCHEMES` links are never opened.

- [ ] **Step 1: Write the failing tests.** Port every WEB case.
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to verify they pass.** Then run `npm run typecheck && npm run i18n:check`.
- [ ] **Step 5: Commit** `feat: open meeting links and map locations from an event`

---

### Task 10: Limit the day and week views to working hours and days

**Files:**
- Create: `src/lib/calendar-display-range.ts`, a port of WEB `lib/calendar-display-range.ts`
- Modify:
  - `src/stores/settings-store.ts`: `calendarLimitHours` (default true), `calendarDayStartHour` (8), `calendarDayEndHour` (20), `calendarHideNonWorkingDays` (false) and `calendarWorkingDays` (`[1,2,3,4,5]`), each with a validator.
  - `src/components/settings/CalendarSettings.tsx` (switches ~:132-192)
  - `src/components/calendar/TimeGridScrollView.tsx` (`HOUR_HEIGHT`/`GRID_HEIGHT` ~:48-54, scroll ~:269, hour lines ~:435, event top and height ~:564, now-line ~:588, `hourAtOffset` ~:554)
  - `src/components/calendar/WeekView.tsx` (`weekDays` ~:75-79)
- Test: `src/lib/__tests__/calendar-display-range.test.ts`, a port of the WEB lib test

**Interfaces** (WEB 0b4d0b0): `resolveDisplayHours(enabled, start, end)` returns `{ startMinutes, endMinutes, restricted }`. Also port `formatDisplayHour`, `resolveWorkingDays`, `partitionByDisplayHours`, `clipToDisplayHours` and `remapSegmentsToShownDays`.

The grid:
- draws only `startMinutes..endMinutes`, and every y-coordinate subtracts `startMinutes`;
- clips events at the edges;
- shows a tappable "N earlier events" or "N later events" indicator (`calendar.events.hidden_before` / `hidden_after`, ICU plural); tapping it reveals all hours and scrolls to the event;
- has an "Show all hours" / "Show only X – Y" toggle.

When the user hides non-working days, the week view drops those days. The month, day and agenda views don't.

Settings:
- hours as Selects, where the end offers only hours after the start;
- day chips ordered from `calendarFirstDayOfWeek`;
- at least one working day must stay selected.

Keys (WEB):
- `calendar.settings.limit_hours`, `limit_hours_desc`, `visible_hours`, `visible_hours_start`, `visible_hours_end`, `hide_non_working_days`, `hide_non_working_days_desc`, `working_days`;
- `calendar.events.show_all_hours`, `show_display_hours`, `hidden_before`, `hidden_after`.

- [ ] **Step 1: Write the failing tests.**
  - Port the WEB lib cases.
  - Add `the full day is unchanged when limiting is off` (Review Focus 3).
  - Extract the grid's y-coordinate maths into a pure helper (`minutesToY(minutes, range, hourHeight)`) and test the offset and the clipping.
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to verify they pass.** Then run `npm run typecheck && npm run i18n:check`.
- [ ] **Step 5: Commit** `feat: limit the day and week views to working hours and days`

---

### Task 11: Collapse a crowded all-day strip

**Files:**
- Modify: `src/components/calendar/WeekView.tsx` (~:33-34, ~:96-104, ~:179-215), plus the all-day strip in `TimeGridScrollView.tsx`, if it has its own (check its header comment ~:90).
- Test: a pure helper in `src/lib/calendar-all-day.ts` (new) with its test.

**Interfaces** (WEB `components/calendar/calendar-week-view.tsx:247-267, 393-410`):
- `DEFAULT_ALL_DAY_MAX_ROWS = 3`.
- `allDayStripLayout(rowCounts: number[], expanded: boolean)` returns `{ visibleRows, hiddenCount, expandable }`. `rowCounts` covers only the visible days.
- The "All day" gutter label becomes the toggle: "+N" when collapsed, a chevron when expanded. Its keys are `calendar.events.show_more` and `show_less`, and it sets `accessibilityState.expanded`.
- Segments beyond the visible rows are hidden while collapsed.

- [ ] **Step 1: Write the failing tests.** Capped at 3, a toggle only when more than 3 rows are needed, sized from the visible days.
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to verify they pass.**
- [ ] **Step 5: Commit, then close the phase.** Commit `feat: collapse a crowded all-day strip`. After the final review, tick the parity items and update the counts in one `docs:` commit.
