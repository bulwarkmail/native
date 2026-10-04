# Parity Phase 2: Data Correctness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the app from making writes the server silently refuses, writing into the wrong account, or rewriting data. That covers:
- contacts that Stalwart rejects;
- address books that can't be deleted;
- moved mail that loses its date;
- drafts that follow an account switch;
- screens and caches that outlive their account;
- calendar subscriptions shared across logins;
- daily events that stop at DST;
- events that can't be saved when invitations are refused;
- the Files edge cases.

**Architecture:** Each task ports a fix the webmail already shipped (1.10.0–1.12.0+). Pure mapping and validation logic goes in `src/lib/*` and is unit-tested. API calls in `src/api/*` take explicit account ids. Stores own their per-account cleanup, and `auth-store` calls them. Screens stay thin: tests run in vitest's node environment with no React Native render harness, so any screen logic worth testing is pulled into a pure function first.

**Tech Stack:** React Native / Expo, TypeScript, Zustand (persist with AsyncStorage), vitest (`npm test`), and JMAP against Stalwart (RFC 8620/8621, JSContact RFC 9553, JSCalendar, FileNode).

**Spec:** the Phase 2 rows of [2026-10-04-webmail-parity-roadmap.md](2026-10-04-webmail-parity-roadmap.md). Each row's finding, with WEB and RN pointers, is in the "Webmail 1.10.0 → 1.12.0+ delta" sections of these files in `docs/parity/`:
- [01-auth-accounts.md](../../parity/01-auth-accounts.md)
- [02-mail-list-folders.md](../../parity/02-mail-list-folders.md)
- [04-composer-send.md](../../parity/04-composer-send.md)
- [05-calendar.md](../../parity/05-calendar.md)
- [06-contacts.md](../../parity/06-contacts.md)
- [07-filters-vacation-files.md](../../parity/07-filters-vacation-files.md)

Webmail had no new commits after `a4e313f` on 2026-10-04, so the delta is current.

## Global Constraints

- **Branch:** create `parity/phase-2-data-correctness` from `parity/phase-1-security-send`. Phase 1 isn't merged yet, and this branch builds on its docs, its `src/api/jmap-result.ts` errors and its Sieve changes. Rebase onto `main` once Phase 1 merges.
- **Webmail reference checkout:** `git clone https://github.com/bulwarkmail/webmail <dir> && git -C <dir> checkout a4e313f`. Below, "WEB `path`" means a path in that checkout.
- **Gate on every commit:** `npm run typecheck && npm test && npm run i18n:check` must all pass.
- **User-visible strings:** use `t('key', 'English fallback')`. Reuse the webmail key when the plan names one. If `i18n:check` reports a missing key, run `npm run i18n:harvest`. Keys looked up dynamically (template strings) can't be harvested, so add them to `locales/rn/en.json` by hand when the vendored catalog lacks them.
- **Commits:** one per task, using the given subject. End the message with a `Co-Authored-By:` trailer naming the model that wrote it.
- **Parity docs:** do not edit `docs/parity/*.md` or `PARITY_CHECKLIST.md` inside a task. Tick the items with their commit hashes in one `docs:` commit after the final review, as Phase 1 did.
- **Test locations:** vitest only runs `src/**/__tests__/**/*.test.ts`, in a node environment. There is no `.tsx` component test harness.
- **Never** change how data already on the server is read in a way that loses fields. Every new write mapping needs its read counterpart in the same task.

## Review Focus

1. **Contacts the server sends without `calendars` / `schedulingAddresses` / `directories`** must load, show and save unchanged. `contactFromWire` returns the same card, and an edit that never touched calendar links sends no `calendars` key. Task 1 owns this: test `leaves calendar links alone when the update does not mention them`, plus `returns a card without links unchanged`.
2. **iCal subscriptions saved before this phase**, with no `owner`, must still appear for the login that created them after the store migration. They must not vanish, and they must not leak to other logins. Task 7 owns this: test `adopts a legacy subscription only for the login whose calendars contain it`.
3. **A composer opened and used without any account switch** must make exactly the calls it makes today, with the same account id. Task 4 owns this: test `resolves to the active account's mailboxes when nothing switched`.
4. **Weekly, monthly and timed events in zones with no DST transition in range** must expand exactly as before. Task 6 owns this: the existing `recurrence-expansion.test.ts` stays green unchanged, plus `a daily series in UTC is unchanged`.
5. **Signing out of one account** must leave the other signed-in accounts' offline bodies, outbox and subscriptions intact. Task 8 owns this: test `forgets only the signed-out account's data`.

---

### Task 1: Write contacts in the shape Stalwart accepts, and read the links back

**Files:**
- Create: `src/lib/contact-wire.ts`
- Modify:
  - `src/api/types.ts:341-371` (`ContactCard`: add `calendars?`, `schedulingAddresses?`)
  - `src/api/contacts.ts:83-89` (`stripClientFields`), `:157-173` (`getContacts`), `:220-282` (`createContact`, `updateContact`), and any other function that returns cards from `ContactCard/get` (`getContact`, `getAllContacts` via `tagContact` ~`:176-198`)
- Test:
  - `src/lib/__tests__/contact-wire.test.ts` (new)
  - `src/api/__tests__/contacts.test.ts`

**Interfaces:**
- Produces:
  - `contactToWire(card: Partial<ContactCard>, mode: 'create' | 'update'): Record<string, unknown>`
  - `contactFromWire<T extends ContactCard>(card: T): T`
- Both are ports of WEB `lib/jmap/contact-wire.ts`, with the same behaviour line for line, including the private `addressToWire`.
- Client-only keys dropped on write: `originalId`, `accountId`, `accountName`, `isShared`, `localAccountId`.
- Flat keys dropped on write: `calendarUri`, `freeBusyUri`, `schedulingUri`, `source`.

- [ ] **Step 1: Write the failing tests**

Port WEB `lib/__tests__/contact-wire.test.ts` unchanged. It covers:
- `drops client-only fields, which ContactCard/set rejects`
- `writes the calendar URIs as RFC 9553 calendars and schedulingAddresses`
- `sends null for cleared fields on update, but omits them on create`
- `leaves calendar links alone when the update does not mention them`
- `converts flat vCard addresses to components and SOURCE to a directory entry`
- `fills the flat URI fields from the server card`

Add `returns a card without links unchanged`: `contactFromWire(card)` is `toBe(card)` for a card with no `calendars`, `schedulingAddresses` or `directories`.

In `contacts.test.ts`, add `createContact sends calendars, not calendarUri`. Create with `{ name, calendarUri: 'https://c.example/cal' }`, then assert `create['new-contact'].calendars.cal` equals `{ '@type': 'Calendar', kind: 'calendar', uri: 'https://c.example/cal' }` and `calendarUri` is undefined.

Add `getContacts fills calendarUri from calendars`.

- [ ] **Step 2: Run to verify they fail**

Run `npx vitest run src/lib/__tests__/contact-wire.test.ts src/api/__tests__/contacts.test.ts`.

Expected: FAIL, because the module is missing and the API tests fail.

- [ ] **Step 3: Implement**

- Port the module.
- Add to `ContactCard`:
  - `calendars?: Record<string, { '@type'?: 'Calendar'; kind?: 'calendar' | 'freeBusy' | string; uri: string; mediaType?: string; pref?: number }>`
  - `schedulingAddresses?: Record<string, { '@type'?: 'SchedulingAddress'; uri: string; pref?: number }>`
- In `createContact` and `updateContact`, replace `stripClientFields(...)` with `contactToWire(..., 'create' | 'update')`. Delete `stripClientFields` if nothing else uses it.
- Pass every card returned from `ContactCard/get` through `contactFromWire`.
- `ContactFormScreen`, `ContactDetailScreen` and `vcard.ts` keep using the flat fields: the mapping layer is the only place the wire shape exists.
- vCard import (`contacts-store.ts:471-479` → `createContact`) now goes through `contactToWire` too. That fixes the import finding with no change to `vcard.ts`.

- [ ] **Step 4: Run to verify they pass**

Run `npx vitest run src/lib src/api src/stores` and then `npm run typecheck`.

Expected: PASS.

- [ ] **Step 5: Commit**

`fix: save contacts' calendar links and vCard addresses in the form Stalwart accepts`

Device check: on Stalwart, add a calendar link to a contact, save, reopen and confirm the link is shown. Import a vCard that has `ADR`, `CALURI` and `SOURCE`, and confirm it imports.

---

### Task 2: Delete an address book together with its contacts

**Files:**
- Modify: `src/api/contacts.ts:362-370` (`deleteAddressBook`), `src/stores/contacts-store.ts:628-642` (and the comment at `:631`)
- Test: `src/api/__tests__/contacts.test.ts` (`describe('deleteAddressBook')` ~`:365`)

**Interfaces:**
- Produces: `deleteAddressBook(id: string, accountId?: string, options?: { removeContents?: boolean }): Promise<void>`. It matches WEB `lib/jmap/client.ts:5821-5842`.

- [ ] **Step 1: Write the failing test**

Add `asks the server to remove the contents when told to`: call `deleteAddressBook('ab-1', undefined, { removeContents: true })` and assert `call[1].onDestroyRemoveContents === true`.

Add `sends no onDestroyRemoveContents by default`.

- [ ] **Step 2: Run to verify it fails**

Run `npx vitest run src/api/__tests__/contacts.test.ts`.

Expected: the first new test FAILS.

- [ ] **Step 3: Implement**

Spread `...(options?.removeContents ? { onDestroyRemoveContents: true } : {})` into the `AddressBook/set` args.

The store's `deleteAddressBook` passes `{ removeContents: true }`. The confirm dialog in `ContactsSettings.tsx:394-407` already says the contacts go with the book. Fix the store comment so it says the request asks for this explicitly (RFC 9610 §2.3).

- [ ] **Step 4: Run to verify it passes**

Run the same command. Expected: PASS.

- [ ] **Step 5: Commit**

`fix: delete an address book that still has contacts`

---

### Task 3: Keep a moved message's date when it changes account

**Files:**
- Modify: `src/api/email.ts:976-989` (`importEmailBlob`), `src/stores/email-store.ts:2175-2190` (`crossAccountMove`)
- Test:
  - `src/stores/__tests__/email-store.test.ts` (cross-account move test ~`:1436-1450`)
  - `src/api/__tests__/email.test.ts`

**Interfaces:**
- Produces: `importEmailBlob(blobId: string, mailboxId: string, keywords?: Record<string, boolean>, accountIdOverride?: string, receivedAt?: string): Promise<string>`. The two other callers (`email-store.ts:1165` .eml import, `email.ts:2039` sent-copy filing) do not pass it.

- [ ] **Step 1: Write the failing tests**

- In `email.test.ts`, add `importEmailBlob sends receivedAt when given`: the `Email/import` entry for `import-0` has `receivedAt: '2026-01-02T03:04:05Z'`. Also add `importEmailBlob omits receivedAt when not given`.
- In `email-store.test.ts`, give the moved row `receivedAt: '2026-01-02T03:04:05Z'` and extend the existing assertion to `toHaveBeenCalledWith('blob-new', 'mb-1', { $seen: true }, undefined, '2026-01-02T03:04:05Z')`.

- [ ] **Step 2: Run to verify they fail**

Run `npx vitest run src/api/__tests__/email.test.ts src/stores/__tests__/email-store.test.ts`.

Expected: the new assertions FAIL.

- [ ] **Step 3: Implement**

Spread `...(receivedAt ? { receivedAt } : {})` after `keywords`, as in WEB 71a1fad. `crossAccountMove` passes `e.receivedAt` (the list row always has it, per `EMAIL_LIST_PROPERTIES`).

- [ ] **Step 4: Run to verify they pass**

Run the same command. Expected: PASS.

- [ ] **Step 5: Commit**

`fix: keep a moved message's original date in the other account`

---

### Task 4: Keep an open draft on the account it was started in

**Files:**
- Create: `src/lib/composer-account.ts`
- Modify:
  - `src/screens/ComposeScreen.tsx`:
    - the identity load at `:744-757`;
    - the mailbox picks at `:441-451`;
    - the `createDraft` call at `:1300`;
    - the `destroyEmails` call at `:1406`;
    - the uploads at `:798`, `:831` and `:1542`;
    - the `sendEmail` call at `:2110`;
    - the render-time reads at `:884-885` and `:925`.
  - `src/api/blob.ts` (`uploadBytes` / `uploadBlob`), only if they lack an account parameter. Check `:67`.
- Test: `src/lib/__tests__/composer-account.test.ts` (new)

**Interfaces:**
- Produces, in `src/lib/composer-account.ts`:
  - `interface ComposerAccount { appAccountId: string; jmapAccountId: string }`
  - `resolveComposerMailboxes(owner: ComposerAccount, activeAppAccountId: string | null, liveMailboxes: Mailbox[], snapshots: Record<string, { mailboxes?: Mailbox[] } | undefined>): Mailbox[] | null`. It returns the live mailboxes when `owner.appAccountId === activeAppAccountId`. Otherwise it returns the snapshot's mailboxes for `owner.appAccountId`, or `null` when there is none.
  - Before writing this, read `src/stores/email-store.ts` for the actual name and key of the per-account snapshot map (`accountSnapshots`) and match it.

- [ ] **Step 1: Write the failing tests**

- `resolves to the active account's mailboxes when nothing switched` (Review Focus 3).
- `resolves to the owner's snapshot after a switch`.
- `returns null when the owner has no snapshot`.

- [ ] **Step 2: Run to verify they fail**

Run `npx vitest run src/lib/__tests__/composer-account.test.ts`.

Expected: FAIL, because the module is missing.

- [ ] **Step 3: Implement**

- Port the helper.
- In `ComposeScreen`, capture the owner once on mount in a ref. Take `appAccountId` from `useAuthStore.getState().activeAccountId` and `jmapAccountId` from `jmapClient.accountId`. For a reopened draft, use the draft route param's `jmapAccountId` when present, as `seedOwnerAccountId` does.
- Pass `owner.jmapAccountId` explicitly to:
  - `getIdentities`
  - `createDraft` (4th argument)
  - `destroyEmails`
  - `uploadBytes` / `uploadBlob`
  - `sendEmail` (`opts.accountId`)
- Take Sent and Drafts from `resolveComposerMailboxes(...)` instead of the live store.
- Replace the render-time `jmapClient.accountId` / `getActiveAccount()` reads with the owner.
- When `resolveComposerMailboxes` returns `null`, block send and autosave and show `Alert.alert(t('email_composer.account_switched_title', 'Account changed'), t('email_composer.account_switched_body', 'Switch back to the account this message was started in to send it.'))`.
- This port does not swap the JMAP client: these calls already accept an account override, and `jmapClient` serves every signed-in account's session.
- If, while implementing, a call turns out to work only for the active session (for example an upload URL tied to the active account), stop and report it rather than guessing.

- [ ] **Step 4: Run to verify they pass**

Run `npx vitest run src/lib src/api` and then `npm run typecheck`.

Expected: PASS.

- [ ] **Step 5: Commit**

`fix: keep an open draft and its send on the account it was started in`

Device check: with two accounts, start a reply in account A. Tap a notification for account B, return to the composer, and send. The mail must go from A, file into A's Sent, and leave nothing in B's Drafts.

---

### Task 5: Reload filters, vacation and the security screen after an account switch

**Files:**
- Modify:
  - `src/stores/auth-store.ts:658-742` (`switchAccount`)
  - `src/components/settings/FilterSettings.tsx:160-167`
  - `src/components/settings/AccountSecuritySettings.tsx:844`, `:870-896`
- Test: `src/stores/__tests__/auth-store.test.ts`

**Interfaces:**
- Consumes: `useFilterStore.getState().clearState()` (`filter-store.ts:247`) and `useVacationStore.getState().reset()` (`vacation-store.ts:113`).

- [ ] **Step 1: Write the failing test**

Add `switchAccount clears the filter and vacation stores`. Seed `useFilterStore` with a rule and `useVacationStore` with `isEnabled: true`, call `switchAccount` to another registered account, and assert that both are back at their initial state. Use the existing `auth-store.test.ts` mocks: see `describe('logout')` ~`:120` for how a switch is driven.

- [ ] **Step 2: Run to verify it fails**

Run `npx vitest run src/stores/__tests__/auth-store.test.ts`.

Expected: FAIL.

- [ ] **Step 3: Implement**

- In `switchAccount`, call both resets next to the existing `useContactsStore.reset()` / `useCalendarStore.reset()` (`:675-676`).
- `FilterSettings`: add `useAuthStore((s) => s.activeAccountId)` to the `selectAccount` effect's dependencies, so a mounted screen refetches.
- `AccountSecuritySettings`:
  - add the same value to the load effect's dependencies;
  - reset the local state (`auth`, `displayName`, `loadError`, crypto) at the top of the effect;
  - read `jmapClient.usesBearerAuth` inside the effect.

- [ ] **Step 4: Run to verify it passes**

Run the same command, then `npm run typecheck`.

Expected: PASS.

- [ ] **Step 5: Commit**

`fix: reload filters, the auto-reply and account security after switching account`

---

### Task 6: Recognize a daily series across a DST change

**Files:**
- Modify: `src/lib/recurrence-expansion.ts`:
  - `generateCandidatesForPeriod` `:383-410`;
  - `matchesByX` `:538`, with its time checks at `:584-586`.
- Test: `src/lib/__tests__/recurrence-dst-gap.test.ts` (new)

**Interfaces:**
- Produces: `matchesByX(date: Date, rule: RecurrenceRule, timeOf: Date = date): boolean`. Byhour/minute/second compare against `timeOf`.

- [ ] **Step 1: Write the failing tests**

Port WEB `lib/__tests__/recurrence-dst-gap.test.ts` unchanged. It includes the `daily(start, allDay, timeZone?)` helper and the save/restore of `process.env.TZ` in `beforeEach`/`afterEach`. The cases are:
- `keeps a 02:30 series going past the spring-forward night (Berlin)`: 31 results, the last starting `2026-03-31T02:30`.
- `keeps an all-day series going after a midnight gap (Santiago)`: 7 results, all at `00:00`.

Add `a daily series in UTC is unchanged`, with `TZ='UTC'`, 10 days, and every start at the same `HH:mm` (Review Focus 4).

- [ ] **Step 2: Run to verify they fail**

Run `npx vitest run src/lib/__tests__/recurrence-dst-gap.test.ts`.

Expected: Berlin and Santiago FAIL; UTC passes.

- [ ] **Step 3: Implement**

Port WEB `lib/recurrence-expansion.ts:419-428` and `:444`:
- Split `'daily'` out of the shared fallthrough. It builds `new Date(periodStart.getFullYear(), periodStart.getMonth(), periodStart.getDate(), eventStart.getHours(), eventStart.getMinutes(), eventStart.getSeconds(), eventStart.getMilliseconds())`.
- Filter with `matchesByX(d, rule, freq === 'daily' ? eventStart : undefined)`.
- Hourly, minutely and secondly keep `new Date(periodStart)`.

- [ ] **Step 4: Run to verify they pass**

Run `npx vitest run src/lib/__tests__/recurrence-dst-gap.test.ts src/lib/__tests__/recurrence-expansion.test.ts src/lib/__tests__/recurrence-instances.test.ts`.

Expected: PASS, with the existing files unchanged.

- [ ] **Step 5: Commit**

`fix: keep a daily series going past a daylight-saving change`

---

### Task 7: Tie iCal subscriptions to the login that created them

**Files:**
- Modify: `src/stores/calendar-subscriptions-store.ts`:
  - `CalendarSubscription` `:20-33`;
  - `selectAccountSubscriptions` `:62-67`;
  - `addSubscription` ~`:163`;
  - `syncAll` / `syncDue` ~`:253-262`;
  - persist config ~`:271-276`.
- Test: `src/stores/__tests__/calendar-subscriptions-store.test.ts`

**Interfaces:**
- Produces:
  - `subscriptionOwner(serverUrl: string, username: string): string`, which returns `` `${serverUrl.replace(/\/+$/, '').toLowerCase()}|${username.toLowerCase()}` `` (WEB `stores/calendar-store.ts:494-497`).
  - `CalendarSubscription.owner?: string`.
  - Store action `forgetSubscriptions(owner: string): void`.
  - `selectAccountSubscriptions(subscriptions, owner: string | null, accountId: string | null, calendars: { id: string; originalId?: string; name: string }[])`. It implements WEB `claimSubscription` (`:499-521`):
    - an owned sub matches only its own owner;
    - an unowned sub whose `accountId` differs is excluded;
    - an unowned sub is adopted, with `owner` set on write, only when `calendars` contains one where `(originalId ?? id) === sub.calendarId && name === sub.name`.
  - Update every caller of the old two-argument selector. The callers are `ICalSubscriptionSheet.tsx`, `CalendarInvitationBanner.tsx`, `device-sync/use-sync-collections.ts` and `CalendarScreen.tsx`; check each one.

- [ ] **Step 1: Write the failing tests**

- `stamps the owner on a new subscription` (from `jmapClient.serverUrl` / `username`; extend the mock).
- `shows a subscription only to its owner`.
- `adopts a legacy subscription only for the login whose calendars contain it` (Review Focus 2).
- `does not refresh another login's subscription`.
- `forgetSubscriptions removes only that owner's subscriptions`.
- `migrates version 0 state without dropping subscriptions`.

- [ ] **Step 2: Run to verify they fail**

Run `npx vitest run src/stores/__tests__/calendar-subscriptions-store.test.ts`.

Expected: FAIL.

- [ ] **Step 3: Implement**

- Add `version: 1` and a `migrate` that keeps every subscription as it is. Unowned entries are claimed lazily by the selector, as in WEB.
- Persist adopted owners through the store's normal `set`.

- [ ] **Step 4: Run to verify they pass**

Run `npx vitest run src/stores src/lib` and then `npm run typecheck`.

Expected: PASS.

- [ ] **Step 5: Commit**

`fix: keep each login's calendar subscriptions to itself`

---

### Task 8: Forget a signed-out account's data on the device

**Files:**
- Create: `src/stores/account-data-cleanup.ts`
- Modify:
  - `src/stores/offline-cache-store.ts`: add a per-account clear next to `clearAll` `:292-303`.
  - `src/stores/outbox-store.ts`: add a per-account clear next to `clear` `:384-390`.
  - `src/stores/auth-store.ts`: `logout` `:575-621`, `logoutAll` `:623-654`, `removeAccount` `:744-760`.
- Test: `src/stores/__tests__/account-data-cleanup.test.ts` (new) and `src/stores/__tests__/auth-store.test.ts`

**Interfaces:**
- Consumes: `forgetSubscriptions` and `subscriptionOwner` (Task 7).
- Produces:
  - `forgetAccountData(account: { appAccountId: string; jmapAccountId?: string; serverUrl?: string | null; username?: string | null }): Promise<void>`. It clears:
    - that account's offline-cache index and entries (`webmail:offline-cache:index:v2:<acct>` and `…entry:v2:<acct>:*`; first check which id `<acct>` is in `offline-cache-store.ts:17-18`);
    - that account's outbox keys (`webmail:outbox:v1:` + `storageKey(acct)` and the failed suffix);
    - its calendar subscriptions (`forgetSubscriptions(subscriptionOwner(serverUrl, username))` when both are known);
    - the global search history (`useSearchHistoryStore.getState().clearRecentSearches()`), on every sign-out, because its entries are not per account.
  - `useOfflineCacheStore.getState().clearAccount(accountId: string): Promise<void>`
  - `useOutboxStore.getState().clearAccount(accountId: string): Promise<void>`

- [ ] **Step 1: Write the failing tests**

- `forgets only the signed-out account's data` (Review Focus 5). Seed two accounts' offline-cache keys, outbox keys and subscriptions in the in-memory AsyncStorage mock, call `forgetAccountData` for one, and assert the other's data is untouched.
- `clears the search history`.
- In `auth-store.test.ts`:
  - `logout forgets the account's data`;
  - `removeAccount forgets a non-active account's data, using its registry serverUrl and username`;
  - `logoutAll forgets every account's data`.
  - Mock `account-data-cleanup` and assert the arguments.

- [ ] **Step 2: Run to verify they fail**

Run `npx vitest run src/stores/__tests__/account-data-cleanup.test.ts src/stores/__tests__/auth-store.test.ts`.

Expected: FAIL.

- [ ] **Step 3: Implement**

Capture the account's `serverUrl` and `username` before its credentials are cleared:
- in `logout`, from `jmapClient`;
- in `removeAccount`, from `useAccountStore.getState().getAccountById(id)`.

Call `forgetAccountData` from all three paths. Keep settings, locale, templates, keywords and the account-independent stores, as WEB `lib/sign-out-cleanup.ts` does.

- [ ] **Step 4: Run to verify they pass**

Run `npx vitest run src/stores` and then `npm run typecheck`.

Expected: PASS.

- [ ] **Step 5: Commit**

`fix: forget an account's offline mail, outbox, subscriptions and search history when it signs out`

---

### Task 9: Save an event without invitations when the server refuses to send them

**Files:**
- Modify:
  - `src/api/calendar.ts`: `createEvent` `:606-633`, `updateEvent` ~`:680-697`.
  - `src/screens/CalendarScreen.tsx`: `handleSave` `:734-759`, `handleScopeSelect` `:641-731`.
  - `src/components/calendar/EventModal.tsx`: `handleSave` `:299-366`.
- Create: `src/lib/scheduling-denied.ts`
- Modify: `src/api/jmap-result.ts` (add `SchedulingDeniedError` next to the Phase 1 send errors)
- Test: `src/api/__tests__/calendar.test.ts` and `src/lib/__tests__/scheduling-denied.test.ts` (new)

**Interfaces:**
- Produces:
  - `class SchedulingDeniedError extends Error { readonly reason: string }` in `src/api/jmap-result.ts`, with `name = 'SchedulingDeniedError'` (WEB `lib/jmap/scheduling-error.ts`).
  - In `src/lib/scheduling-denied.ts`: `saveWithSchedulingFallback(save: (send: boolean | undefined) => Promise<void>, send: boolean | undefined, confirm: (reason: string) => Promise<boolean>): Promise<'saved' | 'saved_without_invitations' | 'cancelled'>`. It calls `save(send)`. On a `SchedulingDeniedError` when `send` is true, it asks `confirm(reason)`, and on yes calls `save(false)`. Any other error is rethrown.

- [ ] **Step 1: Write the failing tests**

In `calendar.test.ts`:
- `createEvent throws SchedulingDeniedError when scheduling is refused`: `notCreated['new-event'] = { type: 'forbidden', description: 'Not allowed to schedule' }` with `sendSchedulingMessages: true`.
- The same case for `updateEvent`.
- `a forbidden error without scheduling stays a plain error`.

In `scheduling-denied.test.ts`:
- `retries without invitations when the user agrees`
- `stops when the user declines`
- `rethrows other errors`
- `does not ask when invitations were not being sent`

- [ ] **Step 2: Run to verify they fail**

Run `npx vitest run src/api/__tests__/calendar.test.ts src/lib/__tests__/scheduling-denied.test.ts`.

Expected: FAIL.

- [ ] **Step 3: Implement**

In the API, before the generic error, check `if (sendSchedulingMessages && err?.type === 'forbidden') throw new SchedulingDeniedError(err.description || 'forbidden')` (WEB `client.ts:7185,7380`).

Wrap the three save paths in `saveWithSchedulingFallback`. The `confirm` callback is an `Alert.alert` promise:
- Title: `calendar.notifications.invitations_denied_title`.
- Message: `calendar.notifications.invitations_denied` with `{ reason }`.
- Buttons: cancel, and `calendar.notifications.save_without_invitations`.
- Reuse the webmail keys and texts (look them up in WEB `locales/en/common.json`).

Also give `EventModal.handleSave` a `catch` that shows the existing `calendar.notifications.event_error` alert. Today a failed save is an unhandled rejection.

- [ ] **Step 4: Run to verify they pass**

Run `npx vitest run src/api src/lib` and then `npm run typecheck && npm run i18n:check`.

Expected: PASS.

- [ ] **Step 5: Commit**

`fix: offer to save an event without invitations when the server refuses to send them`

---

### Task 10: Leave a participant's name out when it is blank

**Files:**
- Modify: `src/lib/calendar-participants.ts:271-310` (`buildParticipantMap`)
- Test: `src/lib/__tests__/calendar-participants.test.ts`

**Interfaces:**
- Produces: participants in the returned map have `name` only when the trimmed name is non-empty. If the native `Participant` type requires `name`, make it optional.

- [ ] **Step 1: Write the failing tests**

- `omits a blank organizer name`: `buildParticipantMap({ name: '', email: 'me@x.example' }, [])` gives an organizer entry with no `name` key.
- `omits a whitespace-only attendee name and trims a real one`: `' Ann '` becomes `'Ann'`.

- [ ] **Step 2: Run to verify they fail**

Run `npx vitest run src/lib/__tests__/calendar-participants.test.ts`.

Expected: FAIL.

- [ ] **Step 3: Implement**

Use WEB's helper `const named = (name: string) => (name.trim() ? { name: name.trim() } : {})`, and spread it in place of `name:` for the organizer and for each attendee (WEB `lib/calendar-participants.ts:252-290`). Run `npm run typecheck` and fix any reader that assumed `name` is always set.

- [ ] **Step 4: Run to verify they pass**

Run the same command and then `npm run typecheck`.

Expected: PASS.

- [ ] **Step 5: Commit**

`fix: leave a participant's name out of an invitation when it is blank`

---

### Task 11: Let the server rename a new folder or file whose name is taken

**Files:**
- Modify:
  - `src/api/files.ts`: `createFolder` `:248-267`, `createFileNodeFromBlob` `:333-352`.
  - `src/lib/filenode-name.ts`
- Test: `src/api/__tests__/files.test.ts` (the `createFolder` tests at `:84-105`) and `src/lib/__tests__/filenode-name.test.ts`

**Interfaces:**
- Produces:
  - `numberedFileName(name: string, n: number): string`, exported from `src/lib/filenode-name.ts`. It gives `"report.pdf", 2 → "report (2).pdf"` and `"notes", 3 → "notes (3)"`, matching WEB `client.ts:799-802` (the `dot > 0` rule).
  - A private helper in `files.ts`, `createFileNode(accountId: string, props: Record<string, unknown>): Promise<FileNode>`, port of WEB `createFileNodeIn` (`:8072-8105`). It:
    - sends `onExists: 'rename'`;
    - on a `notCreated` whose description matches `/already exists/i` (older servers ignore `onExists`), retries with `numberedFileName(base, attempt)` for attempts 2–20;
    - returns `{ ...props, name, ...created }`, so a server-side rename wins.
  - `createFolder` and `createFileNodeFromBlob` both use it.

- [ ] **Step 1: Write the failing tests**

- `numberedFileName` cases, including a dotfile `.env` → `.env (2)`.
- `createFolder sends onExists rename`.
- `createFolder takes the server's renamed name`.
- `createFolder retries with a numbered name on a server that ignores onExists`.
- `gives up after 20 attempts`.

- [ ] **Step 2: Run to verify they fail**

Run `npx vitest run src/api/__tests__/files.test.ts src/lib/__tests__/filenode-name.test.ts`.

Expected: FAIL. Also update the existing `createFolder` assertions for the new `onExists` arg.

- [ ] **Step 3: Implement**

Do what the interfaces above specify.

- [ ] **Step 4: Run to verify they pass**

Run the same command. Expected: PASS.

- [ ] **Step 5: Commit**

`fix: give a new folder or file a numbered name when its name is taken`

---

### Task 12: Speak the older FileNode rights and type limits to servers before Stalwart 0.16.6

**Files:**
- Modify: `src/api/files.ts`:
  - `FILE_NODE_PROPERTIES` reads `:18-25`;
  - `setFileNodeShare` `:400-420`;
  - `safeMimeType` `:327-331` and its callers `:366`, `:386`;
  - the node read path that maps `myRights` / `shareWith`.
- Test: `src/api/__tests__/files.test.ts`. Add `getAccountCapability: vi.fn()` to the `jmapClient` mock; it is missing today.

**Interfaces:**
- Produces, all in `files.ts`:
  - `isLegacyFileNodeServer(accountId: string): boolean`. It is `!!cap && !('forbiddenNameChars' in cap)`, where `cap = jmapClient.getAccountCapability(CAPABILITIES.FILES, accountId)` (WEB `:8039-8042`).
  - `toLegacyRights(r: FileNodeRights)`, which returns `{ mayRead, mayWrite: mayAddChildren || mayRename || mayDelete || mayModifyContent, mayShare }`.
  - `fromLegacyRights(r)`. When `'mayWrite' in r`, it spreads `mayWrite` over the four finer rights (WEB `:43-66`). Apply it to `myRights` and every `shareWith` entry on read.
  - `safeMimeType(type: string | undefined, fallback: string, accountId: string): string`, with a limit of 30 on a legacy server and 255 otherwise (WEB `:8122-8131`).

- [ ] **Step 1: Write the failing tests**

Port the cases:
- WEB `lib/__tests__/jmap-filenode-writes.test.ts:92`, `shares with the mayWrite rights of servers before 0.16.6`;
- WEB `:103`, `reads old mayWrite rights as the finer rights`.

Add:
- `keeps a 40-character office MIME type on a current server`;
- `falls back to octet-stream for a long type on a legacy server`;
- `shares with the finer rights on a current server`.

- [ ] **Step 2: Run to verify they fail**

Run `npx vitest run src/api/__tests__/files.test.ts`.

Expected: FAIL.

- [ ] **Step 3: Implement**

Do what the interfaces above specify.

- [ ] **Step 4: Run to verify they pass**

Run the same command. Expected: PASS.

- [ ] **Step 5: Commit**

`fix: share files and keep office file types on every Stalwart version`

---

### Task 13: Check file and folder names against the server's rules before sending them

**Files:**
- Create: `src/lib/file-name-rules.ts`, a port of WEB `lib/file-name-rules.ts`
- Modify:
  - `src/api/files.ts`: add `getFileNameRules(accountId?: string)`;
  - `src/screens/FilesScreen.tsx`: the new-folder check `:477-496`, rename ~`:505`, upload ~`:611`.
- Test: `src/lib/__tests__/file-name-rules.test.ts` (new)

**Interfaces:**
- Produces (WEB signatures):
  - `FileNameRules { forbiddenChars: string; forbiddenNames: string[] }`
  - `FileNameProblem = { kind: 'chars'; chars: string } | { kind: 'reserved' }`
  - `fileNameRulesFrom(capability): FileNameRules | null`
  - `fileNameProblem(name, rules): FileNameProblem | null`
  - `acceptedFileName(name, rules): string`
- Consumes: the `getAccountCapability` mock from Task 12.

- [ ] **Step 1: Write the failing tests**

Port WEB `lib/__tests__/file-name-rules.test.ts`, all three cases:
- `has no rules for servers that publish none (Stalwart before 0.16.6)`
- `reports forbidden characters and reserved names`
- `turns an uploaded name into one the server accepts`

Add `matches a reserved name only as the whole name`: `CON` is reserved, `CON.txt` is not.

- [ ] **Step 2: Run to verify they fail**

Run `npx vitest run src/lib/__tests__/file-name-rules.test.ts`.

Expected: FAIL.

- [ ] **Step 3: Implement**

- New folder and rename: keep the existing `/` check. Add `fileNameProblem` and show an alert that names the forbidden characters, or says the name is reserved. Use WEB's keys `files.name_forbidden_chars` (with `{chars}`) and `files.name_reserved`.
- Upload: pass the name through `acceptedFileName` before `getUniqueName`.

- [ ] **Step 4: Run to verify they pass**

Run `npx vitest run src/lib src/api` and then `npm run typecheck && npm run i18n:check`.

Expected: PASS.

- [ ] **Step 5: Commit**

`fix: check file and folder names against the server's rules before saving them`

---

### Task 14: Copy a folder with everything in it

**Files:**
- Modify:
  - `src/api/files.ts`: `copyFileNode` `:374-390`, including its comment;
  - `src/screens/FilesScreen.tsx`: `duplicateFile` `:521-527`.
- Test: `src/api/__tests__/files.test.ts`

**Interfaces:**
- Consumes: the `createFileNode` private helper (Task 11), so name clashes rename.
- Produces: `copyFileNode(node: FileNode, parentId: string | null, newName?: string, tree?: FileNode[]): Promise<FileNode>`.
  - A file copies as today.
  - A folder creates itself, then recursively copies each child where `n.parentId === node.id`, into the new folder's id. The children come from `tree`, or from the existing all-nodes fetch (`files.ts:106-140`) when no tree is given (WEB `:8273-8316`).
  - Cross-account copy stays out of scope: shared rows remain blocked in `duplicateFile`.

- [ ] **Step 1: Write the failing tests**

- `copies a folder with its whole subtree`, after WEB `jmap-filenode-writes.test.ts:71`. Use a folder containing a file and a subfolder that contains a file, and assert:
  - four creates;
  - the right parent ids;
  - the files reuse `blobId`.
- `copies an empty folder`.

- [ ] **Step 2: Run to verify they fail**

Run `npx vitest run src/api/__tests__/files.test.ts`.

Expected: FAIL. Today the code throws "Folders cannot be duplicated".

- [ ] **Step 3: Implement**

Do the recursion as specified. In `duplicateFile`, drop the `isFolder(row)` early return and pass the screen's loaded node list as `tree`.

- [ ] **Step 4: Run to verify they pass**

Run the same command, then `npm run typecheck`.

Expected: PASS.

- [ ] **Step 5: Commit, then close the phase**

`feat: copy a folder with everything in it`

After the final whole-branch review, tick the 12 roadmap rows' parity items with their commit hashes, and update the counts table in `PARITY_CHECKLIST.md` in one `docs:` commit. Then run:

```bash
npm run typecheck && npm test && npm run i18n:check
```

Expected: all pass.
