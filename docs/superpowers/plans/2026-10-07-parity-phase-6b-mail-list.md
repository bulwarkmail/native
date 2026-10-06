# Parity Phase 6b: Mail List, Search and Global Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- Close the open mail list, folder and search parity items.
- Add webmail's global search: one search across mail, contacts, calendar and files.

**Architecture:**
- Search fixes stay in the email store and the existing search bar.
- Global search ports webmail's pure modules into `src/lib/global-search/`: the query parser, ranking and merging, hit types and the orchestrator. It adds native providers and a `GlobalSearch` stack screen.
- Every hit carries `{ appAccountId, jmapAccountId, rawId }` and is never looked up again by id alone.
- Requests use hardening pass 1's scope tools: `opScope`, `inAccount`, `isShownAccount`, `requireShownAccountScope`, `StaleLoadError`.

**Tech Stack:** React Native / Expo, TypeScript, Zustand, vitest, JMAP (`Email/query`, `SearchSnippet/get`, `ContactCard/query`, `CalendarEvent/query`, `FileNode/get`).

**Spec:**
- The open items in [02-mail-list-folders.md](../../parity/02-mail-list-folders.md).
- Two decisions the user made on 2026-10-07:
  - **start folder:** open the Inbox on start, like webmail, with a setting to reopen the last folder instead;
  - **global search:** include it (#641, #847).
- Webmail at `7e1a659` is the authority. For global search the reference files are:
  - `lib/global-search/*`, `stores/global-search-store.ts` and `hooks/use-global-search.ts`;
  - `components/global-search/*`;
  - the tests under `lib/global-search/__tests__/`.

## Global Constraints

- **Branch:** `parity/phase-6b-mail-list`, from `main` at `9b9a798`.
- **Gate on every commit:** `npm run typecheck && npm test && npm run i18n:check`.
- **Strings:** use `t('key', 'English fallback')` with webmail's key. The `global_search.*` and `nav.global_search` keys are already vendored.
- **Commits:** one per task, with the task's subject and the `Co-Authored-By:` and `Claude-Session:` trailers. Stage by explicit path.
- **Parity docs:** do not edit `docs/parity/*.md` or `PARITY_CHECKLIST.md` in a task.
- **Tests:** vitest in node, with no RN render harness. Write tests first and record RED.
- **Accounts:**
  - Every request and write carries its own account.
  - Async results are dropped if the account they belong to is no longer the one shown (or, for detached reads, if the request was superseded).
  - Opening a hit from another account switches first, then checks `isShownAccount(hit.appAccountId)` before navigating.
- **Sender text:** any regex over message content is bounded and linear, with a 200 KB timing test at a 1000 ms ceiling.

## Review Focus

1. **A global-search hit always opens in the account it came from.** Two accounts whose message, contact, event or file ids collide (both `1`) open their own item. Owned by Tasks 9 and 10.
2. **A search result that lands after an account switch is never shown under the new account.** Owned by Tasks 1 and 9.
3. **Search terms are sent as typed**, so a word ending in a letter still finds the message on Stalwart. Owned by Task 1.
4. **"Empty folder" on an ordinary folder moves the mail to Trash rather than destroying it**, and still asks for confirmation. Owned by Task 5.
5. **Changing the start-folder setting never loses the last folder in a session.** Owned by Task 7.

## Not in this phase

- **Mail folder sharing and share notifications.** This needs a share dialog and notification store; plan it on its own.
- **Folder reorder (sortOrder), custom folder icons and the colourful-icon toggle.** Cosmetic, and there is no drag-and-drop on mobile.
- **Tag visibility, nesting, reorder and rename migration.**
- **The regional date-locale setting.** This belongs to area 08.
- **Global search across other accounts for contacts, calendar and files.** The app has no detached read path for those types. They search the shown account. Mail searches every account through the existing detached path.

---

### Task 1: Send search terms as typed, and add a size filter

**Closes (02):**
- "Search still appends a wildcard to every term".
- "No message-size filter in advanced search".

**Files:**
- Modify:
  - `src/lib/search-utils.ts` (`toWildcardQuery`);
  - `src/stores/email-store.ts` (`buildJmapFilter` ~:553-590, `EmailFilters`);
  - `src/api/unified-inbox.ts` (~:364);
  - `src/api/email.ts` (~:1343);
  - the search filter UI in `src/screens/EmailListScreen.tsx`.
- Test: the search-utils and email-store tests.

**Interfaces:**
- Follow WEB `lib/jmap/search-utils.ts:37-82`:
  - send `{ text }` as typed;
  - `minSize` / `maxSize` come from a size filter with webmail's preset options and keys (`components/search/search-chips.tsx`).
- Remove the `toWildcardQuery` call at every call site.
- Keep the active-account search stale-safe: a result that lands after a switch is dropped (Review Focus 2). Check what the store does today and add a test.

- [ ] **Step 1: Write the failing tests.** Terms are sent as typed in all three paths. The size filter maps to `minSize`/`maxSize`. A stale search result is dropped.
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to verify they pass.**
- [ ] **Step 5: Commit** `fix: search for the words as typed, and filter by message size`

### Task 2: Highlight search hits

**Closes (02):** "Search hits are not highlighted (`SearchSnippet/get`)".

**Files:**
- Create: `src/lib/search-snippet.ts`, a port of WEB `lib/search-snippet.ts`.
- Modify:
  - `src/api/email.ts` (search requests a back-referenced `SearchSnippet/get`);
  - the email store (keeps snippets per search result, keyed by account and id);
  - the row preview in `EmailListScreen.tsx` (~:88).
- Test: `src/lib/__tests__/search-snippet.test.ts`

**Interfaces:**
- Parse the server's `<mark>` snippet into text runs, never rendering HTML, and render the marked runs bold or highlighted.
- Bound the input to 4 KB and make the parse linear, with a timing test.
- Snippets clear when the search clears or the account changes.

- [ ] **Step 1: Write the failing tests.** `<mark>` parsing, entity decoding, unbalanced or nested tags, hostile input timing, and keys per account.
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to verify they pass.**
- [ ] **Step 5: Commit** `feat: highlight the words a search matched`

### Task 3: A nested folder picker in search

**Closes (02):** "Search folder picker is flat".

**Files:**
- Modify: `EmailListScreen.tsx` (~:1567-1577), reusing `MoveSheet`'s tree, or a shared tree helper, as a picker.
- Test: a pure tree helper test if logic is extracted.

**Interfaces:** follow webmail's search folder picker. Show all folders as a tree, with roles first, and select one as the search scope.

- [ ] **Step 1: Write the failing tests.**
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to verify they pass.**
- [ ] **Step 5: Commit** `feat: pick any folder for a search from a folder tree`

### Task 4: List row details

**Closes (02):**
- "Tags with no local definition are always grey" (#1052);
- "List and notification previews do not skip a leading style sheet";
- "Mail list rows have no screen-reader label" (#1008);
- "Rows jump while attachment chips load".

**Files:**
- Modify:
  - `src/stores/keywords-store.ts` (~:30), reusing `suggestKeywordColor` (`src/lib/keyword-discovery.ts:68`);
  - the preview helper used by the list row, `src/lib/push-background-task.ts` and `src/widgets/*`;
  - the row in `EmailListScreen.tsx` (~:158);
  - `src/components/email/ListAttachmentChips.tsx` (~:60-88).
- Test: the helper tests.

**Interfaces:**
- **Unknown tags:** each unknown tag gets a stable colour from `suggestKeywordColor`, as WEB does.
- **Previews:** port WEB `lib/utils.ts`'s leading-style-sheet skip into one shared preview helper used in all three places. It must be bounded and linear.
- **Row label:** a single `accessibilityLabel` (sender, subject, time, unread, attachment, flagged), plus `accessibilityRole` and `accessibilityState` (selected).
- **Attachment chips:** reserve the chip row's height when the row has attachments, and cache chip results per account and email id, as WEB `attachment-chips.tsx:98-160` does.

- [ ] **Step 1: Write the failing tests.**
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to verify they pass.**
- [ ] **Step 5: Commit** `fix: colour unknown tags, skip style sheets in previews, label rows, and keep rows still while chips load`

### Task 5: Empty any folder

**Closes (02):** "'Empty folder' is offered only for Trash and Junk".

**Files:**
- Modify: `src/components/SidebarDrawer.tsx` (~:510) and `src/api/email.ts` (~:288, `emptyMailbox`), plus the list banner if it offers the action.
- Test: the email API and store tests.

**Interfaces:**
- WEB `stores/email-store.ts:1520` (`emptyFolderMovesToTrash`) is the reference.
- On an ordinary folder, empty moves every message to Trash in batches, with the account scope that hardening pass 1 added to folder actions. In Trash and Junk it destroys, as today.
- The confirmation text says which of the two will happen (Review Focus 4).

- [ ] **Step 1: Write the failing tests.**
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to verify they pass.**
- [ ] **Step 5: Commit** `feat: empty any folder, moving ordinary mail to Trash`

### Task 6: List position and unread-first order

**Closes (02):**
- "The list may not return to the top when another folder opens";
- "An opened message may jump in the 'unread first' order".

**Files:**
- Modify: `EmailListScreen.tsx` (~:1440) and `src/stores/email-store.ts` (~:1323 `retainedIds`).
- Test: the email-store test for retention.

**Interfaces:**
- A folder change scrolls the list to the top.
- An opened message stays in place in the `unread_first` order until the list is refreshed or the folder changes, as `retainedIds` already does for the Unread filter.

- [ ] **Step 1: Write the failing tests.**
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to verify they pass.**
- [ ] **Step 5: Commit** `fix: start a folder at the top, and keep an opened message in place in unread-first order`

### Task 7: Open the Inbox on start

**Closes (02):** "The app restores the last folder on start instead of the inbox", per the user's decision of 2026-10-07.

**Files:**
- Modify:
  - `src/stores/email-store.ts` (~:783, the persisted `currentMailboxId`);
  - `src/stores/settings-store.ts` (an app-only `restoreLastFolder`, default `false`);
  - the reading or general settings screen.
- Test: the store and settings tests.

**Interfaces:**
- On a cold start the app opens the Inbox of the active account, unless `restoreLastFolder` is on.
- Within a session nothing changes (Review Focus 5).
- Deep links and notification taps still open their target.

- [ ] **Step 1: Write the failing tests.**
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to verify they pass.**
- [ ] **Step 5: Commit** `feat: open the Inbox on start, with a setting to reopen the last folder`

### Task 8: Global search, the pure core

**Files:**
- Create in `src/lib/global-search/`:
  - `query-parser.ts`, `rank.ts`, `types.ts` and `run-global-search.ts`, ported from WEB `lib/global-search/`;
  - `store.ts`, a port of WEB `stores/global-search-store.ts`, persisting `scope` only.
- Test: port WEB `lib/global-search/__tests__/{query-parser,rank,run-global-search}.test.ts` and `stores/__tests__/global-search-store.test.ts`.

**Interfaces:**
- Keep webmail's names and shapes.
- The hit type carries `{ kind, appAccountId, jmapAccountId, rawId, … }`. Webmail's `localAccountId` maps to `appAccountId`.
- The dedupe key includes the server and account, as in rank.ts (#847).
- The orchestrator's concurrency (4), timeout (8000 ms), stale-search-id drop and error rows are unchanged.

- [ ] **Step 1: Write the failing tests.** Port every WEB case.
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to verify they pass.**
- [ ] **Step 5: Commit** `feat: add webmail's global search core`

### Task 9: Global search providers

**Files:**
- Create: `src/lib/global-search/providers/{mail,contacts,calendar,files}.ts`
- Modify:
  - `src/api/calendar.ts` (a `text` filter on `CalendarEvent/query`);
  - `src/api/contacts.ts` (`queryContacts` with `text` already exists);
  - `src/api/files.ts` (a per-account cached listing, 60 s TTL, invalidated by file mutations).
- Test: `src/lib/global-search/__tests__/providers.test.ts`, porting WEB's provider cases that apply.

**Interfaces:**
- **Mail:**
  - The shown account uses `opScope()`.
  - Every other signed-in account uses the detached read path from `src/api/unified-inbox.ts` (`entryFor`). Extract a shared `searchAccountEmails(entry, filter, limit)` rather than copying it.
  - Shared and group accounts are included, as WEB does.
  - Trash/Junk exclusion and `in:trash|junk` follow WEB `mailFilterFor`.
- **Contacts:** a server `ContactCard/query {text}` plus a local match, both for the shown account.
- **Calendar:** `CalendarEvent/query {text, after?, before?}` for the shown account, with series shown once by uid.
- **Files:** the listing, filtered client-side by name and type, for the shown account.
- **Account rules:**
  - Each provider takes its scope at the start and tags hits with `{ appAccountId, jmapAccountId, rawId }`.
  - A provider whose account stops being shown drops its results (Review Focus 2).
  - Detached mail results are tagged with their own account.

- [ ] **Step 1: Write the failing tests.** For each provider: the request shape, tagging, a stale drop after a switch, and colliding ids across two accounts staying distinct (Review Focus 1).
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to verify they pass.**
- [ ] **Step 5: Commit** `feat: search mail, contacts, calendar and files for global search`

### Task 10: The global search screen and opening a hit

**Files:**
- Create:
  - `src/screens/GlobalSearchScreen.tsx`, registered in navigation;
  - `src/lib/global-search/open-hit.ts`;
  - `src/navigation/pending-files-open.ts`.
- Modify:
  - the mail search bar in `EmailListScreen.tsx` (a "Search everything" row);
  - `src/components/SidebarDrawer.tsx` (a quick row);
  - `src/screens/FilesScreen.tsx` (consume the pending files open).
- Test: `open-hit` tests, and a pure view-model test for the screen's grouping.

**Interfaces:**
- **The screen** follows WEB's palette and search tab:
  - recent searches (the existing `search-history-store`);
  - scope chips (all, mail, contacts, calendar, files);
  - results grouped by kind with counts, at most 5 per group and a "Show all" per group;
  - "Load more" for mail;
  - per-account error rows, the `no_results` and `server_hint` texts, and the 300 ms debounce.
- **`openHit(hit)`:**
  - If `hit.appAccountId` isn't shown, `await switchAccount(hit.appAccountId)`. Then require `isShownAccount(hit.appAccountId)`, otherwise stop with the "switch back" text.
  - **Mail:** `getEmails([rawId], jmapAccountId)` for the thread id, then `EmailThread`.
  - **Contact:** make sure contacts are loaded for that account, then `ContactDetail`.
  - **Event:** `setPendingCalendarOpen({…, appAccountId, accountId: jmapAccountId})`, then the Calendar tab.
  - **File:** `pending-files-open` with the folder path and the file to preview, then the Files tab.
- **Keys:** `global_search.*`, which are already vendored.

- [ ] **Step 1: Write the failing tests.** `openHit` switches first, refuses if the switch didn't land, and opens the right account's item when ids collide (Review Focus 1). Also the grouping view model.
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to verify they pass.** Then run `npm run i18n:check`.
- [ ] **Step 5: Commit, then close the phase.** Commit `feat: search everything from one screen`. After the final review, tick the parity items in one `docs:` commit.
