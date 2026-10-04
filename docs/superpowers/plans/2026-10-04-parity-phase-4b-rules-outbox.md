# Parity Phase 4b: Rules from a Message and the Offline Send Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two features held back from Phase 4a because they need design:
- creating a filter rule from a message, with "apply to existing messages" and undo (webmail parity);
- an offline send queue, so a message sent with no connection goes out when the connection returns (app-only; webmail has none).

**Architecture:**
- **Rules** port webmail's split:
  - pure modules in `src/lib/filters/` (quick-rule building and merging, retroactive matching and planning);
  - an account-scoped read-modify-write of the Sieve script with a byte-exact undo snapshot;
  - a flow module that the screens call.
  - The screens only add entries and sheets.
- **Send queue:**
  - a new per-account store, separate from the existing per-message outbox;
  - a replay engine that marks each entry "sending" before its request and reconciles any entry whose outcome is unknown against Sent and Drafts by Message-ID before it resends;
  - an Outbox screen for queued, failed and uncertain sends.

**Tech Stack:** React Native / Expo, TypeScript, Zustand, AsyncStorage, vitest (`npm test`), JMAP (RFC 8620/8621, Sieve RFC 9661 `SieveScript/*`, `EmailSubmission`).

**Spec:**
- **Rules:** [03-email-viewer.md](../../parity/03-email-viewer.md) "No 'Rules' entry on a message" (P2). Webmail's implementation is the authority: WEB `lib/filters/quick-rules.ts`, `lib/filters/retroactive.ts`, `lib/filters/quick-rule-flow.ts`, `lib/filters/quick-rule-target.ts`, `lib/filters/account-filters.ts`, `components/email/rules-menu.tsx`, `components/filters/filter-rule-modal.tsx`, and their tests.
- **Send queue:** [09-jmap-core-sync-security.md](../../parity/09-jmap-core-sync-security.md) "Send has no offline path and no draft fallback" (P2) and [04-composer-send.md](../../parity/04-composer-send.md) "Offline send is not queued" (P3). There is no webmail source. The design in Tasks 7–11 is the spec, and its first rule is **never send a message twice**.
- The Phase 4 row of [2026-10-04-webmail-parity-roadmap.md](2026-10-04-webmail-parity-roadmap.md).

Webmail reference: `origin/main` at `7e1a659`.

## Global Constraints

- **Branch:** `parity/phase-4b-rules-outbox`, created from `main` at `37c7ba1`.
- **Webmail reference:** `git clone https://github.com/bulwarkmail/webmail <dir> && git -C <dir> checkout 7e1a659`. "WEB `path`" means a path in that checkout.
- **Gate on every commit:** `npm run typecheck && npm test && npm run i18n:check`.
- **Strings:**
  - Use `t('key', 'English fallback')` with the webmail key the task names.
  - A webmail key missing from the vendored `locales/en/common.json` is harvested into `locales/rn/en.json` with webmail's exact English (`npm run i18n:harvest`).
  - Keys for the send queue are app-only and go under `outbox.*` in `locales/rn/en.json`.
- **Commits:** one per task, with the task's subject. End each with `Co-Authored-By:` and `Claude-Session:` trailers. Stage files by explicit path only.
- **Parity docs:** do not edit `docs/parity/*.md` or `PARITY_CHECKLIST.md` in a task.
- **Tests:** vitest runs `src/**/__tests__/**/*.test.ts` in node, with no React Native render harness. Write tests first and record RED. Keep logic out of screens so it can be tested.
- **Storage:** never delete `webmail:outbox:v1:*` keys. The send queue uses its own prefix, `webmail:sendqueue:v1:`.
- **Sender text:**
  - Any regex or glob over message headers or bodies is bounded in input length.
  - Any regex or glob is linear on hostile input, with a timing test of 200 KB inputs under a 1000 ms ceiling.
  - Sieve `:matches` patterns are matched by an iterative matcher, never compiled into a backtracking regex.
- **Accounts:**
  - Every account-scoped call passes the item's own account explicitly: a rule write, a retroactive query or patch, and a queued send.
  - Nothing defaults to `jmapClient.accountId` for an item that carries an account.

## Review Focus

1. **A queued message is never sent twice.** Covered cases:
   - the app is killed after the send request leaves and before the reply arrives;
   - a timeout;
   - `SendUnconfirmedError`.
   An entry in `sending` or `uncertain` state is resent only after reconciliation proves no copy was submitted. Owned by Task 8, tests `a send interrupted mid-request is reconciled, not resent` and `an entry found in Sent is completed without a second send`.
2. **A hand-edited (opaque) filter script is never overwritten** by a rule from a message, and a script changed on the server since the rule was written is never overwritten by Undo. Owned by Task 3, tests `refuses an opaque script` and `undo refuses when the script changed since`.
3. **Applying a rule to existing messages touches only matching messages in the one source folder of the message's own account**, and skips Junk-keyword mail unless the rule includes spam. Owned by Tasks 2 and 4, tests `planRetroactive only plans matching messages` and `apply uses the message's account and source folder`.
4. **A send queued from account A replays only through account A**, with A's identity, even if B is active when the connection returns. Owned by Task 8, test `waits for its own account`.
5. **Nothing queued is lost silently.** Each failed or uncertain send stays visible in the Outbox until the user retries, saves it as a draft, or discards it. Signing out of an account with queued sends asks first. Owned by Tasks 10 and 11.

## Not in this phase

- **Rules from a list row's context menu.** The list has no per-row menu. The rules entry goes in the selection bar (Task 6) instead.
- **The toast's "Edit rule" action.** "Manage rules" in the Rules sheet covers it. The toast gets Undo and "Apply to N existing" only.
- **Queuing attachments added while offline.** Uploads need a connection, and `canSend` already blocks a send while any upload is pending or failed. A message can be queued only when every attachment has a blob id.
- **Saving a draft while offline.** Autosave still needs the server.
- **Replaying a queued send through a detached client for a non-active account.** The queue waits until its account is active, and the Outbox says so.

---

## Part A: Rules from a message

### Task 1: Port the quick-rule builder

**Files:**
- Create: `src/lib/filters/quick-rules.ts`, a port of WEB `lib/filters/quick-rules.ts`
- Test: `src/lib/filters/__tests__/quick-rules.test.ts`, a port of WEB `lib/filters/__tests__/quick-rules.test.ts`
- Read only: `src/lib/sieve/types.ts`, the native rule model, which already matches webmail's (`address_is`, `domain_is`, array values, `includeSpam`, `mailboxId`)

**Interfaces** (WEB names and shapes):
- Exports:
  - `collectSenders(emails, ownAddresses)`, `sharedDomain(senders)`, `extractListId(raw)`, `sharedListId(listIds)`, `stripSubjectPrefixes(subject)`;
  - `buildPresetRule(kind, { senders, domain?, listId?, mailbox?, tagId?, junk? })`, where `kind` is `'move_sender' | 'move_domain' | 'move_list' | 'mark_read' | 'tag' | 'block'`;
  - `buildPrefillRule(senders, name)`, `buildSuggestions(...)`;
  - `applyQuickRule(rules, candidate)`, which returns `{ outcome: 'created' | 'merged' | 'covered', rules, rule }`;
  - `insertRuleAtTop(rules, rule)`, `replaceOrInsertRule(rules, rule)`;
  - `rulesMenuAvailability({ shared, supportsSieve, accountsInSelection })`, which returns `'hidden' | 'cross_account' | 'available'`;
  - `ruleTargetMailboxIds(mailboxes)`.
- Native headers are an array of `{ name, value }`, not a record, so give the port a small `headerValue(email, name)` adapter.
- `insertRuleAtTop` puts the new rule first among Bulwark rules, before any external (unmanaged) block that the native filter store keeps. Read `src/stores/filter-store.ts` `addRule` to see how external rules are held, and keep them intact.

- [ ] **Step 1: Write the failing tests.** Port every WEB `quick-rules.test.ts` case. Add `insertRuleAtTop keeps external rules where they were`.
- [ ] **Step 2: Run them to verify they fail.** `npx vitest run src/lib/filters/__tests__/quick-rules.test.ts`; expect "Cannot find module".
- [ ] **Step 3: Implement the port.**
- [ ] **Step 4: Run them to verify they pass.**
- [ ] **Step 5: Commit** `feat: build filter rules from a message's senders, domain and list`

### Task 2: Port retroactive matching, and query emails with chosen fields

**Files:**
- Create: `src/lib/filters/retroactive.ts`, a port of WEB `lib/filters/retroactive.ts`
- Modify: `src/api/email.ts`, adding `queryEmailFields`
- Test: `src/lib/filters/__tests__/retroactive.test.ts` (a port of WEB `retroactive.test.ts`) and `src/api/__tests__/email.test.ts`

**Interfaces:**
- From WEB: `retroactiveSupport(rule)`, `sieveMatches(value, pattern)`, `ruleMatches(rule, message)`, `retroQueryFilter(rule, sourceMailboxId)`, `retroProperties(rule)`, `toRetroMessage(email)`, and `planRetroactive(rule, messages)`, which returns ordered steps (flags, then the first move, then copies).
- `queryEmailFields(filter, properties, { accountId, pageSize = 500, max = 10000 })` returns `Promise<Array<Record<string, unknown>>>`. Each page is one request: `Email/query` sorted by `receivedAt` descending, plus a back-referenced `Email/get` with `properties`. It passes `accountId` explicitly.
- `sieveMatches` is an iterative `*`/`?` glob matcher with ascii-casemap. No regex is built from the pattern.
- Header values passed to `ruleMatches` are cut to 4 KB each before matching.

- [ ] **Step 1: Write the failing tests.**
  - Port every WEB case.
  - Add `planRetroactive only plans matching messages` (Review Focus 3).
  - Add a junk-keyword message skipped unless `includeSpam`.
  - Add `sieveMatches is linear on hostile patterns`: a 200 KB value of `a`, with pattern `*a*a*a*a*b` and similar shapes, under 1000 ms.
  - Add a `queryEmailFields` test for request shape, paging to `max`, and the explicit `accountId`.
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to verify they pass.**
- [ ] **Step 5: Commit** `feat: find and plan existing messages a filter rule matches`

### Task 3: Write a rule into an account's filters, with an exact undo

**Files:**
- Create: `src/lib/filters/account-filters.ts`, a port of WEB `lib/filters/account-filters.ts`
- Test: `src/lib/filters/__tests__/account-filters.test.ts`, a port of WEB `account-filters.test.ts`

**Interfaces:**
- `readAccountFilters(accountId)` returns `{ rules, isOpaque, vacation, externalRequires, includeVacation, scriptId, content, active }`. It uses `src/api/sieve.ts` with the explicit `accountId` and `parseScript`, and skips the vacation script as `filter-store`'s `loadManagedScript` does.
- `updateAccountFilters(accountId, modify: (rules) => FilterRule[] | null)` returns `Promise<FiltersChange | null>`:
  - it re-reads right before writing;
  - it throws `OpaqueFiltersError` for a hand-edited script;
  - a `null` from `modify` writes nothing;
  - otherwise it generates the script with `generateScript` (keeping external requires, the vacation include and capabilities, as `filter-store.saveFilters` does), then updates or creates and activates it.
- `FiltersChange` is `{ accountId, scriptId, created, previousContent, previousActiveId, writtenContent }`.
- `restoreAccountFilters(change)`:
  - it throws `FiltersChangedError` when the server script no longer equals `writtenContent` byte for byte;
  - otherwise it restores `previousContent` and the previously active script, or deletes the script if the write created it.
- After a write or restore for the account the filter store is showing, call `useFilterStore.getState().fetchFilters()` so the settings screen is current.

- [ ] **Step 1: Write the failing tests.**
  - Port every WEB case.
  - Must include `refuses an opaque script` and `undo refuses when the script changed since` (Review Focus 2).
  - Add a write against account B that never touches account A's script.
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to verify they pass.**
- [ ] **Step 5: Commit** `feat: write a filter rule into an account's script with an exact undo`

### Task 4: The quick-rule flow, and a second toast action

**Files:**
- Create: `src/lib/filters/quick-rule-flow.ts`, ported from WEB `lib/filters/quick-rule-flow.ts` and `quick-rule-target.ts`
- Modify: `src/stores/toast-store.ts` (an optional `secondaryAction`) and `src/components/ToastHost.tsx` (render it)
- Test: `src/lib/filters/__tests__/quick-rule-flow.test.ts` (WEB `quick-rule-flow.test.ts` and `quick-rule-target.test.ts` cases) and `src/stores/__tests__/toast-store.test.ts`

**Interfaces:**
- `resolveQuickRuleTarget(email, { viewedAccountId?, sourceMailboxId? })` returns `{ appAccountId, jmapAccountId, sieveAccountId, shared, supportsSieve, mailboxes, sourceMailboxId }`.
  - The account comes from `viewedAccountId` or the row's own stamp (email-store `rowAccountId`).
  - `shared` is true for a shared or team account, which hides Rules, as webmail does.
- `runPresetRule(kind, emails, opts)`:
  - builds the rule with Task 1;
  - writes it with `updateAccountFilters` and `applyQuickRule`;
  - shows `notifications.rule_created`, `rule_merged` or `rule_already_covered`.
  - The toast's `action` is Undo (`restoreAccountFilters`, then `notifications.rule_undone`, `rule_undo_failed` or `rule_undo_conflict`).
  - Its `secondaryAction` is "Apply to N existing" (`notifications.rule_apply_existing`). It appears only when the plan counts N > 0, and the duration is 12 s.
- `saveEditorRule(rule, { applyToExisting })` is the "Create rule…" path. It inserts at the top and, when `applyToExisting` is set, applies the rule immediately.
- `applyToExisting(rule, target)`:
  - plans on the server: `queryEmailFields(retroQueryFilter(rule, target.sourceMailboxId), retroProperties(rule), { accountId: target.jmapAccountId })`, then `planRetroactive`;
  - executes the plan with explicit-account API calls (`moveEmails`, `patchKeywordsForEmails`, `copyEmailsWithinAccount`) in batches of `maxObjectsInSet`;
  - patches loaded rows (`setEmailKeywordsLocal` or the existing list refresh);
  - shows `notifications.rule_applied` or `rule_apply_failed`.
  - Retroactive changes are not undone, as in webmail.
- Toast:
  - `ToastOptions.secondaryAction?: { label: string; onPress: () => void }`, shown as a second button.
  - Each action dismisses the toast.
  - Existing callers are unchanged.

- [ ] **Step 1: Write the failing tests.**
  - Port the WEB flow and target cases, with mocked API and account helpers.
  - Add `apply uses the message's account and source folder` (Review Focus 3): a team-account message with the same bare mailbox id as the user's own folder.
  - Add a toast-store test for `secondaryAction`.
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to verify they pass.** Then run `npm run typecheck && npm run i18n:check`, harvesting the `notifications.rule_*` keys.
- [ ] **Step 5: Commit** `feat: save a rule from a message, undo it, or apply it to existing mail`

### Task 5: Prefill, suggestions and "apply to existing" in the rule editor

**Files:**
- Modify: `src/components/filters/FilterRuleModal.tsx` (props `:58-66`, seeding `:81-92`)
- Create: `src/lib/filters/rule-suggestions.ts`, a pure helper that applies a suggestion chip to a draft rule (`applySuggestion(rule, suggestion)`, including WEB `replaces` for the domain chip)
- Test: `src/lib/filters/__tests__/rule-suggestions.test.ts`

**Interfaces** (WEB `components/filters/filter-rule-modal.tsx:32-47, 406-415, 690-711`):
- New props:
  - `initialRule?: FilterRule`, a prefill that saves as a new rule (unlike `rule`, which edits in place);
  - `suggestions?: RuleSuggestion[]`, rendered as chips;
  - `offerApplyToExisting?: boolean`, which renders the checkbox `settings.filters.apply_existing`.
- The checkbox is disabled, with `settings.filters.apply_existing_unsupported`, when `retroactiveSupport(rule)` is not ok.
- `onSave(rule, { applyToExisting })`. The existing callers (FilterSettings) ignore the second argument.
- Keys:
  - chips: `settings.filters.suggestions`, `suggest_subject`, `suggest_to`, `suggest_cc`, `suggest_list`, `suggest_domain`;
  - names: `settings.filters.quick_rule_names.*`.

- [ ] **Step 1: Write the failing tests.** `applySuggestion` adds the subject, to, cc and list conditions. The domain chip replaces the sender condition. Applying the same chip twice is a no-op.
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement the helper and the modal props.** The modal stays thin and calls the helper.
- [ ] **Step 4: Run them to verify they pass.** Then run `npm run typecheck && npm run i18n:check`.
- [ ] **Step 5: Commit** `feat: prefill the rule editor from a message and offer to apply it`

### Task 6: A "Rules" entry in the viewer and the list selection bar

**Files:**
- Create: `src/components/filters/RulesSheet.tsx`, the preset list as an `ActionSheet`, plus a pure `rulesSheetItems(model)` in `src/lib/filters/rules-sheet.ts` with its test
- Modify:
  - `src/screens/EmailThreadScreen.tsx`: a `MoreMenuSheet` item after "Move to…" (~:1273), and a prop;
  - `src/screens/EmailListScreen.tsx`: the selection bar (~:999-1105), as an overflow item using `selectedEmails`.
- Test: `src/lib/filters/__tests__/rules-sheet.test.ts`, with the WEB `rules-menu.test.tsx` cases as pure-model tests

**Interfaces** (WEB `components/email/rules-menu.tsx`; keys `context_menu.rules.*`):
- `rulesSheetItems({ availability, senders, domain, listId, hasJunk, opaque })` returns the visible items with `disabled` and a hint:
  - move from sender;
  - move from domain (only when every sender shares one domain);
  - move from list (only when a shared List-Id exists);
  - mark read;
  - tag;
  - block (disabled with `context_menu.rules.no_junk` when there is no Junk folder);
  - Create rule…;
  - Manage rules.
- When the script is opaque, every item except Manage rules is disabled with `context_menu.rules.opaque_hint`.
- `cross_account` disables every item with `context_menu.rules.cross_account`.
- The folder pickers:
  - move uses `MoveSheet` with `title`, limited to `ruleTargetMailboxIds`;
  - tag uses the existing tag sheet;
  - "New folder…" is not offered (not in this phase).
- List-Id: the viewer has headers. For list rows, fetch `header:List-Id:asText` and the raw `header:List-Id` for the selected ids, as WEB `loadListIds` does, with an explicit account.
- Manage rules navigates to the filter settings screen for the message's account.

- [ ] **Step 1: Write the failing tests.** Hidden for shared accounts, cross-account disabled, opaque locked, Block disabled without Junk, the domain item only for one shared domain, and own addresses excluded from senders.
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement the model, the sheet and both entries.**
- [ ] **Step 4: Run them to verify they pass.** Then run `npm run typecheck && npm run i18n:check`.
- [ ] **Step 5: Commit** `feat: create a rule from a message in the viewer or a selection`

Device check (human): from a newsletter, run "Always move messages from this list" to a folder, apply it to existing messages, then Undo. The rule disappears from Filters, and the moved messages stay moved.

---

## Part B: Offline send queue (app-only)

### Task 7: The send-queue store

**Files:**
- Create: `src/stores/send-queue-store.ts`
- Test: `src/stores/__tests__/send-queue-store.test.ts`

**Interfaces:**
- `QueuedSend`:
  ```ts
  {
    id: string; appAccountId: string; jmapAccountId: string; identityId: string;
    outgoing: OutgoingEmail;         // from src/api/email.ts; attachments as blob ids only
    messageId: string;               // the Message-ID the send will carry (outgoing.messageId)
    draftId?: string;                // server draft to remove after a successful send
    sendAt?: string;                 // ISO time for a scheduled send; absent = send now
    replyTo?: { emailIds: string[]; keyword: '$answered' | '$forwarded' };
    createdAt: string; state: 'queued' | 'sending' | 'uncertain' | 'failed';
    attemptStartedAt?: string; lastError?: string;
  }
  ```
- The store `{ entries, hydrateAccount(appAccountId), enqueue(entry), markSending(id), complete(id), markUncertain(id, error), markFailed(id, error), requeue(id), discard(id), clearAccount(appAccountId) }`.
  - Each method persists before it resolves.
  - `markSending` must be persisted before any request is made.
- The storage key is `webmail:sendqueue:v1:<appAccountId>`, holding a JSON array.
- `enqueue` refuses an entry whose serialized size exceeds 1 MB, throwing `SendTooLargeToQueueError`.
- `messageId` is required. If `outgoing.messageId` is missing, `enqueue` throws.
- Hydration repairs state: an entry persisted as `sending` becomes `uncertain`, because the app may have been killed mid-request.

- [ ] **Step 1: Write the failing tests.**
  - `sending` is persisted before it resolves.
  - A hydrated `sending` entry becomes `uncertain`.
  - Accounts are kept apart.
  - The size cap.
  - The missing-Message-ID refusal.
  - `discard` removes only that entry.
  - No `webmail:outbox:v1:*` key is ever touched.
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to verify they pass.**
- [ ] **Step 5: Commit** `feat: keep messages to send when the device is offline`

### Task 8: Replay queued sends, and reconcile an unknown outcome before resending

**Files:**
- Create:
  - `src/lib/send-queue-replay.ts`;
  - `src/api/sent-lookup.ts`, with `findCopiesByMessageId(messageId, { accountId, mailboxIds, since })`.
- Modify: `App.tsx`, adding replay triggers next to the outbox flush triggers (~:487-496, ~:783).
- Test: `src/lib/__tests__/send-queue-replay.test.ts` and `src/api/__tests__/sent-lookup.test.ts`

**Interfaces:**
- `flushSendQueue()`:
  - **Concurrency:** one flush at a time.
  - **Preconditions:** it runs only when `useNetworkStore` is online, `jmapClient.isConnected`, and `clientServesActiveAccount()` (src/lib/active-client-account.ts) holds. It processes only entries whose `appAccountId` is the active app account (Review Focus 4).
  - **Order:** oldest first. Before each entry, it re-checks the account and connectivity.
- **Per entry, by state:**
  - `failed`: skipped. Only the user requeues it.
  - `uncertain`: reconcile with `findCopiesByMessageId` over the account's Sent and Drafts mailboxes (resolved by role at replay), with `since` set to `attemptStartedAt` minus 10 minutes:
    - a copy without `$draft` (submitted): `complete(id)` and the post-send effects, and **no send**;
    - only `$draft` copies (created, never submitted): destroy those copies, then `requeue(id)`;
    - no copy: `requeue(id)`;
    - the lookup fails or is ambiguous: leave the entry `uncertain` for the user, and send nothing.
  - `queued`:
    1. `markSending(id)`, persisted first.
    2. Call `sendEmail(entry.outgoing, entry.identityId, sentId, holdFor, { draftsMailboxId, draftId, accountId: entry.jmapAccountId })`. `holdFor` is recomputed from `sendAt`; a past `sendAt` means 0. Sent and Drafts are resolved by role for that account at replay. No undo-send delay is applied.
    3. Handle the outcome:

       | Outcome | Next state |
       |---|---|
       | Success | `complete(id)` |
       | `RecipientsRejectedError`, `ScheduleTooLateError`, or a JMAP `notCreated` / `blobNotFound` / `forbiddenFrom` / invalid identity | `markFailed(id, message)` |
       | Any network error, `RequestTimeoutError` or `SendUnconfirmedError` | `markUncertain(id, message)`; never retried blind |
       | An auth error | `requeue(id)`, then stop the flush (the outbox pauses the same way) |
- **Post-send effects** (both on success and on a reconciled submitted copy):
  - flag `replyTo.emailIds` with the keyword through `patchKeywordsForEmails(ids, patch, entry.jmapAccountId)`, best effort;
  - add the trusted senders, excluding refused recipients, as `ComposeScreen.performSendInner` does (extract that into a shared helper rather than copying it);
  - show a toast, `outbox.sent` "Sent: {subject}".
- `findCopiesByMessageId` does not use the JMAP `header` filter, which Stalwart 0.16 does not match. It queries `{ inMailbox, after: since }` for each mailbox, sorted by `receivedAt` descending, up to 200, then gets `messageId`, `keywords` and `mailboxIds`, and compares `messageId` client-side.
- **Triggers:** the same points the outbox flushes (live session established, offline→online edge, resume), plus right after `enqueue` when online.

- [ ] **Step 1: Write the failing tests**, with mocked API, network and account helpers:
  - `a send interrupted mid-request is reconciled, not resent` (Review Focus 1). A hydrated `sending` entry with a submitted copy in Sent gives no `sendEmail` call and `complete`.
  - `an entry found in Sent is completed without a second send`.
  - A `$draft`-only copy is destroyed, then sent once.
  - No copy found: sent once.
  - The lookup fails: still `uncertain`, no send.
  - `waits for its own account` (Review Focus 4). An entry for A while B is active is not sent; after switching to A it is sent with A's `jmapAccountId` and identity.
  - Each error class maps to its state.
  - A past `sendAt` gives `holdFor` 0.
  - Two concurrent `flushSendQueue` calls send once.
  - The lookup's request shape.
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to verify they pass.**
- [ ] **Step 5: Commit** `feat: send queued messages when back online without ever sending twice`

### Task 9: Queue from the composer and quick reply when offline

**Files:**
- Modify:
  - `src/screens/ComposeScreen.tsx` (`performSendInner` ~:2315-2437);
  - `src/components/email/QuickReplyBox.tsx` (~:100-155).
- Create: `src/lib/queue-send.ts`, the pure `buildQueuedSend(...)` used by both, plus the decision `shouldQueueSend({ online, uploadsDone })`.
- Test: `src/lib/__tests__/queue-send.test.ts`

**Interfaces:**
- The queue path is taken only when `useNetworkStore.getState().online === false` at the moment of sending, after every confirm (empty subject, attachment reminder) and the owner check.
- Online sends, and a network error during an online send, behave exactly as today: the existing "Send failed" alert, which may say "may already have gone out". No auto-queue after a request was attempted.
- The queue path:
  1. builds `outgoing` with `buildOutgoing(...)` as the online send does, keeping `messageIdRef`;
  2. calls `enqueue(buildQueuedSend(...))` with the composer owner's `appAccountId` and `jmapAccountId`, the identity, `draftId`, `sendAt` (an absolute ISO time when the user picked a schedule) and `replyTo`;
  3. shows the toast `outbox.queued` "Will send when you're back online";
  4. closes the composer.
- The undo-send hold is not recorded for queued sends.
- A `SendTooLargeToQueueError` shows `outbox.too_large` and keeps the composer open.
- QuickReplyBox does the same, with its `jmapAccountId`.

- [ ] **Step 1: Write the failing tests.** `buildQueuedSend` carries the owner account (not the active account), the identity, `messageId`, `draftId`, an absolute `sendAt` and `replyTo`. `shouldQueueSend` is false online and false while uploads are pending.
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement the helpers and wire both callers.**
- [ ] **Step 4: Run them to verify they pass.** Then run `npm run typecheck && npm run i18n:check`.
- [ ] **Step 5: Commit** `feat: queue a message sent while offline`

### Task 10: The Outbox screen

**Files:**
- Create: `src/screens/OutboxScreen.tsx`, plus a pure `outboxRows(entries, now)` in `src/lib/outbox-rows.ts` with its test
- Modify:
  - navigation (register the screen);
  - `src/components/OfflineBanner.tsx` (count queued sends with pending changes, and tap opens Outbox);
  - `src/components/settings/AboutDataSettings.tsx` (a row to open Outbox);
  - the mailbox drawer (an "Outbox (n)" entry while n > 0);
  - `src/widgets/build.ts` `readPendingChanges` (add the send-queue count).
- Test: `src/lib/__tests__/outbox-rows.test.ts`

**Interfaces:**
- Each row shows the subject, recipients and state label:
  - `outbox.state.queued` "Waiting for connection";
  - `outbox.state.waiting_account` "Waiting — switch to {account} to send";
  - `outbox.state.sending` "Sending…";
  - `outbox.state.uncertain` "May have been sent — check Sent";
  - `outbox.state.failed` "Not sent: {error}".
- Actions:
  - **Retry** (`requeue` then flush), for failed and uncertain rows. For uncertain rows it first asks "This message may already have been sent. Send again?".
  - **Save as draft**: creates a server draft from `outgoing` through the existing draft-save API with an explicit account, then discards the entry. It is offered when online.
  - **Discard**, after a confirmation.
- A failed or uncertain send also shows a toast, `outbox.failed`, once, with an "Open Outbox" action.

- [ ] **Step 1: Write the failing tests.** `outboxRows` gives the state labels, the waiting-for-account state, the order, and which actions each state offers.
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to verify they pass.** Then run `npm run typecheck && npm run i18n:check`.
- [ ] **Step 5: Commit** `feat: show queued, failed and uncertain sends in an Outbox`

### Task 11: Sign-out and account removal with queued sends

**Files:**
- Modify:
  - `src/stores/auth-store.ts` (sign-out and remove-account paths);
  - `src/stores/account-data-cleanup.ts` (~:21-76);
  - the sign-out confirmation UI the app already uses.
- Test: `src/stores/__tests__/account-data-cleanup.test.ts`

**Interfaces:**
- Before signing out of, or removing, an account whose send queue is not empty, ask: `outbox.signout_confirm`, "{count} unsent messages will be deleted. Sign out anyway?". Offer "Open Outbox" and "Sign out".
- On confirm, `clearAccount(appAccountId)` deletes only `webmail:sendqueue:v1:<appAccountId>`. `webmail:outbox:v1:*` keys stay, as today.
- "Sign out of all accounts" sums the counts.

- [ ] **Step 1: Write the failing tests.**
  - Cleanup removes the send-queue key for that account only.
  - Outbox keys survive.
  - A pure `signOutNeedsConfirm(counts)` helper is true only when something is queued.
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to verify they pass.**
- [ ] **Step 5: Commit, then close the phase.** Commit `feat: ask before signing out with unsent messages`. After the final review, tick the parity items and update the counts in one `docs:` commit.

Device checks (human):
- Airplane mode: compose and send, then reconnect. The message arrives once.
- Kill the app right after reconnecting while a large message sends, then reopen. The message is not sent twice.
- With a send queued for account A, switch to B and reconnect. The send waits for A, and the Outbox says so.
