# Webmail parity roadmap (October 2026)

How to work down the 109 open items in [PARITY_CHECKLIST.md](../../../PARITY_CHECKLIST.md)
and [docs/parity/](../../parity/): 74 come from the webmail 1.10.0 → 1.12.0+
delta (audited 2026-10-04), 35 are left over from the 1.9.2 audit. The six
open webmail items in [docs/audit-2026-09.md](../../audit-2026-09.md) ("Missing
vs webmail") are folded into Phase 6.

Each phase is one branch and one implementation plan. Only Phase 1 has a
detailed plan yet ([2026-10-04-parity-phase-1-security-send.md](2026-10-04-parity-phase-1-security-send.md)).
Write the next phase's plan when the previous one merges, because each phase
changes files the next one touches. Re-run the delta audit before writing a
plan, since webmail ships every few days.

## Ground rules for every phase

- **Source of truth.** For each item, the area file in `docs/parity/` gives
  the WEB and RN file pointers. Port webmail's logic and tests rather than
  re-deriving them. Reference checkout:
  `git clone https://github.com/bulwarkmail/webmail` at `a4e313f` or later.
- **One finding, one commit** (`fix:` / `feat:`, as in the git log). Tick the
  item in its area file in the same commit and add the commit hash, as the
  existing ticks do.
- **Gate:** `npm run typecheck && npm test && npm run i18n:check` passes on
  every commit. New user-visible strings use `t('key', 'English')`. Reuse the
  webmail key when one exists (it arrives with the next `sync-locales`);
  otherwise `npm run i18n:harvest` adds it to `locales/rn/en.json`.
- **Device check.** Anything that touches push, the WebView, the editor or
  native modules gets a line in the PR saying what was checked on which device
  and server (Stalwart version).
- **Close the loop.** At the end of a phase, update the counts table in
  `PARITY_CHECKLIST.md`.

## Phase 1: security and send correctness (detailed plan written)

Goal: nothing a sender writes can fool the user or redirect mail, and the app
never says "sent" when nothing went out. Size: about 3–4 days.

| Item | Area | Pri |
|---|---|---|
| Forged `Authentication-Results` can supply a DKIM/DMARC pass | 03 | P1 |
| Refused recipients in `deliveryStatus` never reported (#1123) | 04 | P1 |
| Escaped quote in a display name splits off a recipient | 04 | P1 |
| Send with no `EmailSubmission/set` response counts as success | 04 | P2 |
| Sieve values unescaped; rule names with spaces duplicate | 07 | P2 |
| No `stop` after discard/reject; `field: 'all'` and `address_is`/`domain_is` break native saves | 07 | P2 |
| `mailto:` unsubscribe to several addresses, not shown | 03 | P2 |
| Crafted `winmail.dat` freezes the app | 03 | P2 |

## Phase 2: data correctness

Goal: no write the app makes is silently refused by the server, put in the
wrong account, or rewritten. Size: about 4–5 days.

| Item | Area | Pri | Note |
|---|---|---|---|
| Contacts with calendar/scheduling/free-busy URIs fail to save | 06 | P2 | Port webmail `lib/jmap/contact-wire.ts` as `src/lib/contact-wire.ts`. One mapping layer feeds the next item too. |
| vCard import sends fields Stalwart rejects | 06 | P2 | Same wire layer: `addressToWire`. |
| Address book delete refused while it has contacts | 06 | P2 | `onDestroyRemoveContents: true` behind the existing confirm. |
| Cross-account move loses the message date (#1150) | 02 | P2 | Pass `receivedAt` to `Email/import`. |
| Open draft follows an account switch into the wrong account | 04 | P2 | Capture `accountId` when the composer mounts. Thread it through `createDraft`/`sendEmail` (`SendEmailOptions.accountId` exists). |
| Filters / security screens keep the previous account's data after a switch | 01 | P2 | Reset the stores in `switchAccount`; key the effects on the account id. |
| iCal subscriptions not tied to the login | 05 | P2 | Key on server URL + username; forget on sign-out. Needs a store migration. |
| Sign-out leaves search history, offline bodies and outbox keys behind | 01 | P2 | One `forgetAccountData(accountKey)` called from logout and removeAccount. Pairs with the iCal item. |
| Daily recurrence stops at a DST change | 05 | P2 | Port webmail `recurrence-expansion.ts:420-444`. Tests in Europe/Berlin and America/New_York. |
| Save without invitations when the server refuses scheduling | 05 | P2 | `SchedulingDeniedError` + "Save without sending" alert. |
| Blank participant names in invitations (#748) | 05 | P3 | Same files as above. |
| Files: smaller 1.11 fixes (rename-on-exists, copy folders, pre-0.16.6 rights, MIME type) | 07 | P3 | |

## Phase 3: reliability and honest feedback

Goal: when something fails, the user finds out, and background features keep
working past a week. Size: about 4 days.

| Item | Area | Pri | Note |
|---|---|---|---|
| Push subscriptions lapse after Stalwart's 7-day expiry | 08 | P2 | Renew on foreground and for every signed-in account. Needs a device check over more than 7 days, or a server with a short expiry. |
| List actions (swipe/batch) fail silently | 02 | P2 | Catch, toast and revert the optimistic change, the same way the viewer already does. |
| A failed search shows the previous folder's rows | 02 | P2 | |
| Search doesn't leave out Spam and Trash | 02 | P2 | |
| TOTP accounts cannot change password or turn TOTP off | 01 | P2 | Prompt for the current code. |
| Internationalized domains (#1100) | 01 | P2 | Check what Hermes `URL` does first; add a punycode dependency only if needed. |
| Tag views/counts include Trash and Spam (#1156); list Move sheet not account-scoped (#1149) | 02 | P3 | |
| Failed preview lookup drops the push; one message rings once per account | 08 | P3 | Android module + background task. |
| Sent-copy filing warning not shown; `Email/set` create can be replayed | 04, 09 | P3 | |
| Mail deleted during a refresh reappears (#966); scroll position and unread-first jumps (unverified) | 02 | P3 | Confirm on a device before fixing. |
| Refused TOTP token exchange gets a generic error; empty name for non-admins | 01 | P3 | |

## Phase 4: new webmail features that matter on a phone

Goal: the features users of the current webmail will expect in the app.
Each item is a small sub-project with its own plan. Do them in this order.

| Item | Area | Pri | Size |
|---|---|---|---|
| Verification-code copy chip (viewer + list, setting) | 03 | P2 | S–M |
| "Rules" from a message, with retroactive apply and undo | 03, 07 | P2 | L. Builds on the Phase 1 Sieve work. |
| Offline send queue (outbox op carrying the Email/set + submission) | 04, 09 | P2 | L |
| Contact autocomplete: groups, recent recipients, server and directory search | 06 | P2 | M |
| Server-side invitations (`CalendarEventNotification`) inbox | 05 | P3→P2 | M |
| Join links and maps in events; working-hours day/week views; tasks in the month view; collapsible all-day strip | 05 | P3 | M |
| Copy messages to a folder / another account | 02 | P3 | M |
| Sign in with an access token; keep cross-origin session URLs | 01 | P3 | S |
| Inbox-only notifications option (#983) | 08 | P3 | S |

## Phase 5: platform gaps (need work outside this repo)

These have been deferred because each needs something outside this repo. Plan each
one with the owner of that other piece.

| Item | Area | Pri | Dependency |
|---|---|---|---|
| iOS push | 08 | P2 | APNs transport in the push relay + an iOS token module |
| Cross-device settings sync (native #1); unblocks template and tag sync | 08, 04, 02 | P2 | A server-side settings store both clients can use |
| RTL completion (swipe directions, drawer side #944) | 08 | P2 | Device check in ar/he |
| Remaining calendar i18n; Jalali grid | 05 | P2/P3 | Port `jalali-utils.ts` |
| S/MIME sign/encrypt on send | 04 | P3 | Raw-MIME send path |
| Sending from shared/group accounts | 04 | P3 | Envelope/identity routing |

## Phase 6: P3 backlog

Pick these up when you are working on the same files anyway. Group them so
each sweep stays in one area:

- **Mail list and search (02):**
  - search snippets highlighted, size filter, nested folder picker, colours for unknown tags, row screen-reader labels, attachment-chip placeholders;
  - no wildcard suffix in search, empty any folder, folder sharing, folder reorder, folder icons, tag nesting;
  - the date-locale setting;
  - two decisions: last folder vs inbox on start, and global search.
- **Composer (04):** DSN/REQUIRETLS, Return-Path note, pasting a list, @-mentions, font size (audit-2026-09), identity refresh.
- **Viewer (03):** wrapping fixed-width tables on iOS, and what remains of the invitation banner.
- **Calendar (05):** free/busy, default ParticipantIdentity, duplicate/copy title/add note, `supported-calendar-component-set`, deep links to dates, the push types, birthday colour.
- **Contacts (06):** sharing an address book, list filters, deep links.
- **Filters and files (07):** redirect-limit warning, auto-reply length warning, legacy flat-name migration, Files deep links.
- **Settings and UI (08):**
  - settings-search entries, About build link, font size everywhere, status/navigation bar theming, sidebar apps, the relay list;
  - from audit-2026-09: icon badge, themes, Tabler icons, the favicon source.
- **Security (09):** a screenshot / recent-apps protection option.
- **Accounts (01):** ending the SSO session on sign-out, and the settings scope of shared accounts.

## Phase 1 follow-ups (left open at merge, 2026-10-04)

Phase 1 is done on `parity/phase-1-security-send`. The final review rated the items below "later". Pick them up with Phase 2 or when working in the same files.

- **Before release, on a device:**
  - Rule editor: create an "All messages → Mark as read" rule on the phone, confirm webmail shows the same rule, then save it once from each side; the script must not grow.
  - A size like `1.5M` is refused with an alert.
  - Send to a non-existent address alone (alert, composer stays open, nothing in Sent), then together with a real one (warning toast, message in Sent).
  - Upstream to webmail: the same two input-validation gaps exist there:
    - an invalid filter size is written as `0`, so "greater than" matches every message;
    - the loose `isValidEmail` in `parseUnsubscribeMailto` lets `, < > : ;` and bidi characters through after decoding.
- **Authentication-Results:**
  - Known limitation, the same as webmail: if the receiving server adds no Authentication-Results header, the sender's own header is treated as topmost.
  - Follow-up for both clients: trust only a configured or learned authserv-id per account.
  - Tests to add: `;` inside quotes or comments, `dkim/1=`, uppercase results, empty or authserv-id-only headers, a lower `iprev=pass` being ignored, a lower `spf=fail` escalating through `getEmailAuthenticationResults`.
- **Send:**
  - Inline `deliveryStatus` shape vs the unexported `DeliveryStatus` type in `src/api/jmap-result.ts`.
  - Test `sendErrorAlert` with several refused recipients.
  - The unsubscribe banner shows a generic error for an unconfirmed send.
- **Sieve:**
  - Commit a webmail↔native round-trip fixture covering `all`, `address_is`/`domain_is` and discard + stop.
  - Tests:
    - an empty or whitespace-only rule name;
    - a metadata-less `if true` / `address` script resaving byte-identically;
    - a custom header with `address_is`;
    - an attachment `has_any` row switched to From.
  - The "condition with a value is required" alert text.
  - The parser reads back only plain-digit sizes (as webmail does).
  - An empty size row is silently dropped.
- **Recipients:** the colon test doesn't reach `findTopLevelColon` (the input needs a trailing `;`).
- **Unsubscribe:**
  - Uppercase `MAILTO:`/`HTTPS:` are ignored. *(Fixed in hardening pass 1.)*
  - The first mailto that fails the strict parse hides the banner even when a later one would work. *(Fixed in hardening pass 1.)*
  - There are three copies of `parseMailtoUrl`/`isValidEmail` (`unsubscribe.ts`, `mailto.ts`, `recipients.ts`). *(Fixed in hardening pass 1.)*
- **TNEF:**
  - Add a positive multi-value parse test.
  - Port webmail's truncated-attribute test.
  - Assert on parse results, not only on timing.
- **Calendar trust:** `hasVerifiedAuthentication` accepts an unaligned DKIM/SPF pass (as webmail does).

## Phase 2 follow-ups (left open at merge, 2026-10-04)

Phase 2 is done on `parity/phase-2-data-correctness`. The final review left these open.

- **Fix before or right after merge:**
  - A vCard with both `ORG-DIRECTORY` and `SOURCE` loses SOURCE on import. *(Fixed in hardening pass 1.)*
    - The `directories` guard in `src/lib/contact-wire.ts` skips the flat `source` whenever the card already has a `directories` map.
    - Webmail adds both.
    - Fix: for `directories` only, add the source entry unless a `kind: 'entry'` with that URI already exists. Add a test for `{ directories: { d0 }, source }`.
- **Device checks:**
  - **Contacts:**
    - Edit one of two calendar links, refresh, and both must still be there.
    - Import a vCard that has `ADR`, `CALURI` and `SOURCE`.
  - **Composer:**
    - Switch account from a notification while a reply is open: send, save and attach must be blocked, with "Switch to …".
    - Remove the original account: Discard and "Copy text and close" must work by back gesture and header X.
  - **Calendar:**
    - On Stalwart 0.16.21+, saving an event and a "this and following" edit must offer "Save without invitations".
- **Architecture:**
  - Give the composer its own JMAP client, so a draft can be sent from an account that isn't active. Today the composer blocks instead (ruling R7).
  - The undo-send bar has the same issue after a switch.
- **Sign-out:**
  - A launch-time sweep should remove offline-cache keys for accounts no longer in the registry. That covers failed cleanups and orphan bodies.
  - Cap the age of kept outbox ops.
  - Usernames that differ only by case get orphaned outboxes.
- **Calendar subscriptions:**
  - Legacy subscriptions whose calendar was deleted, or renamed while several accounts are signed in, stay stuck.
  - An in-flight `syncFeedIntoCalendar` across an account switch runs its delete diff against the new session. Give this priority. *(Fixed in hardening pass 1.)*
  - `syncAll` has no connection guard. *(Fixed in hardening pass 1.)*
- **Calendar:**
  - Deleting "this and following" has no fallback when invitations are refused.
  - Generic alerts show the bare server reason (`forbidden`).
- **i18n:** the composer's account-changed and account-unavailable strings exist only in English. `i18n:check` covers English only.
- **Tests:** the screen wiring for the composer, calendar fallback and Files has no test harness, so it is covered by typecheck and device checks only.

## Phase 3 follow-ups (left open at merge, 2026-10-04)

Phase 3 is done on `parity/phase-3-reliability`. The final review rated these "later".

- **Before release:**
  - Run an Android build or CI. The Kotlin changes in `BulwarkFcmModule.kt` (the `silent` flag) and `NotificationTapStore.kt` (taps without ids) were not compiled here.
  - Device checks:
    - Two accounts, with the app brought to the foreground after moving the clock 6 days forward: both keep getting notifications.
    - One message sent to two accounts rings once and shows two notifications.
    - Tapping a generic "New email" opens Mail.
  - Release note: an account first added under a Unicode domain becomes a second account when the user signs in again, because the stored username is now ASCII. That account's calendar subscriptions are orphaned by owner.
- **Push:**
  - The generic tap opens the Mail tab rather than forcing the inbox.
  - Ids are not remembered after a generic notice.
  - The group-summary tap now switches account. The exported activity accepts an `accountId` extra; impact is low.
  - A label that matches two servers still counts both as addressed.
  - `notUpdated notFound` on renewal retries every 15 min.
  - Setup from settings or onboarding doesn't call `markPushRenewed`.
- **Mail list:**
  - The selection is cleared after a failed bulk action. *(Fixed in hardening pass 1.)*
  - A failed cross-account move shows no toast. *(Fixed in hardening pass 1.)*
  - A failed search while offline shows the "nothing cached" text.
  - There is no default-scope chip.
  - The widgets' unread tag query uses `limit: 0` (`src/widgets/jmap.ts:282`).
- **Accounts:**
  - TOTP code fields aren't cleared after a failed submit. *(Fixed in hardening pass 1.)*
  - `otpEnabled` is briefly stale after a toggle.
  - The `disable_hint` text doesn't mention the code.
  - An email address ending in a dot (`ada@example.com.`) is rejected. *(Fixed in hardening pass 1.)*
  - The TOTP step shows the punycode address. *(Fixed in hardening pass 1.)*
- **Calendar:** in `addSubscription`, the catch path's `deleteCalendar` is not guarded against an account switch. *(Fixed in hardening pass 1.)*
- **Tests:** no render harness, so the wiring in the composer, security page, MoveSheet and calendar is covered by typecheck and device checks only.

## Phase 4a follow-ups (left open at merge, 2026-10-04)

Phase 4a is done on `parity/phase-4a-features`. The final review rated these "later".

- **Before release:**
  - Device check: sign in to Fastmail with an API token. The inbox loads, an attachment downloads and an upload works (the upload uses the kept off-origin `uploadUrl`).
  - Device check: the working-hours grid's earlier/later indicator sits above event blocks on Android, and the all-day "+N" toggle is easy to hit.
  - Release note: working hours are on by default (08–20), as in webmail, so the day and week grids change on upgrade.
- **Upstream (webmail):** four quadratic regexes on sender text. Two are in `lib/verification-code.ts` `normalize()` (`/[\p{L}\p{N}-]*(?:\.\.\.|…)\s*$/u` and `/\S*@\S+/g`). One is the trailing-punctuation regex in `lib/event-links.ts`. The fourth is the pre-existing `MEANINGFUL_HTML_RE` shape, fixed natively in 2a37bb5.
- **Locales:** the vendored webmail locale predates 7e1a659, so several webmail keys were added to `locales/rn/en.json` with webmail's English. Run `sync-locales` to bring in their translations.
- **Push:**
  - Non-active accounts keep their old Inbox-only filter until they are next active (`renewDetachedPushSubscription` writes only `expires`). *(Fixed in hardening pass 1.)*
  - A primary account with no Inbox in Inbox-only mode makes setup throw, as in webmail; the old subscription keeps working.
  - A failed re-sync only warns, so the toggle can show on while the server filter is unchanged.
  - Settings `hydrate()` is not single-flight. *(Fixed in hardening pass 1.)*
  - FCM and SSE both dispatching a change can fire bus listeners twice (a duplicate refetch only).
- **Mail:**
  - The list chip has no long-press forward.
  - The chip goes stale across the one-day boundary until the row re-renders.
  - The viewer's detail-cache patch after a copy uses the passed email's `mailboxIds`.
  - Error classification in token sign-in matches message text (the 403 discovery text and the missing-account text); a typed error would be sturdier.
- **Calendar:**
  - Invitation notices already seen survive sign-out until restart.
  - A notice whose destroy failed can toast once more after a restart.
  - Tasks are not shown in the all-day strip.
  - The calendar's `ParticipantInput` offers contacts only.
  - The location row has no link styling or long-press accessibility hint.
  - The rules in CalendarSettings (end after start, last working day) are inline and untested.
  - The all-day cap follows the settled scroll anchor, so it lags a drag by up to one column.
  - The "N more calendar updates" summary toast offers Open even while the client is mid-switch; the notice presenter has no test.
- **Composer:**
  - The "Search the server" row shows even without a Sent mailbox (as in webmail).
  - The search handling in ComposeScreen has no test.
  - Directory suggestions load only when the account entry's username and server match the client's exactly. A trimmed or untrimmed username would quietly hide them. *(Fixed in hardening pass 1.)*
- **Tests:** the wall-clock timing tests now allow 1 s, against 2.8–22 s for the old quadratic cases.

## Phase 4b follow-ups (left open at merge, 2026-10-04)

Phase 4b is done on `parity/phase-4b-rules-outbox`: rules from a message, and an app-only offline send queue. The offline send queue's design changed during execution: a send whose outcome is unknown is never resent automatically, and the user decides in the Outbox. The plan's Task 8 note and the ledger rulings R12, R14, R15, R18 and R19 record this. The final review rated the following "later".

- **Before release (device checks):**
  - **Airplane mode:** compose and send, then reconnect. The message arrives once.
  - **Kill mid-send:** kill the app right after reconnecting while a large message sends, then reopen. It is not sent twice; it is either completed from proof or left as "may have been sent".
  - **Another account:** with a send queued for account A, switch to B and reconnect. The send waits for A, and the Outbox says so.
  - **Rules from a newsletter:** use "Always move messages from this list", apply it to existing messages, then Undo. The rule is gone from Filters, and the moved messages stay moved.
  - **Narrow phones:** the Rules icon in the selection bar does not crowd it.
  - **Stalwart support:** check `EmailSubmission/query` with an `emailIds` filter, `calculateTotal`, and that submissions return `identityId`. If any of these is missing, a proof lookup leaves an entry "may have been sent" for the user.
- **Upstream (webmail):** a fifth quadratic regex, `stripSubjectPrefixes` in `lib/filters/quick-rules.ts`, on long runs of spaces. Report it with the four from Phase 4a.
- **Send queue:**
  - The proof lookup pages by position, so a deletion between pages can skip the proof copy. "Send again" then resends after the user's confirmation.
  - A send is held when its account is unavailable, and it then waits for the user's Retry even after the account is back. *(Fixed in hardening pass 1.)*
  - "Send again" within 2 minutes of an attempt shows the generic "could not check" text. *(Fixed in hardening pass 1.)*
  - A failed lookup still stamps the 15-minute backoff. *(Fixed in hardening pass 1.)*
  - Rows that are corrupt on disk are counted at sign-out and in the widget. *(Fixed in hardening pass 1.)*
  - Toasts for failed, uncertain and held sends repeat once per launch.
  - A draft still can't be saved offline.
- **Rules:**
  - Undo's check-then-write is not atomic; it needs `ifInState`, as in webmail.
  - `fetchFilters` replies can land out of order: a push refetch after Undo can put the undone rule back into the Settings screen's memory. *(Fixed in hardening pass 1.)*
  - The presets can be tapped before the hand-edited-script check returns; the write still refuses.
  - The rules target snapshots the mailboxes when the sheet opens.
  - There is no "New folder…" in the rule pickers, and no "Edit rule" toast action.
  - RulesFlow and the Outbox screen have no render tests.

## Hardening pass 1 (merged from `parity/hardening-1`, 2026-10-06)

The pass closed the items marked *(Fixed in hardening pass 1.)* above, and two problems found along the way.

**The device test of 2026-10-06.** A mail server on the local network can fail Android's internet probe. The app now counts the server answering as being online, and it keeps retrying a missing session on a backoff.

**Account isolation in the JMAP client.** A background security check flagged one account's credentials reaching another account's server during account switches. The client now holds one connection context `{gen, credentials, session, accountId}`, which is swapped atomically.
- Every request, and every multi-request operation, is pinned to the connection it started on, and refused before sending (`StaleLoadError`) if a newer connection replaced it.
- Actions on the account the app shows wait until the client serves it.
- Folder actions, the viewer, undo-send, archive reorganising, read receipts, scheduled sends, widget actions and quick reply are tied to their own account.
- Probe suites check that no host ever receives another account's header or ids. The main one is `src/api/__tests__/jmap-client-no-mixed-accounts.test.ts`.

Follow-ups left open:

- **Before release (device checks):**
  - A server on the local network with no internet access: send, receive, and recovery after the server restarts.
  - Switch accounts while a message is open, while a folder is being emptied, and during a slow cross-account move.
  - Widget archive and trash while the app switches accounts.
- **Account isolation:**
  - CalendarScreen's event detail sheet isn't tied to an account. Delete or edit after a switch can act on the other account's same-id event.
  - The contacts, sieve, identity and vacation API helpers use the live client unscoped. Their stores reset on a switch, so the risk is low.
  - Reply or forward, unsubscribe-by-mail and the invitation's Import/RSVP from a viewer left open across a switch act in the account now shown.
  - A delegated shared account can finish part of an operation as B on A's account. The effect is on the intended account; only the attribution differs.
  - An A→B→A switch during a calendar feed sync passes its check.
- **Smaller:**
  - "Always" read receipts during a switch show an error once and don't retry.
  - An undo-send in flight when a switch lands cancels the send without reopening the draft.
  - ScheduledScreen's Edit reads the account after an await.
  - The open viewer refuses changes after a switch rather than queueing them, and drops its delayed mark-read.
  - Legacy outbox ops and stamped ones aren't coalesced.
  - The selection after a partial cross-account failure.

## Phase 6a follow-ups (calendar sweep, 2026-10-06)

Phase 6a is done on `parity/phase-6a-calendar`. Every calendar write and load is now tied to its own account:
- writes take an account captured before any wait and checked at each write (`withCapturedAccount`);
- loads that outlive a switch are dropped (`beginLoad` / `loadIsCurrent`);
- widgets load the account they ask for.

That closes the Hardening pass 1 calendar follow-up. Left open:

- **Not in scope:**
  - `supported-calendar-component-set` at calendar creation (needs a CalDAV client);
  - the Jalali grid (needs the `fa` locale);
  - calendar types in the background push subscription.
- **Small:**
  - The drawer's colour option for the birthday calendar (webmail picks it there; native has the setting).
  - A recurring note is lost if its scope dialog is cancelled.
  - With the app closed, participant identities aren't fetched (widgets don't use them).
  - `queryEvents` / `getMasterEvent` reads use the live connection, while their writes are pinned.
  - The recurrence summary test is English only.
- **Device checks:**
  - free/busy against Stalwart (`Principal/getAvailability` account and `showDetails`);
  - the task circle and strike-through layout;
  - the calendar and task widgets refreshing with the app closed;
  - a note on an event with guests sends no mail.
- **Tests:** CalendarScreen, EventModal, the invitation banner and the task circle wiring have no render-harness test.

## Phase 6b follow-ups (mail list, search and global search, 2026-10-06)

Phase 6b is done on `parity/phase-6b-mail-list` and closes 13 items in area 02:
- search sends terms as typed, filters by size, highlights matches, and scopes to any folder from a tree;
- empty folder works on any folder;
- list polish: tag colours, previews, screen-reader labels and actions, steady rows;
- the Inbox opens on start;
- global search covers mail, contacts, calendar and files.

Account identity fixes that came out of the reviews:
- a search scoped to another account's folder now stamps its rows with that account;
- Trash and Junk are found by role or exact name only (a folder named "Robin" was treated as Trash, and deleting from it destroyed mail);
- a contacts load an account switch overtook no longer lands in the new account.

Left open:

- **Small:**
  - A screen reader's "Open attachment" actions appear only once the row re-renders after its chips load.
  - After a failed chip fetch, a row shows no chips until it remounts; there is no retry when the network returns.
  - Selection mode still offers the chip and copy-code actions.
  - Global search checks cancellation only when a read returns. Mail targets run in parallel.
  - The local pass checks `body:` against the preview.
  - Re-opening global search with the same query doesn't reset an edited field.
  - Emptying Trash or Junk says nothing if an account switch stops it partway.
  - Cold start can briefly show the last folder before the Inbox.
  - Unified rows are not tinted with their account colour.
- **Tests:**
  - No provider test drives global search's local pass over a search scoped to another account (covered through `accountIdOfRow`).
  - No render-harness test for the global search screen, the folder picker, scroll-to-top or the row accessibility actions.
- **Device checks:**
  - the folder picker sheet nested in the filter dialog on iOS;
  - the row accessibility actions with VoiceOver and TalkBack;
  - empty folder on a server with no Trash role;
  - opening a global search hit from another account.

## Phase 6c follow-ups (composer and contacts, 2026-10-07)

Phase 6c is done on `parity/phase-6c-composer-contacts`. It closes 9 items across areas 04 and 06, plus webmail's new "Attach from Files" (#1179).

**Composer:**
- identity refresh;
- DSN and REQUIRETLS;
- sending as the From override with the identity as fallback;
- pasted lists;
- @-mentions.

**Contacts:**
- address book sharing;
- list filters;
- event-guest suggestions;
- new and edit contact links.

The webmail locale catalogs are re-vendored at `ccf6bf7`. `scripts/sync-locales.mjs --from <dir>` now works without the parent repo.

**Fixes that came out of the reviews:**
- The contact edit form deleted the photo, and overwrote newer fields, when it was seeded from the cached card. It could also take another account's card that had the same id.
- "Send now", Reschedule and undo dropped REQUIRETLS and DSN.
- A send reported as both created and refused could have been submitted twice.
- The composer's attachment preview, and its inline-image fetch, read from the live account rather than the composer's own.

Left open:

- **New parity item:** vacation forwarding and reply audience (07, #1152).
- **Deliberate divergences:**
  - only the sending account's own files can be attached;
  - the mention list is tap-only;
  - picking a group as an event guest adds its members;
  - editing a contact needs a live load from the server.
- **Small:**
  - The reschedule refusal text is English.
  - The contact form's "couldn't load" reads the store's shared error.
  - The edit screen doesn't retry on its own after a failed load beyond reconnect.
  - A paste that lands while focus is elsewhere can't be undone.
  - A mention pick is dropped if a pending paste split the text node.
  - The Files picker dedupe doesn't survive reopening a draft.
  - UpdatesSettings keeps its own byte formatter.
  - The identity of a wildcard (`*@`) From gets no fallback notice.
- **Tests:** there are no render-harness tests for ContactForm, ParticipantInput, the filter and share sheets, the mention list, the Files picker or the toolbar toggles.
- **Device checks:**
  - iOS: does paste fire with `clipboardData` from the long-press menu;
  - undo after an async paste;
  - Hermes NFD folding in mention search ("jose" finds "José");
  - an IME composition during a mention pick;
  - whether tapping a mention row blurs the WebView;
  - the Files picker opening after the Attach menu on iOS;
  - DSN and REQUIRETLS against Stalwart;
  - a From override that Stalwart refuses, falling back to the identity.

## Device check pass 1 (2026-10-07)

Run on the Android 17 x86_64 emulator and a Galaxy S24+ (SM-S926U, Android 16), against Stalwart at `mail.home.brytelands.io`, on branch `fix/device-checks-1`.

**Bugs found and fixed:**
- **Cold start crash** (fixed in `80217dd`, merged with 6c). Rows drawn from the saved list asked `jmapClient.accountId` before connect.
- **Actions dropped after every cold start.** Move, flag, archive and delete changed the list on screen, then came back on the next refresh. The outbox and offline cache were never pointed at the account when the persisted state already named it (`[outbox] enqueue with no active account; dropping op`).
- **Composer opened offline couldn't send or queue.** It had no identities; they are now cached per app account and cleared on sign-out.
- **Raw placeholders.** The folder form showed "Inside {name}", and a move with no folder name showed "{count} emails moved". A scan of every `t()` call without params against the catalog found no others.

**Passed:**
- **Sending:**
  - offline send queue: opened online, sent offline, delivered once;
  - kill right after reconnecting: 3 runs, each delivered once;
  - DSN and REQUIRETLS: Stalwart accepted both, and the DSN came back;
  - From override: the notice shows and the message is delivered once. Which path ran isn't visible, because Stalwart stores no Return-Path on local delivery.
- **Composer:**
  - @-mention pick by tap;
  - accent folding, so `@jose` finds José on the S24+;
  - pasted lists on the S24+.
- **Mail list and search:**
  - new-contact deep link;
  - global search open;
  - empty an ordinary folder into Trash.
- **Notifications, with the app fully closed:**
  - the push posts a notification and the home widget updates;
  - tapping the notification opens the message.

**Not reproducible:** Back from a composer with unsaved text after a cold start exits the app on the emulator, but only with `adb input text` key injection. With a real keyboard on the S24+ the save-or-discard prompt shows.

**Still to check:**
- **Two accounts:** a switch in the middle of an action; a queued send waiting for its own account; global search hits from another account.
- **Accessibility:** TalkBack row actions.
- **Offline cold start:** send from the composer. The composer owner has no JMAP account id until the client connects, so the queue refuses.
- **Contact edit link:** no UI shows a contact id.
- **iOS:** everything.

**Note:** the folder form needs two taps on Save while the keyboard is open; the first only dismisses the keyboard.

## Phase 6d follow-ups (filters, vacation and Files, 2026-10-07)

Phase 6d is done on `parity/phase-6d-filters-files`. It closes every area 07 item and fixes a live data risk.

**The data risk:** native treated webmail 1.13.0's v2 filter scripts (rule periods, vacation forwarding, reply audience) as hand-edited. Turning the auto-reply on from native then let Stalwart's vacation script take over, which stopped every filter. Native now does these:
- **Reads and writes v2:** native round-trips v2 byte for byte (checked against webmail's own generator on 4000 random scripts).
- **Syncs the vacation script safely:**
  - it syncs on one connection scope;
  - it refuses to save before anything is written when it can't keep the filters running;
  - it never refuses to turn the auto-reply off;
  - it reports filters that the vacation script stopped.

**What's new for users:**
- Out of Office forwarding and "Reply to" (all, internal or external).
- Warnings for the server's forward limit and for Stalwart's auto-reply size limit.
- Rule active periods.
- Files links that open a folder and preview a file.
- A dismissible Files storage notice.
- Sending after an offline cold start: the JMAP account id is recorded per app account.
- All-mail search includes Sent.

**Also fixed:** turning off "include spam" on a rule didn't stick. A save that left the field out was merged back over the old value.

Left open:

- **New parity item:** the unverified-sender warning (03, webmail 1.13.0). Its 7 keys aren't vendored yet.
- **By decision:** legacy flat-name Files migration stays webmail-only.
- **Webmail parity, worth raising upstream:**
  - a hand-edited `# Vacation forwarding` block is regenerated from the metadata;
  - "internal senders" can mark the form dirty when identity domains change.
- **Small:**
  - A queued send held with a stale recorded JMAP id has no automatic re-stamp. It shows in the Outbox; discard and resend.
  - The vacation size check reads the saved HTML state, not the live editor, at the moment of Save.
  - On a shared account, a stored forward is hidden, as in webmail, and left untouched.
- **Tests:** no render-harness tests for VacationSettings, FilterRuleModal (period pickers), RulesFlow, or the Files notice and links.
- **Device checks:**
  - Out of Office forwarding and audience against Stalwart: the forward arrives, keep-copy works, and an internal-only reply skips an external sender;
  - a filter rule period starting and ending on time;
  - the date picker inside the rule editor on iOS;
  - a Files link from another app;
  - an offline cold start, then send, then reconnect: delivered once.

## Phase 6e follow-ups (settings, UI and security, 2026-10-08)

Phase 6e is done on `parity/phase-6e-settings-ui`. It closes the open items in areas 01, 02, 03 and 09 and most of area 08.

**What's new for users:**
- A warning on a message whose sender could not be verified, with no "Always trust this sender" for it.
- Two device-local privacy toggles, both off by default: block screenshots, and hide in recent apps. The system bars follow the theme.
- Signing out ends the identity provider's session, but only with the last account that uses that provider.
- Rename and recolour a shared account's calendars and address books from settings (decision 2026-10-08).
- The font size setting scales the whole app.
- A push relay per account.
- Sidebar apps show on mobile, and open only web links.
- Settings search finds more settings, and About links the running build's commit.
- A date format region and an app-wide time zone, under Language & region.
- Folder links open their folder.

Left open:

- **Upstream request:** webmail's `/api/admin/policy` should serve `pushRelays` and `defaultSidebarApps` to bearer-token clients. It blanks both for non-cookie clients, so the admin relay list and admin sidebar-app defaults can't be read from native. The push relay item in 08 stays open for this.
- **Stalwart OIDC:** Stalwart's built-in OIDC advertises no `end_session_endpoint`, so provider sign-out does nothing there. It applies with external IdPs such as Keycloak and Authentik.
- **Device checks still to run:**
  - SSO sign-out against Keycloak on a phone;
  - `FLAG_SECURE` and hiding in recents on Android 13+;
  - font size Large with a large OS font (tab labels and the Mail badge, which is now drawn inside `tabBarIcon`; the bar stays 49 high, so the label may run about 5 px into the bottom inset), and the Mail unread count read once by TalkBack;
  - Hermes support for Intl `calendar: 'gregory'` and `\p{Nd}`;
  - the Android DateTimePicker with `timeZoneName`;
  - sidebar apps in a Custom Tab;
  - folder links on a cold start.
- **Follow-ups parked in the ledger:**
  - Trust-on-reply and calendar trust-on-RSVP still file a flagged sender as trusted, and an already-trusted forged address still auto-loads remote content. Webmail behaves the same. — done in 36e61ba, fbcffd2, a5ca1e3 and 165d0b2: a flagged or unverified sender is never filed as trusted on a reply or an RSVP, and a trusted address loads nothing unless the message passes
  - Pin the `authserv-id` when judging the sender check. Until then, a message the receiving server stamped no Authentication-Results header on is judged by the sender's own topmost header. — done in 6eebb6b and 7f4293e (only your own server's results count; limits are in the cleanup section below)
  - The sender check counts an SPF or DKIM pass only for the From domain, a parent or a subdomain of it (decision 2026-10-08, after the push security review). Webmail takes a pass for any domain, so a spoofer's own domain silences its warning when the forged domain has no DMARC record; worth raising upstream. Native's match is by suffix, not the organisational domain, so two sibling subdomains don't match. — sibling subdomains now align, done in 8f754a7 (public suffix list) and 6eebb6b
  - The shared-calendar colour override key (`accountId|originalId`) isn't scoped by app account. It's local only. — done in 55f5847, 4cf5188, abb81ab, 88701ba and aa70c66
  - A queued send held with a stale recorded JMAP id is not re-stamped automatically. — done in 3d444ed, d3c896a and 6161666 (a send that failed or went out once is left for you to retry)
  - The full list format's AM/PM is not in the region locale. — already in the region locale, as webmail; pinned by a test in f1541dc
  - The time zone list is hand-picked. — f1541dc and f0e29b9; Hermes has no Intl.supportedValuesOf yet, so devices keep the hand-picked list
  - The `selectMailbox` seed race (pre-existing). — done in 633a851 and 92761db (a stale snapshot tuck is still parked)
  - Two calendar-alert-scheduler tests fail under `TZ=Asia/Tokyo` (pre-existing). — done in 55f5847
  - Hand-off accounts whose host differs from the sign-in address are not counted by the provider-in-use check. Matching their stored `tokenEndpoint` origin as well would cover it. — done in 3d444ed and c79a6ee
  - About 60 inline `fontSize` literals across 29 files still ignore the font size setting, and the OS font scale still stacks with it (open product decision). — done in d1b30c7, 0a8b3a6, 9d82b0a, e455d30 and 4cf76ab (every screen follows the setting; the OS font scale is capped at 1.5 on body text)
  - Sidebar apps: no inline mode, and settings import doesn't filter invalid stored URLs (they're filtered at list and open time). — the import filter is done in f1541dc; inline mode stays open
  - A folder the user picks by hand while a cold-start link still waits is overridden when the link resolves. — done in 633a851
  - The shared-account calendar rename gate (`mayShare` or `mayWriteAll`) is unverified against Stalwart.
  - The orphaned RN key `settings.account.shared_accounts.description_manage` is left in the locale files. — already removed in c9e033d
  - `sync-locales.mjs --check` reports every locale stale because of line endings. — done in f1541dc
  - The end-session test helper imports `@babel/core` and two plugins that aren't direct devDependencies. The lockfile hoists them today; pinning them as devDependencies would keep it that way. — done in f1541dc
  - Local builds link the fork's origin from About, and an unpushed commit links to a 404. — done in f1541dc
  - The area 08 items for RTL drawer side, cross-device settings sync and iOS push stay open.

## Phase 7 follow-ups (the last parity items, 2026-10-09)

Phase 7 is done on `parity/phase-7-final-items`. It closes the last open items in areas 02, 03 and 05, and the RTL items in 08. 486 of 494 items are done; the 8 open ones are older and need work outside this phase.

**What's new for users:**
- Folders sort by their saved order and can be moved up and down in Settings (own folders only).
- An icon per folder, and a toggle for coloured sidebar icons. Icons are device-local.
- Tags can be hidden, reordered and nested, and show as a tree.
- Share a mail folder with other users, and a toast when something is shared with you.
- The invitation banner shows the sender and update number, folds away, opens its day in the calendar, and reviews and applies counter-proposals.
- The Persian (Jalali) month grid.
- Swipe actions, drawers and switches on the right side in right-to-left languages; swipes stay physical, as in webmail.

Left open:

- **Closed without building:** 05:249, calendar push types. Reminders refresh on launch, resume and device sync (decision 2026-10-09). A background refresh would need a Kotlin push route and a detached scheduler; a periodic reschedule is the cheaper option.
- **Scope of the new features:**
  - `mail:share` is advertised per account on Stalwart 0.16.25, not on the session, so the gate reads the account.
  - Folder `sortOrder` is not offered on shared folders; the right Stalwart checks are unverified.
  - Tag definitions and folder icons are device-local and not in the settings export.
  - Jalali covers the month grid, titles and stepping, not the agenda, the mini calendar or event dates.
  - Sending from shared accounts (04:74) is a separate phase.
- **Upstream requests to webmail:**
  - Counter-proposals: webmail applies one without checking who proposed it. The native fix requires the proposer to be a stored attendee, the From to be that attendee, and an authenticated, aligned pass.
  - The trust row for reply, counter and refresh must be anchored to the stored event.
  - An invitation whose UID matches an unrelated stored event must not answer it.
  - Stalwart's "Read only" folder share reads back as custom because of the seen/keywords coupling; native detects it, but the readback is Stalwart's.
- **Device checks still to run:**
  - the live folder move (it writes the server's sortOrder);
  - the folder icon picker and tag dots;
  - the share sheet, including the iOS share-after-dismiss path;
  - the Jalali labels in `fa`;
  - RTL on a phone (only an emulator in Arabic so far);
  - counter-proposal Apply against a real attendee;
  - the month back-arrow behaviour.
- **Follow-ups parked in the ledger:**
  - The public suffix list for domain alignment: `domainsAlign` matches by suffix, so sibling subdomains and shared suffixes are not told apart. — done in 8f754a7 (tldts); the snapshot goes in the dependency routine, see below
  - A session re-fetch when a share arrives from a new owner. — done in c40c5b4, 781c7a3 and cea5c29
  - A raw unknown share `objectType`. — done in c40c5b4
  - Icons left behind by a session-expired eviction. — done in 3d444ed
  - Settings chevrons in RTL. — done in 633a851 and 92761db (the drawer's too)
  - Per-tag collapse in the drawer. — done in 633a851 and 92761db
  - The back-arrow remount: grow `before` instead of opening a fresh window. — done in 55f5847
  - An iOS `onDismiss` fallback timer for the share sheet. — done in f1541dc (still to check on an iPhone)
  - Calendar notice toasts waiting for room (the presenter now waits, but a long wait is not capped). — done in c40c5b4 and 781c7a3 (capped at 60 s, then acknowledged silently)
  - The `selectMailbox` seed race (pre-existing). — done in 633a851 and 92761db (a stale snapshot tuck is still parked)
  - Commit 41ab162 fails the gate on its own (1b3a649 restores the key); offer to squash it at merge.
  - The behaviour changes the final review accepted: an unknown iTIP method with no authentication shows "authentication missing", and the banner shows the stored location and link for an event already in the calendar.

## Follow-up cleanup 1 (2026-10-09)

Done on `cleanup/follow-ups-1` (everything after afcf7b3). It closes the follow-ups the Phase 6e and Phase 7 lists above mark done, and three product decisions: the font size covers the whole app, the sender check reads only your own server's results, and a flagged sender is never trusted by replying.

**What's new for users:**
- The font size setting reaches every screen, and a large system font no longer overflows body text, badges, the inbox search box or the month view's event rows (the system font is capped at 1.5 times on body text).
- The sender check reads only the results your own server stamped. A forged message, or a trusted address on one, loads nothing.
- Trusted senders' images load only on a message that passes, and "Always trust this sender" is offered only then. A trusted sender whose message couldn't be verified says so once.
- Replying to, or answering an invitation from, a flagged or unverified sender never makes them trusted, and a Reply-To outside the sender's domain is not trusted.
- Sibling subdomains of one organisation count as the same sender; a stranger on a shared suffix (such as `co.uk`) does not.
- Shared calendar colours are kept per account, and cleared on sign-out. Settings export carries only the shown account's.
- Signing out, or an expired session, finishes forgetting the account's data even when the device cleanup hangs, and never erases an account signed straight back in.
- A queued send that failed or went out once is left for you to retry; one that never went out moves to the account's new id.
- A folder shared by a new owner shows up, calendar and share toasts no longer wait forever, and an unknown kind of share is named plainly.
- Collapsing a tag folds only that tag, a folder you pick beats a waiting link, and chevrons point the right way in right-to-left languages.
- Stepping back a month no longer reloads the grid. The time zone list is every zone the device knows, where the device can tell. Invalid sidebar apps are dropped on import.
- About links a commit only when it is on origin. Settings controls wrap below their text when the row is too narrow.

Left open:

- **Device checks still to run** (all earlier ones from Phase 6e and Phase 7 stay open too):
  - the font size at Large with a 2.0 system font, with calendar events and toasts on screen;
  - the settings-row wrap on a phone (checked on the x86_64 emulator only);
  - the month chips with events at Large and at a 2.0 system font;
  - the iOS share sheet and its fallback timer;
  - the font cap on a phone;
  - pinning against the real server's authserv-id (the `Authentication-Results` header on a received message).
- **Sender-check limits:**
  - Stalwart must stamp its own `Authentication-Results` on every received message, and strip incoming ones that claim its id. This is unverified. On a server that does neither, another local user can forge a pass.
  - Mail the server didn't stamp (same-server mail, for example) has no pass, so a trusted sender's images need a tap.
  - A host whose MX authserv-id is on another domain than the JMAP host loses sender checks.
  - A configured exact authserv-id is an option that would cover both of those.
  - An IP or single-label host (`192.0.2.1`, `localhost`) needs an exact authserv-id.
  - The trusted parent rule accepts sibling ids that exact-id stripping doesn't remove.
- **Accepted behaviour changes:**
  - trusted senders' images load only on a passing message, so on servers without usable results they never load by themselves;
  - "Always trust" is offered only on a pass;
  - reply-trust needs a pass;
  - sibling subdomains now align (DMARC relaxed alignment);
  - folders with an IP host need an exact authserv-id;
  - settings controls wrap below their text, so some rows look different at default sizes (Font Size's buttons, for one);
  - the RN patch that caps `Text` and `TextInput` at 1.5 must be refreshed on a React Native upgrade.
- **Follow-ups parked in the ledger:**
  - A durable forget-pending marker, so an app kill in the middle of a cleanup finishes it on the next start.
  - Held sends from before 6161666 have no `everAttempted` mark, so they are treated as never tried.
  - A restart that overlaps a second sign-in which holds no cleanup record can still lose one step.
  - Detached push clients learn a new shared account at the next resync.
  - The `coalesceByKey` note: it keeps a single trailing slot per key, and a burst can make two or more session refreshes.
  - The `selectMailbox` snapshot tuck (a stale snapshot can still be tucked; pre-existing).
  - The font guard test misses a non-literal `fontSize`.
  - The public suffix list (tldts) is a snapshot; add a refresh to the dependency routine.
  - A non-last sign-out leaves a parked shared-cleanup record until the next sign-in or sign-out.
  - The legacy `accountId|originalId` calendar colour key is still read by every account.
- **Upstream requests:** all of Phase 6e and Phase 7's still stand. Add: webmail treats the sender check as passing for any domain's SPF or DKIM, and trusts on reply.
- **Still open from before:**
  - sidebar apps' inline mode;
  - the shared-account calendar rename gate (`mayShare` or `mayWriteAll`) against Stalwart;
  - the 8 blocked parity items;
  - the `settings.themes.default_name` overlay key, which the webmail catalog now ships;
  - 41ab162 fails the gate on its own (squash at merge).

## Follow-up cleanup 2 (2026-10-10)

### Stalwart checks

Run on a throwaway local Stalwart (a copy of webmail's `integration/` setup, torn down afterwards).

- **Version:** Stalwart 0.16.25 (container log: `version = "0.16.25"`; `stalwart --version`).
- **`serverHostname`:** `mail.example.org`, then `mx.probe.test` for the second run.
- **Session `apiUrl`:** `https://mail.example.org/jmap/`, then `https://mx.probe.test/jmap/`. It follows `serverHostname`.
- **Inbound SMTP:** port 25 listens by default. It refuses a bare container hostname as the EHLO name (`550 5.5.0 Invalid EHLO domain.`), so B and D were sent unauthenticated on port 25 with EHLO `mx.external.test`. A and C went as alice over authenticated submission (587, published as 1025).
- **Probes.** Each item lists bob's `Authentication-Results` headers top to bottom (`header:Authentication-Results:asText:all`), then his `Received` headers.
  - A, local, plain: no Authentication-Results; no Received.
  - B, external, forged:
    1. `mail.example.org; spf=none (mail.example.org: no SPF records found for postmaster@mx.external.test) smtp.helo=mx.external.test; spf=none (mail.example.org: no SPF records found for sender@external.test) smtp.mailfrom=sender@external.test; iprev=pass policy.iprev=127.0.0.1; dmarc=none header.from=external.test policy.dmarc=none`
    2. `mail.example.org; spf=pass smtp.mailfrom=external.test; dkim=pass header.d=external.test; dmarc=pass header.from=external.test`
    3. `mx2.example.org; dmarc=pass header.from=external.test`
    4. `example.org; dmarc=pass header.from=external.test`
    - Received: `from mx.external.test (localhost [127.0.0.1]) by mail.example.org (Stalwart SMTP) with ESMTP id 4A2CBA3DEA00600; Fri, 9 Oct 2026 18:03:11 +0000`
  - C, local, forged:
    1. `mail.example.org; spf=pass smtp.mailfrom=external.test; dkim=pass header.d=external.test; dmarc=pass header.from=external.test`
    2. `mx2.example.org; dmarc=pass header.from=external.test`
    3. `example.org; dmarc=pass header.from=external.test`
    - No Received.
  - D, external, plain:
    1. `mail.example.org; spf=none (mail.example.org: no SPF records found for postmaster@mx.external.test) smtp.helo=mx.external.test; spf=none (mail.example.org: no SPF records found for sender@external.test) smtp.mailfrom=sender@external.test; iprev=pass policy.iprev=127.0.0.1; dmarc=none header.from=external.test policy.dmarc=none`
    - Received: `from mx.external.test (localhost [127.0.0.1]) by mail.example.org (Stalwart SMTP) with ESMTP id 4A2CB9F8FE00400; Fri, 9 Oct 2026 18:03:02 +0000`
  - D with `serverHostname` `mx.probe.test`:
    1. `mx.probe.test; spf=none (mx.probe.test: no SPF records found for postmaster@mx.external.test) smtp.helo=mx.external.test; spf=none (mx.probe.test: no SPF records found for sender@external.test) smtp.mailfrom=sender@external.test; iprev=pass policy.iprev=127.0.0.1; dmarc=none header.from=external.test policy.dmarc=none`
    - Received: `… by mx.probe.test (Stalwart SMTP) …`
- **(a) The id it stamps.** The topmost header on B and D has the authserv-id `serverHostname`: `mail.example.org`, and `mx.probe.test` once the setting changed. The SMTP banner and `Received` follow it too, and so does the session's `apiUrl`.
- **(b) Stripping.** None. On B, all three forged headers survived: the exact own id `mail.example.org`, the sibling `mx2.example.org` and the parent `example.org`. Stalwart puts its own stamp above them, so on mail from outside the topmost header is still its own.
- **(c) Local submissions.** Neither A nor C got a header from Stalwart. On C, the forged `mail.example.org; … dmarc=pass` is the topmost header, so a local user can forge a passing sender check under the server's exact id. Pinning to the exact id does not close this. Only the server can, by stamping or stripping on submission.
- **(d) Calendar rights.** Alice shared her default calendar with bob (`Calendar/set` `shareWith/d`). Bob then set `name` and `color` in her account:

  | Share | `myRights` Stalwart reports to bob | Rename | Recolour |
  |---|---|---|---|
  | read | read + free/busy only, every other flag `false` | `notUpdated: forbidden` ("You are not allowed to modify this calendar.") | `notUpdated: forbidden` |
  | readWrite | + `mayWriteAll`, `mayWriteOwn`, `mayUpdatePrivate`, `mayRSVP` | `updated` | `updated` |
  | manager | + `mayShare` | `updated` | `updated` |
  | manager+delete | + `mayDelete` | `updated` | `updated` |

  - Stalwart reports no `mayAdmin` key.
  - The name and colour are per user. After each of bob's writes, alice still read `Stalwart Calendar (alice@example.org)` and `color: null`.
  - When alice later renamed and recoloured it, bob still saw `probe-manager+delete` and `#ff0000`.
  - So `scopedCalendarActions` now offers the edit on `mayWriteAll` as well (readWrite).

Exact authserv-id setting: not needed — Stalwart 0.16.25 stamps its `serverHostname` and the session's `apiUrl` host follows the same setting, so a default single-host install pins with no setting; the local-submission forgery in (c) is under the exact id, which such a setting would not close either.
