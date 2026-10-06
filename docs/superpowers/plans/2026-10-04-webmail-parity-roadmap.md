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
