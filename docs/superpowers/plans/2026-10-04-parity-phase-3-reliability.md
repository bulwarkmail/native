# Parity Phase 3: Reliability and Honest Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When something fails, the user finds out, and background features keep working past a week. This phase covers:
- list actions that fail silently;
- searches that show stale rows or include Spam and Trash;
- push subscriptions that lapse after seven days;
- notifications that vanish or ring twice;
- TOTP accounts that can't change their password;
- domain names written in non-Latin scripts (IDN);
- a few send and sync edges.

It also closes the one regression Phase 2 left open (vCard SOURCE).

**Architecture:**
- Every task ports the matching webmail fix (1.10.0–1.12.0+) or closes a Phase 2 follow-up.
- Logic goes into pure functions in `src/lib/*` or into store actions, with unit tests.
- Screens only wire those functions up, because vitest runs in node and there is no React Native render harness.
- The one native-code change, Task 10, keeps its decision in JavaScript, where it can be tested. Kotlin only honours a flag.

**Tech Stack:** React Native / Expo, TypeScript, Zustand, vitest (`npm test`), JMAP against Stalwart, an Android FCM module in Kotlin, and the `punycode` package (Task 12).

**Spec:** the Phase 3 rows and the "Phase 2 follow-ups" section of [2026-10-04-webmail-parity-roadmap.md](2026-10-04-webmail-parity-roadmap.md). Each item's finding, with WEB and RN pointers, is in the "Webmail 1.10.0 → 1.12.0+ delta" section of [01](../../parity/01-auth-accounts.md), [02](../../parity/02-mail-list-folders.md), [04](../../parity/04-composer-send.md), [08](../../parity/08-settings-push-i18n-ui.md) and [09](../../parity/09-jmap-core-sync-security.md). Webmail had no new commits after `a4e313f` on 2026-10-04.

## Global Constraints

- **Branch:** `parity/phase-3-reliability`, created from `main` (Phase 2 is merged).
- **Webmail reference checkout:** `git clone https://github.com/bulwarkmail/webmail <dir> && git -C <dir> checkout a4e313f`. Below, "WEB `path`" means a path in that checkout.
- **Gate on every commit:** `npm run typecheck && npm test && npm run i18n:check` must all pass.
- **User-visible strings:** use `t('key', 'English fallback')`. Reuse the webmail key whenever the plan names one. Run `npm run i18n:harvest` for any new key. A key built dynamically must be added by hand to `locales/rn/en.json`.
- **Commits:** one commit per task, with the subject given in the task. Each commit ends with a `Co-Authored-By:` trailer naming the model that wrote it.
- **Parity docs:** do not edit `docs/parity/*.md` or `PARITY_CHECKLIST.md` inside a task. They are ticked with commit hashes in one `docs:` commit after the final review.
- **Tests:** vitest only runs `src/**/__tests__/**/*.test.ts`, in node. Write tests first and record the failing (RED) run before implementing.
- **Do not clean up kept outboxes.** Signing out keeps a non-empty outbox on purpose (Phase 2, ruling R15). Nothing in this phase may delete `webmail:outbox:v1:*` keys.

## Not in this phase

- The two unverified list behaviours in area 02 (scroll position on a folder change, unread-first jumps) need a device check before any fix.
- The Files and calendar screen wiring still has no render harness.

## Review Focus

1. **Searching inside a folder** (scope "current" or a picked mailbox) must still return exactly that folder's results. The Spam/Trash exclusion applies only to the default "all folders" search. Owned by Task 4, test `a search in the open folder is not narrowed`.
2. **A list action that is queued while offline is not a failure.** No error toast may appear for it. Owned by Task 2, test `a queued action shows no toast`.
3. **A device whose subscription is fresh** must not re-register push on every foreground: the renewal is throttled to once per 24 h per account. Owned by Task 8, test `does not renew twice within a day`.
4. **A notification for a single account** must ring exactly as it does today. The quiet window only silences a second account's alert. Owned by Task 10, test `the same account still rings`.
5. **An ASCII email address and server URL** must log in exactly as before. IDN conversion leaves ASCII untouched. Owned by Task 12, test `leaves ASCII addresses unchanged`.

---

### Task 1: Keep a vCard's SOURCE when it also has an ORG-DIRECTORY

**Files:**
- Modify: `src/lib/contact-wire.ts` (`contactToWire`, the `directories` guard ~:87)
- Test: `src/lib/__tests__/contact-wire.test.ts`

**Interfaces:**
- Produces: no signature change.

- [ ] **Step 1: Write the failing tests**
  - `keeps SOURCE next to an ORG-DIRECTORY on import`: `contactToWire({ name, directories: { d0: { '@type': 'Directory', kind: 'directory', uri: 'https://org.example/dir' } }, source: 'https://src.example/card.vcf' }, 'create')` sends `directories` with both `d0` and a `kind: 'entry'` entry for the SOURCE URI.
  - `does not add SOURCE twice when the map already has that entry`: the map already holds `{ kind: 'entry', uri: <same> }` under any key, so the map is sent unchanged.
- [ ] **Step 2: Run to verify they fail.** Run `npx vitest run src/lib/__tests__/contact-wire.test.ts`. Expected: the first test fails and the second passes.
- [ ] **Step 3: Implement.** For `directories` only, when `card.source` is set, add `{ '@type': 'Directory', kind: 'entry', uri: card.source }` under the key `source`, unless some entry in the existing map already has `kind === 'entry' && uri === card.source`. Leave `calendars` and `schedulingAddresses` as they are: no parser path sets both a map and a flat field for them. The existing test `keeps the wire maps when the flat fields match them` must stay green.
- [ ] **Step 4: Run to verify they pass.** Same command. Expected: PASS.
- [ ] **Step 5: Commit** `fix: keep a vCard's SOURCE when it also lists an organization directory`

---

### Task 2: Tell the user when a list action fails

**Files:**
- Create: `src/lib/action-failure.ts`
- Modify:
  - `src/screens/EmailListScreen.tsx`. Every un-caught call, at the swipe handler (~:616-651), the batch handlers (~:795, :799), the row MoveSheet `onPick` (~:1715-1716), and the bulk handlers `handleBulkStar`, `handleBulkMarkReadToggle`, `handleBulkSpam`, archive and delete (~:600-603, :773-780).
  - `src/screens/EmailThreadScreen.tsx` (`toastFailure` ~:57-60, which becomes the shared helper).
- Test: `src/lib/__tests__/action-failure.test.ts`

**Interfaces:**
- Produces `reportActionFailure(title: string, err: unknown): void`. It does `console.warn('[action]', title, err)`, then `toast.error(title, err instanceof Error ? err.message : undefined)`.
- Produces `withFailureToast<T>(p: Promise<T>, title: string): Promise<T | undefined>`. It resolves `undefined` after reporting a rejection, and never rejects.

- [ ] **Step 1: Write the failing tests**
  - `reports a rejected action once`: mock `../../stores/toast-store`, reject with `new Error('nope')`, and assert `toast.error('Failed', 'nope')` is called once.
  - `a queued action shows no toast` (Review Focus 2): a resolved promise, including `{ queued: true }`, makes no toast call.
  - `never rejects`.
- [ ] **Step 2: Run to verify they fail.** Run `npx vitest run src/lib/__tests__/action-failure.test.ts`. Expected: FAIL, because the module is missing.
- [ ] **Step 3: Implement.**
  - Wrap every un-caught call listed under Files in `withFailureToast(…, t(key, fallback))`. Store actions apply their local change only after `applyOrQueue` resolves, so a rejection leaves nothing to revert.
  - Keys to use:
    - `notifications.error_updating` for read, unread, star and pin;
    - `email_viewer.spam.error` for spam and not-spam;
    - `notifications.move_failed` for move and archive;
    - `notifications.tag_failed` for tags;
    - `notifications.delete_failed` for delete. If WEB has no `notifications.delete_failed`, harvest it with "Failed to delete".
  - Replace the viewer's local `toastFailure` with `reportActionFailure`.
- [ ] **Step 4: Run to verify they pass.** Run `npx vitest run src/lib src/screens` then `npm run typecheck && npm run i18n:check`. Expected: PASS.
- [ ] **Step 5: Commit** `fix: show a message when a list action fails`

---

### Task 3: Show a failed search as an error, not as the previous folder

**Files:**
- Modify: `src/stores/email-store.ts`, the catch in `refreshEmailsImpl` (~:2836-2876)
- Test: `src/stores/__tests__/email-store.test.ts`

**Interfaces:**
- Produces no new names.
- Behaviour: when the failing view is not the base view (a search query, filters or a keyword view), set `error` to the message, `emails: []`, `totalEmails: 0` and `loading: false`. The early return on `viewChanged()` stays as it is. Base-view failures keep today's "keep what's visible" behaviour. WEB reference: `stores/email-store.ts:3226-3231`.

- [ ] **Step 1: Write the failing tests**
  - `a failed search clears the rows and shows the error`: seed rows, set a search query, make `queryEmails` reject, and assert `emails` is `[]` and `error` is set.
  - `a failed refresh of the plain folder keeps the rows`.
- [ ] **Step 2: Run to verify they fail.** Run `npx vitest run src/stores/__tests__/email-store.test.ts`. Expected: the first test fails.
- [ ] **Step 3: Implement** as described under Interfaces.
- [ ] **Step 4: Run to verify they pass.** Same command. Expected: PASS.
- [ ] **Step 5: Commit** `fix: show a failed search as an error instead of the previous folder's mail`

---

### Task 4: Leave Spam and Trash out of an all-folders search

**Files:**
- Create: `src/lib/search-scope.ts`
- Modify:
  - `src/stores/email-store.ts`: `SearchFolderScope` ~:244, `effectiveFolderScope` ~:267-271, `queryScope` ~:478-484, the query call sites ~:1079, ~:2622, and `fetchSpanningPage` ~:642.
  - `src/screens/EmailListScreen.tsx`: the search folder picker. The "All folders" chip sets the explicit value.
- Test: `src/lib/__tests__/search-scope.test.ts`, `src/stores/__tests__/email-store-all-folders.test.ts`

**Interfaces:**
- `SearchFolderScope` becomes `'all' | 'everywhere' | 'current' | string`.
  - `'all'` is the default for a query: every folder except Spam and Trash.
  - `'everywhere'` is the explicit "All folders" chip, and includes them (WEB `'*'`).
- In `src/lib/search-scope.ts`:
  - `trashAndJunkIds(mailboxes: Mailbox[], accountId: string): string[]` returns the raw (owner-account) ids of that account's `trash` and `junk` role folders.
  - `exclusionFilter(ids: string[]): { inMailboxOtherThan: string[] } | null` returns `null` when `ids` is empty.
  - `defaultSearchScopeFor(current: Mailbox | undefined): 'all' | 'current'` returns `'current'` when the open folder's role is `trash` or `junk` (WEB `lib/search-scope-folders.ts:23-26`).
- `effectiveFolderScope` uses `defaultSearchScopeFor` for a query with no explicit folder.
- `queryScope('all')` carries the exclusion, which is ANDed into the JMAP filter per account, including inside `fetchSpanningPage`. `'everywhere'` carries none.

- [ ] **Step 1: Write the failing tests**
  - Unit tests for all three helpers.
  - Store test: a query with no explicit folder sends `inMailboxOtherThan: [trashId, junkId]` for each account.
  - The "All folders" chip (`'everywhere'`) sends no exclusion.
  - A query started while Trash is open searches Trash only.
  - `a search in the open folder is not narrowed` (Review Focus 1).
- [ ] **Step 2: Run to verify they fail.** Run `npx vitest run src/lib/__tests__/search-scope.test.ts src/stores/__tests__/email-store-all-folders.test.ts`.
- [ ] **Step 3: Implement.** Mailbox ids in the store may be prefixed for shared accounts: use the raw ids per owner account, the same way `refFor` resolves them. The picker's existing "All folders" chip maps to `'everywhere'`. Add no new chip.
- [ ] **Step 4: Run to verify they pass.** Same command, then `npm run typecheck`.
- [ ] **Step 5: Commit** `fix: leave Spam and Trash out of a search unless all folders are picked`

---

### Task 5: Leave Spam and Trash out of tag views and their counts

**Files:**
- Modify:
  - `src/stores/email-store.ts`. Keyword views go through scope `'all'`, so Task 4's exclusion covers the list once a keyword view uses `'all'` rather than `'everywhere'`. Check that, and test it.
  - `src/api/tag-counts.ts` (~:38-45).
  - The store call that fetches tag counts.
- Test: `src/api/__tests__/tag-counts.test.ts`, `src/stores/__tests__/email-store.test.ts`

**Interfaces:**
- Consumes `trashAndJunkIds` and `exclusionFilter` from Task 4.
- Produces `fetchTagCounts(tagIds, accountIds, excludeByAccount?: Record<string, string[]>)`. When an account has ids to exclude, both the total and the unread queries add `{ inMailboxOtherThan }` inside an `AND` (WEB a4e313f).
- Check WEB's change from `limit: 0` to `limit: 1` ("Stalwart treats 0 as no limit"). Apply the same change if native uses `limit: 0`.

- [ ] **Step 1: Write the failing tests** for the count filter shape with and without exclusions, and for a keyword view sending the exclusion.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify they pass.**
- [ ] **Step 5: Commit** `fix: leave trash and spam out of tag views and their counts`

---

### Task 6: Offer only the message's own account's folders in the list's Move sheet

**Files:**
- Modify: `src/screens/EmailListScreen.tsx` (the two `<MoveSheet>`s ~:1702-1727)
- Create: a pure helper in `src/lib/mailbox-tree.ts` (or next to `mailboxesOfAccount`)
- Test: `src/lib/__tests__/mailbox-tree.test.ts`

**Interfaces:**
- Produces `moveTargetsFor(mailboxes: Mailbox[], rowAccountIds: string[]): Mailbox[]`.
  - When every selected row belongs to one account, it returns `mailboxesOfAccount(mailboxes, thatAccount)`.
  - When the rows span accounts, it returns all mailboxes, as today. Cross-account moves are supported, and webmail 1.7.2 lists every account deliberately.
- The row sheet passes `[rowAccountId(state, email)]`. The batch sheet passes the selection's account ids.
- WEB reference: c317cd9 (#1149).

- [ ] **Step 1: Write the failing tests** for a single account, a mixed selection, and a shared-account row.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify they pass.**
- [ ] **Step 5: Commit** `fix: offer the message's own account's folders when moving it from the list`

---

### Task 7: Don't bring back mail deleted while the list was refreshing

**Files:**
- Modify: `src/stores/email-store.ts` (`refreshEmailsImpl`: the full path ~:2800-2819, the spanning path ~:2790-2793, the incremental path ~:2650-2756)
- Test: `src/stores/__tests__/email-store-refresh-removed.test.ts` (new)

**Interfaces:**
- Behaviour, as in WEB `stores/email-store.ts:4329, 4443-4453`:
  - Capture the row keys (`rowKeyOf`) listed before the query.
  - After the query, drop every row that was listed before but is no longer in the live `get().emails`.
  - Lower `totalEmails` by the number dropped.
  - Apply this in all three paths.
- Port the cases from WEB `stores/__tests__/email-store-refresh-removed-meanwhile.test.ts`.

- [ ] **Step 1: Write the failing tests.** Start a refresh whose query resolves later. Meanwhile remove a row through `deleteEmail`, or by `setState`. Resolve the query: the row stays gone, and the total is lowered.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify they pass.** Run the new file plus every other `src/stores/__tests__/email-store*.test.ts`.
- [ ] **Step 5: Commit** `fix: keep mail deleted during a refresh from coming back`

---

### Task 8: Renew push subscriptions before Stalwart's 7-day expiry

**Files:**
- Create: `src/lib/push-renewal.ts`
- Modify: `src/lib/push-notifications.ts` (export what the renewal needs; add a detached renew next to `refreshPushSubscriptionTypes` ~:1272-1311) and `App.tsx` (the AppState handler)
- Test: `src/lib/__tests__/push-renewal.test.ts`, `src/lib/__tests__/push-notifications.test.ts`

**Interfaces:**
- `renewDetachedPushSubscription(accountId: string): Promise<boolean>` lives in `push-notifications.ts`. It follows `refreshPushSubscriptionTypes`:
  - it skips accounts that opted out or have no stored subscription id;
  - it opens `new JMAPClient()` and `loadAccount(accountId)`;
  - it reads `PushSubscription/get` with `expires`;
  - when fewer than `SUBSCRIPTION_REFRESH_THRESHOLD_DAYS` remain, it sends `PushSubscription/set` with `expires` set to now + `SUBSCRIPTION_EXPIRES_DAYS`;
  - it updates the stored `push:subscriptionExpires:v1:<accountId>`;
  - it swallows errors and returns whether it renewed.
- `renewPushOnResume(now = Date.now()): Promise<void>` lives in `push-renewal.ts`. For each id in `readPushAccountIds()`:
  - it skips the account when the last attempt (an in-memory map, plus an AsyncStorage key `push:lastRenewAttempt:v1:<accountId>`) is under 24 h old after a success, or under 15 min old after a failure (WEB `lib/web-push.ts:723-771`);
  - for the active account it calls `resyncPushNotifications(...)` with the stored relay URL, as `App.tsx` does;
  - for every other account it calls `renewDetachedPushSubscription`.
- `App.tsx` calls `renewPushOnResume()` when the AppState becomes `active`, and once after the push setup effect, fire-and-forget with `.catch`.

- [ ] **Step 1: Write the failing tests**
  - `renews a non-active account's subscription close to expiry`. Use the existing `DETACHED` JMAPClient mock in `push-notifications.test.ts`.
  - `leaves a subscription with time to spare alone`.
  - `does not renew twice within a day` (Review Focus 3).
  - `retries a failed renewal after 15 minutes`.
  - `skips opted-out accounts`.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify they pass.** Then run `npm run typecheck`.
- [ ] **Step 5: Commit** `fix: renew push subscriptions for every account before they expire`

Device check: sign in to two accounts. On a server with a short `PushSubscription` expiry, or after moving the device clock forward 6 days, bring the app to the foreground. Both accounts must keep receiving notifications.

---

### Task 9: Show a generic notification when the preview lookup fails

**Files:**
- Modify: `src/lib/push-background-task.ts` (`detachedGetEmails` ~:339, `detachedNewestUnreadInboxIds` ~:352, `processAccountForPush` ~:455-523)
- Test: `src/lib/__tests__/push-background-task.test.ts`

**Interfaces:**
- `detachedGetEmails` and `detachedNewestUnreadInboxIds` keep their names but report failures. They return `{ ok: false }`, or throw a typed `PreviewLookupError`. Pick one approach and use it in both.
- On a failed lookup, `processAccountForPush` shows one generic notification. It must never pass another message off as the one that arrived (WEB 4bc5d48).
  - `notificationId: 'mail-generic:<accountId>'`
  - `title: translate(locale, 'notifications.new_email', 'New email')`
  - `body: groupTitle` (the account label)
  - the same group key
  - no `emailId`
  - Tapping it opens the inbox. Check what `notificationId` without `emailId` does in `App.tsx`'s tap handler, and fall back to opening the account's inbox.
- A thrown HTTP error that is caught per account in `pushBackgroundTask` also shows the generic notification for that account.

- [ ] **Step 1: Write the failing tests.**
  - `shows a generic notification when the message lookup fails`: `secureFetch` returns an `error` method response for `Email/get`.
  - `shows a generic notification when the request fails`.
  - `never shows another message in place of the one that arrived`.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify they pass.**
- [ ] **Step 5: Commit** `fix: show a notification even when the new mail can't be looked up`

---

### Task 10: Ring once for a burst of mail across accounts

**Files:**
- Create: `src/lib/push-quiet-window.ts`
- Modify:
  - `src/lib/push-background-task.ts` (before `showNotification`)
  - `android/app/src/main/java/com/anonymous/bulwarkmobile/BulwarkFcmModule.kt` (`showNotification` / `postNotification`: read a `silent` boolean from the params map; when true, call `setSilent(true)` on the child builder)
- Test: `src/lib/__tests__/push-quiet-window.test.ts`

**Interfaces:**
- `QUIET_WINDOW_MS = 30_000` (WEB `public/sw.js`, cd39805 and 868805e).
- `shouldStaySilent(accountId: string, now = Date.now()): Promise<boolean>` reads the AsyncStorage key `push:lastAlert:v1`, which holds `{ at, accountId }`. It returns true only when the last alert came from a different account less than 30 s ago.
- `recordAlert(accountId: string, now = Date.now()): Promise<void>` is called only for alerts that are not silent. A silent alert neither records nor extends the window.
- If storage is unavailable, the alert rings.
- `push-background-task` passes `silent` in the notification params.

- [ ] **Step 1: Write the failing tests.** Port WEB `lib/__tests__/sw-push-quiet-window.test.ts`:
  - `a second account within 30 s is silent`;
  - `the same account still rings` (Review Focus 4);
  - `after 30 s it rings again`;
  - `a silent alert does not extend the window`;
  - `rings when storage fails`.
  - Also a background-task test that `showNotification` receives `silent: true` for the second account.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement.** In Kotlin, add `.setSilent(params.getBoolean("silent"))` behind `hasKey("silent")`. Use no other native logic.
- [ ] **Step 4: Run to verify they pass.**
- [ ] **Step 5: Commit** `fix: ring once for a burst of mail across accounts`

Device check: send one message to two accounts on the same phone. It must ring once and show two notifications.

---

### Task 11: Send the TOTP code when changing the password or turning TOTP off

**Files:**
- Modify:
  - `src/api/account-security.ts` (`changePassword` ~:346, `disableTotp` ~:387)
  - `src/components/settings/AccountSecuritySettings.tsx` (`PasswordChangeSection` ~:132-160 takes an `otpEnabled` prop; the `TotpSection` disable panel ~:289-360)
- Test: `src/api/__tests__/account-security.test.ts` (new; mock pattern from `src/api/__tests__/identity.test.ts:3-9`, plus `updatePassword: vi.fn()`)

**Interfaces:**
- `changePassword(currentPassword: string, newPassword: string, otpCode?: string)` adds `'otpAuth/otpCode': otpCode.trim()` to the `singleton` update when a code is given. Use this JSON-pointer key only. Sending a whole `otpAuth` object would reset `otpUrl` (WEB `stores/account-security-store.ts:260-267, 583-603`).
- `disableTotp(currentPassword: string, otpCode?: string)` sends `otpAuth: { otpUrl: null, otpCode }` when a code is given (WEB `:676-690`).
- UI: when TOTP is on, the password section shows a code input. Copy the enable flow's input (`AccountSecuritySettings.tsx` ~:341-342, label `settings.security.two_factor.code`, `number-pad`, `maxLength={6}`). The disable panel gets the same input.

- [ ] **Step 1: Write the failing tests** for both request shapes, with and without a code. A code that is only whitespace counts as none.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify they pass.** Then run `npm run typecheck && npm run i18n:check`.
- [ ] **Step 5: Commit** `fix: let accounts with two-factor sign-in change their password and turn it off`

---

### Task 12: Sign in with an internationalized domain

**Files:**
- Modify: `package.json`. Add `punycode` (^2.3.1) as a direct dependency; it is already installed transitively. Run `npm install` so the lockfile updates.
- Create: `src/lib/idn.ts`, ported from WEB `lib/idn.ts`. Use `punycode.toASCII` / `punycode.toUnicode`, because Hermes' `URL` can't be relied on to apply IDNA.
- Modify:
  - `src/lib/server-discovery.ts` (`emailDomain` ~:78, `normalizeServerUrl` ~:40-75)
  - the sign-in path in `src/stores/auth-store.ts`, where the username and email are taken
  - `isValidEmail` in `src/lib/recipients.ts` ~:23-48. Validate the ASCII form, so `user@bücher.de` is accepted.
- Test: `src/lib/__tests__/idn.test.ts` (port WEB `lib/__tests__/idn.test.ts`), `server-discovery.test.ts`, `recipients.test.ts`

**Interfaces** (WEB names):
- `toAsciiDomain(domain): string | null`
- `toAsciiEmail(address): string`, which converts only a non-ASCII domain and never the local part
- `toUnicodeDomain(domain): string`
- `toUnicodeEmail(address): string`
- `NON_HOST_CHARS` rejection as in WEB

Sign-in and discovery use the ASCII form for every network call. Display is unchanged in this task.

- [ ] **Step 1: Write the failing tests.**
  - Port WEB's idn tests.
  - Discovery for `user@bücher.de` looks up `xn--bcher-kva.de`.
  - `isValidEmail('user@bücher.de')` is true.
  - `leaves ASCII addresses unchanged` (Review Focus 5).
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify they pass.** Then run `npm run typecheck`.
- [ ] **Step 5: Commit** `fix: sign in and validate addresses on internationalized domains`

---

### Task 13: Explain a refused token exchange, and show non-admins their name

**Files:**
- Modify:
  - `src/lib/login-errors.ts` (~:129)
  - `src/components/settings/AccountSecuritySettings.tsx` (the load effect ~:899-901)
  - `src/api/account-security.ts`, if `fetchPrincipal` should batch `x:AccountSettings/get` the way WEB does (`:513-529`)
- Test: `src/lib/__tests__/login-errors.test.ts`; the account-security test from Task 11

**Interfaces:**
- `describeLoginError`: a `TotpLoginError` whose `code === 'token_exchange_failed'` maps to a title and detail. Read `code` from the error object, not the message. The detail uses WEB key `login.error.token_exchange_failed` (not yet in native's vendored catalog: pass the English text as the `t()` fallback and harvest it) ("Your password and code were accepted, but the mail server refused to start a session for this app. Ask your administrator to check its OAuth client settings.").
- The security page's display name comes from `fetchAccountDisplayName()` (`x:AccountSettings/get`, allowed for non-admins). It falls back to the principal's description. Load it for OAuth accounts too, outside the `!loadIsOAuth` guard.

- [ ] **Step 1: Write the failing tests** for the error mapping, and for the display-name source when `x:Account/get` is forbidden.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify they pass.**
- [ ] **Step 5: Commit** `fix: explain a refused sign-in token and show non-admins their name`

---

### Task 14: Warn about an unfiled sent copy, and never replay a write

**Files:**
- Modify:
  - `src/screens/ComposeScreen.tsx` (the `filingWarning` log ~:2303-2305)
  - `src/api/jmap-client.ts` (`hasNonIdempotentMethod` ~:99-107 and its use ~:884)
- Test: `src/api/__tests__/jmap-client-hardening.test.ts`, `describe('pure helpers')` ~:111

**Interfaces:**
- Composer: when `result.filingWarning` is set, call `toast.warning(t('email_composer.send_filing_warning', 'Sent - but the post-send cleanup failed, a stale draft may remain.'))`. This is WEB's key (`locales/en/common.json:766`), and it is used the same way at WEB `components/mail/mail-app.tsx:1826`.
- Replace the three-name denylist with WEB's allowlist (`lib/jmap/client.ts:178-199`):
  - `READ_ONLY_METHOD = /\/(?:get|query|changes|queryChanges|parse)$|^Core\/echo$/`
  - `isReplaySafe(methodCalls): boolean` is true only when every call name matches; an empty list is false.
  - The automatic retry after a dropped connection (`authenticatedFetch`'s `idempotent` option) uses it.
  - Leave the `maxConcurrentRequests` back-off replay and the 401 token-refresh retry alone. The server refused those requests before running them.

- [ ] **Step 1: Write the failing tests.**
  - `isReplaySafe` covers `Email/get`, `Email/query`, `Email/set`, `Mailbox/changes` and a mixed batch.
  - `does not retry an Email/set after a network error`, modelled on the existing ~:305 and ~:319 tests.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify they pass.** Then run `npm run typecheck && npm run i18n:check`.
- [ ] **Step 5: Commit** `fix: warn when a sent copy isn't filed and never replay a write after a dropped connection`

---

### Task 15: Stop a calendar feed sync that outlives an account switch

**Files:**
- Modify: `src/stores/calendar-subscriptions-store.ts` (`syncFeedIntoCalendar` ~:207-228, `syncSubscription` ~:313-335, `addSubscription` ~:255)
- Test: `src/stores/__tests__/calendar-subscriptions-store.test.ts`

**Interfaces:**
- `syncFeedIntoCalendar(calendarId, url, stale: () => boolean)` checks `stale()` after each await and returns early, before any `updateEvent`, `deleteEvents` or `importEvents`. Follow the pattern in `src/stores/filter-store.ts:76-84` and `src/stores/vacation-store.ts:55-59`.
- `stale` compares the owner and JMAP account captured when the sync started with `currentOwner()` and `currentAccountId()` at the moment of the check.
- `syncSubscription` does not write `lastSyncAt` for a sync that stopped this way.

- [ ] **Step 1: Write the failing tests.**
  - `stops before deleting events when the account switched mid-sync`: the feed fetch resolves after the auth store's owner changed, and `deleteEvents` and `importEvents` are not called.
  - `a sync with no switch still deletes and imports`.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify they pass.**
- [ ] **Step 5: Commit** `fix: stop a calendar feed sync when the account changes underneath it`

---

### Task 16: Clear offline mail left behind by accounts that are gone

**Files:**
- Modify: `src/stores/offline-cache-store.ts` (add a sweep next to `clearAccount` ~:307-316) and `src/stores/auth-store.ts` (`restoreSession` ~:798-835: call it after hydration and the legacy migration, before the early return)
- Test: `src/stores/__tests__/offline-cache-sweep.test.ts` (new)

**Interfaces:**
- `sweepOrphanedOfflineCache(knownAccountIds: string[]): Promise<void>`:
  - Lists AsyncStorage keys with the index prefix (`webmail:offline-cache:index:v2:`) and the entry prefix (`webmail:offline-cache:entry:v2:`).
  - Removes those whose account id is not in `knownAccountIds`.
  - Account ids contain `@` and may contain `:`. Index keys hold the whole account id after the prefix. Match an entry key against each known id's `${prefix}${id}:` prefix, never by splitting on `:`.
  - Does nothing when `knownAccountIds` is empty, so it never wipes everything while the registry is unloaded.
  - Never touches outbox keys.
- `restoreSession` calls it fire-and-forget, with `.catch` and a `console.warn`.

- [ ] **Step 1: Write the failing tests.**
  - `removes entries of accounts no longer registered`.
  - `keeps a registered account whose id is a prefix of a removed one`, for example `a@mail.example.com` vs `a@mail.example.com.au`.
  - `does nothing when no account is known`.
  - `leaves outbox keys alone`.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify they pass.**
- [ ] **Step 5: Commit, then close the phase.** Commit `fix: clear offline mail left behind by accounts that are no longer signed in`. After the final review, tick the parity items with their hashes and update the counts table in one `docs:` commit.
