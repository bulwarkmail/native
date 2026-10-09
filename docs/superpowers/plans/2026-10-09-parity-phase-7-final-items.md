# Parity Phase 7: The Last Parity Items Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the last buildable webmail-parity items:
- folder reorder, with webmail's folder sort;
- folder icons and the colourful-icon toggle;
- tag visibility, order and nesting;
- mail folder sharing, with share-notification toasts;
- the invitation banner extras, including counter-proposal review;
- the RTL swipe band, drawers and toggle;
- a Jalali month grid for `fa`.

**Architecture:**
- Everything is JS-only. There is no native module and no rebuild, except to check RTL and Jalali on the emulator.
- Each feature puts its decisions in a pure module under `src/lib`, tested in node. The components only render those decisions.
- New per-account device state is keyed by the app account id. Every write goes out on an `OpScope` taken when the user acts.

**Tech Stack:** React Native / Expo SDK 54 (`android/` committed), TypeScript, Zustand, AsyncStorage, vitest, lucide-react-native, date-fns, and `jalaali-js` ^2 (new in Task 11).

**Spec:**
- Research, with exact refs on both sides: `.superpowers/sdd/2026-10-09-parity-phase-7-final-items/research.md`. Each task names its section.
- House rules: `common.md` in the same directory.
- The parity items: [02](../../parity/02-mail-list-folders.md) (:30, :35, :261, :342), [03](../../parity/03-email-viewer.md) (:141), [05](../../parity/05-calendar.md) (:177, :249) and [08](../../parity/08-settings-push-i18n-ui.md) (:221, :363).
- Webmail at `/tmp/webmail` (1.13.0, read-only) is the authority.
- User decisions, 2026-10-09 (binding):
  1. **Folder reorder:** port webmail's sort (user `sortOrder` first, then role, then year folders, then name). The mobile UI is a reorder mode with Move up / Move down, not drag-and-drop. Only own folders can be reordered.
  2. **Folder icons:** add the colourful-icon toggle. Custom per-folder icons are chosen in Settings → Folders and shown there and in the drawer; the drawer goes beyond webmail. They are stored on the device, keyed by app account id plus mailbox id.
  3. **Tags:** add visibility, reorder and nesting (a parent picker and a tree). No keyword migration: a rename keeps the keyword id. Definitions stay device-local.
  4. **Folder sharing:** gate it on `urn:ietf:params:jmap:mail:share`, as webmail does, and include the share-notification toasts. Reuse `ShareCollectionSheet`, the principals list and the pending-notification store pattern.
  5. **Banner:** add the actor line, the sequence badge, collapse, and "View in calendar" through the pending date target. Counter-proposal review lists the proposed changes. "Apply proposal" sits behind a confirm, updates the event and notifies every attendee, within the banner's account scope.
  6. **RTL:** fix the swipe band and icon side, the three drawers' slide direction, and `ToggleSwitch` (verify it first). A swipe keeps its physical direction; it is not mirrored.
  7. **Jalali:** port `lib/jalali-utils.ts` (with `jalaali-js`) and the `useCalendarLocale` month logic, triggered by the `fa` language. Arrows step by Jalali month. This is the last feature task, so it can be dropped.

## Global Constraints

- **Branch:** `parity/phase-7-final-items`, from `main` at `a5e415e`.
- **Gate before any commit:** `npm run typecheck && npm test && npm run i18n:check`.
- **Node 20:** CI runs Node 20. If a test touches Intl or dates, also run `PATH=~/.nvm/versions/node/v20.20.2/bin:$PATH npx vitest run <file>`.
- **Staging:** stage by explicit path only. Never `git add -A` or `git add .`, and never `git add -f` anything under `.superpowers`.
- **Forbidden git commands:** never `git stash`, `git reset` or `git checkout -- <file>`. Other implementers' work may be in the tree.
- **Check each commit:** after it, run `git show --stat HEAD` and confirm it holds only your files.
- **Commit messages:** lower-case conventional (`feat:`, `fix:`), saying what the user gets. One commit per task. End each message with:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01AdqB9PokeySGSsJ92sqngP`
- **Account safety:** JMAP ids (mailbox, email, identity, calendar, tag keyword targets) are sequential per account on Stalwart, and they collide across accounts and servers.
  - Every per-account stored key, cache entry or parked target is keyed by the **app account id**, not the JMAP id alone. Nothing ever resolves against another account's data.
  - Use the existing helpers: `opScope`/`inAccount`, `requireShownAccountScope`/`isShownAccount`, `clientServesAccount`, `jmapClient.request(…, {gen})`, `StaleLoadError`/`isStaleLoad`, and `jmapClient.connectedAccountId` (null before connect). Never read `jmapClient.accountId` during render.
  - Shared-account folders have namespaced store ids (`<accountId>:<id>`). A write uses `originalId` on `inAccount(at, mb.accountId)`.
- **Strings:** every user-visible string goes through `t('key', 'English fallback')`. Reuse webmail's key where its English fits; the keys named below are already vendored in `locales/*/common.json`. New RN-only keys go in `locales/rn/*.json` via `npm run i18n:harvest`.
- **Regexes:** a regex over sender- or server-controlled text must be linear (no overlapping quantifiers), and its input length capped.
- **Device-sync purity:** `src/device-sync` and the pure libs it imports must not import any store (`purity.test.ts`).
- **Native:** `android/` is committed and hand-edited. Never run `expo prebuild --clean`.
- **TDD:** write the failing test first, run it, and record that it fails. Tests assert behaviour, not implementation. vitest runs in node with no RN render harness, so component decisions go in pure helpers.
- **Scope:** don't dispatch subagents, and don't edit files outside your task's list without a reason, which you note in your report.
- **Parity docs:** only Task 12 edits `docs/parity/*.md`, `PARITY_CHECKLIST.md`, `CHANGES.md` and the roadmap.
- **Shared files:** tasks whose Files blocks name the same file must not run at the same time. Hot spots:
  - `src/components/SidebarDrawer.tsx` (Tasks 3, 5, 6, 10);
  - `src/components/settings/FolderSettings.tsx` (Tasks 2, 3, 6);
  - `src/stores/settings-store.ts` (Tasks 3, 4);
  - `src/api/email.ts` (Tasks 2, 6);
  - `src/api/types.ts` (Tasks 6, 7);
  - `src/lib/settings-search.ts` (Tasks 3, 4);
  - the banner and `calendar-invitation.ts` (Tasks 8, 9);
  - `locales/rn/*.json` (every task that harvests a new RN key).

  `EmailListScreen.tsx` is touched by no task.

## Review Focus

1. **A reorder, share or "Apply proposal" tap that lands during or after an account switch writes nothing.** Account B's folder `c` or event `e1` is not account A's, so the write is refused rather than sent on the live connection. Owned by Tasks 2, 6 and 9.
2. **Rapid Move taps, or a `Mailbox/set` that partly fails, never leave the order scrambled.** Buttons are disabled while a write is in flight, and a failure refetches the folders and shows `settings.folders.reorder_error`. Owned by Task 2.
3. **A custom folder icon or a share-notification toast for account A never appears on account B with the same mailbox or notification ids.** A notification is destroyed only on the account it was fetched for, and only after it was shown. Owned by Tasks 3 and 7.
4. **A tag whose parent was deleted, or whose stored parent forms a loop, still shows exactly once at the root.** Hiding a parent never hides a visible child. Owned by Tasks 4 and 5.
5. **Month stepping in Jalali never skips or repeats a month across Esfand and Farvardin in a leap year.** 1403/12/30 is 2025-03-20, and 1404/01/01 is 2025-03-21. Owned by Task 11.

## Not in this phase

- **Calendar types in push, and a background reminder refresh (05:249).** Closed in Task 12 as "reminders refresh on launch, resume and device sync".
- **Sending from shared accounts (04:74).** A separate phase.
- **Everything in research.md's Excluded list:** settings sync, templates sync, S/MIME send, iOS push, the relay list, the CalDAV component set, and iOS table wrapping.
- **Keyword migration on rename.** Not needed, because ids never change (decision 3).
- **Reordering shared-account folders** (decision 1).
- **Drag-and-drop**, and **Jalali in the agenda, mini calendar or event dates.**

---

### Task 1: Sort folders as webmail does

Research section 1. Size **S**.

**Files:**
- Modify: `src/lib/mailbox-tree.ts:170-181` (`sortNodes`).
- Test: `src/lib/__tests__/mailbox-tree.test.ts`.
- Shares: nothing. Task 2 consumes the order.

**Interfaces:**
- Consumes: nothing new.
- Produces: `buildMailboxTree()` keeps its signature. Sibling order becomes: `sortOrder` ascending (missing counts as 0), then `ROLE_PRIORITY`, then year folders (`/^\d{4}$/`, both sides) descending, then `name.localeCompare`. Children are sorted the same way. Shared-account nodes stay after own roots, as now.

- [ ] **Step 1: Write the failing tests** in a new `describe('sort order (webmail parity)')`:

```ts
it('puts a user sortOrder before the role order', () => {
  // inbox{sortOrder:2}, Work{sortOrder:1}, sent{sortOrder:3}
  expect(names(buildMailboxTree(list))).toEqual(['Work', 'Inbox', 'Sent']);
});
it('keeps the role order when every sortOrder is 0 or missing', () => {
  expect(names(tree)).toEqual(['Inbox', 'Drafts', 'Sent', 'Archive', 'Junk', 'Trash', 'Alpha']);
});
it('sorts year folders newest first, before other names', () => {
  // '2023', 'Alpha', '2025' with no role and sortOrder 0
  expect(names(tree)).toEqual(['2025', '2023', 'Alpha']);
});
it('applies the same order to subfolders', () => { /* children with sortOrder 2,1 → reversed */ });
it('orders shared-account folders the same way under their header', () => { /* … */ });
```

- [ ] **Step 2: Run them and confirm they fail.** Run `npx vitest run src/lib/__tests__/mailbox-tree.test.ts`. Expected: FAIL; the first and third tests get the role-first order.
- [ ] **Step 3: Port the comparator** from webmail `lib/utils.ts:555-586` into `sortNodes`, without the own/shared rule (the tree already separates them). Update its comment to say both clients agree, and that a server sending non-zero `sortOrder` now moves folders.
- [ ] **Step 4: Run the file, then the whole suite.** Expected: PASS. Existing `searchScopeRows` expectations still hold.
- [ ] **Step 5: Commit** `feat: sort folders by their saved order first, as webmail does`.

### Task 2: Reorder folders in Settings → Folders

Research section 1. Size **S–M**.

**Files:**
- Create: `src/lib/folder-reorder.ts`.
- Create: `src/lib/__tests__/folder-reorder.test.ts`.
- Modify: `src/api/email.ts` (add `setMailboxSortOrders` beside `updateMailbox`, `:270`).
- Modify: `src/api/__tests__/mailbox-create.test.ts` (add a `describe('setMailboxSortOrders')`).
- Modify: `src/components/settings/FolderSettings.tsx`.
- Shares: `src/api/email.ts` (Task 6) and `FolderSettings.tsx` (Tasks 3 and 6).

**Interfaces:**
- Consumes: `buildMailboxTree(mailboxes, { hideOwnRoles })`, `flattenAll`, `MailboxNode` (Task 1 order), `requireShownAccountScope`.
- Produces:
  - `siblingsOf(tree: MailboxNode[], id: string): MailboxNode[] | null`. The sibling group, in displayed order, that holds `id`. It never includes account header nodes, and returns null when `id` isn't in the tree.
  - `planFolderMove(siblings: Pick<Mailbox, 'id' | 'sortOrder'>[], id: string, direction: 'up' | 'down'): { id: string; sortOrder: number }[]`. Moves `id` one place and renumbers the whole group 1..n. It returns only the entries whose `sortOrder` changes, and `[]` at either edge.
  - `withSortOrders(mailboxes: Mailbox[], updates: { id: string; sortOrder: number }[]): Mailbox[]`. The optimistic overlay.
  - `setMailboxSortOrders(updates: { id: string; sortOrder: number }[], account: AccountRef): Promise<void>`. One `Mailbox/set` carrying every update. It throws `Error` naming the failed ids when any are in `notUpdated`, and is a no-op for `[]`.

- [ ] **Step 1: Write the failing tests.**

```ts
// folder-reorder.test.ts
it('moving down swaps with the next sibling and numbers the group 1..n', () => {
  expect(planFolderMove([{id:'a',sortOrder:0},{id:'b',sortOrder:0},{id:'c',sortOrder:0}], 'a', 'down'))
    .toEqual([{id:'b',sortOrder:1},{id:'a',sortOrder:2},{id:'c',sortOrder:3}]);
});
it('returns only folders whose number changes', () => { /* [1,2,3] move c up → [{c,2},{b,3}] */ });
it('does nothing at the top or bottom edge', () => { expect(planFolderMove(g, 'a', 'up')).toEqual([]); });
it('finds the siblings of a subfolder in displayed order, never an account header', () => { /* … */ });
it('leaves the hidden Scheduled folder out of the group when the virtual row stands in', () => { /* hideOwnRoles */ });
it('withSortOrders patches only the named folders', () => { /* … */ });
// mailbox-create.test.ts
it('sends every new sortOrder in one Mailbox/set on the given scope', async () => {
  await setMailboxSortOrders([{id:'a',sortOrder:1},{id:'b',sortOrder:2}], { gen: 3, accountId: 'acc-1' });
  expect(mockRequest).toHaveBeenCalledTimes(1);
  expect(call[1]).toEqual({ accountId: 'acc-1', update: { a: { sortOrder: 1 }, b: { sortOrder: 2 } } });
  expect(mockRequest.mock.calls[0][2]).toEqual({ gen: 3 });
});
it('throws when the server refuses any folder', async () => { /* notUpdated: { b: { type: 'forbidden' } } → rejects /b/ */ });
```

- [ ] **Step 2: Run both files and confirm they fail.** Expected: FAIL, because the module and the export don't exist yet.
- [ ] **Step 3: Implement the three helpers and `setMailboxSortOrders`.** Use `requestOn(at, …)` as `updateMailbox` does.
- [ ] **Step 4: Wire the UI in `FolderSettings.tsx`.**
  - The list renders in tree order: `flattenAll(buildMailboxTree(withSortOrders(mailboxes, overlay), { hideOwnRoles }))`, with `hideOwnRoles` computed as the drawer computes it (`SidebarDrawer.tsx:394`). It no longer uses the role-then-path sort, so Settings and the drawer agree. Indent by `node.depth`.
  - A header button toggles reorder mode, labelled with the RN key `settings.folders.reorder_mode` ("Reorder") and `common.done` ("Done").
  - In reorder mode each row shows ▲ / ▼ buttons, labelled `settings.appearance.message_list_order.move_up` / `move_down`. An edge button is disabled, and tapping a row does nothing.
  - On a tap:
    1. take `requireShownAccountScope(shownAccountId)`;
    2. build the plan from `siblingsOf`;
    3. set the overlay and a `reordering` flag, which disables every ▲ / ▼;
    4. send `setMailboxSortOrders(plan, at)`;
    5. on success, `await fetchMailboxes()` and then clear the overlay;
    6. on failure, clear the overlay, `fetchMailboxes()`, and `Alert` with `settings.folders.reorder_error`.

  Folders sit at the raw own ids, because Settings lists only own folders (`ownMailboxes`).
- [ ] **Step 5: Run the gate, then check on the emulator.** Moving Inbox below a user folder reorders the drawer too. Commit `feat: reorder folders from settings with move up and move down`.

### Task 3: Folder icons, and the colourful-icon toggle

Research section 2. Size **S–M**.

**Files:**
- Create: `src/lib/folder-icons.ts` (pure, no lucide import).
- Create: `src/components/folder-icon.tsx` (name → lucide component).
- Create: `src/lib/sidebar-icon-color.ts`.
- Create: `src/stores/folder-icons-store.ts`.
- Test: `src/lib/__tests__/folder-icons.test.ts`, `src/lib/__tests__/sidebar-icon-color.test.ts` and `src/stores/__tests__/folder-icons-store.test.ts`.
- Modify: `src/stores/settings-store.ts`. Add `colorfulSidebarIcons` (default `true`, boolean validator, the webmail key, so no `SETTINGS_KEY_MAP` entry). Also fix the import validator `calendarFirstDayOfWeek: oneOf([0, 1])` to `oneOf([0, 1, 6])`, which rejects Saturday today. Test this in `src/stores/__tests__/settings-store.test.ts`.
- Modify: `src/components/settings/LayoutSettings.tsx`. Add a toggle beside "show folder total count", using `settings.appearance.colorful_sidebar_icons.label` / `.description`.
- Modify: `src/lib/settings-search.ts`. Add an entry for the toggle.
- Modify: `src/components/SidebarDrawer.tsx`. Use `roleIconColor` in place of `iconColor` / `ROLE_COLOR_FIXED`, and show a custom icon for own folders. Clear a folder's icon after the drawer's delete succeeds.
- Modify: `src/components/settings/FolderSettings.tsx`.
  - The editor sheet gets an icon grid labelled `settings.folders.change_icon`, plus "Default icon" (RN key `settings.folders.default_icon`).
  - The row shows the custom icon.
  - Pruning on load and clearing after a delete.
- Modify: `src/stores/account-data-cleanup.ts`. `forgetAccountData` calls `forgetAccount(appAccountId)`.
- Shares: `SidebarDrawer.tsx` (Tasks 5, 6, 10), `FolderSettings.tsx` (Tasks 2, 6), `settings-store.ts` (Task 4) and `settings-search.ts` (Task 4).

**Interfaces:**
- Produces:
  - `FOLDER_ICON_NAMES`: webmail's 18 names, in its order (`components/settings/folder-settings.tsx:58-79`): `Folder, Star, Heart, Bookmark, Tag, Flag, Briefcase, Users, Bell, Zap, Globe, Lock, Eye, MessageSquare, Mail, Inbox, Archive, FileText`.
  - `type FolderIconName`, and `isFolderIconName(v: unknown): v is FolderIconName`.
  - `folderIconComponent(name: FolderIconName): LucideIcon`.
  - `roleIconColor(role: string | null | undefined, isSelected: boolean, colorful: boolean, c: Pick<ThemePalette, 'text' | 'textSecondary' | 'textMuted'>): string`.
  - `useFolderIconsStore`, persisted at AsyncStorage `folderIcons:v1`:
    - `icons: Record<string /*appAccountId*/, Record<string /*Mailbox.id*/, FolderIconName>>`;
    - `hydrate(): Promise<void>`;
    - `setIcon(appAccountId: string, mailboxId: string, name: FolderIconName | null): void`;
    - `prune(appAccountId: string, liveIds: string[]): void`;
    - `forgetAccount(appAccountId: string): void`.
  - `folderIconOf(state, appAccountId: string | null, mailboxId: string): FolderIconName | undefined`.

- [ ] **Step 1: Write the failing tests.**

```ts
it('keys icons by app account: account B never sees account A\'s icon for the same mailbox id', () => {
  setIcon('appA', 'c', 'Heart');
  expect(folderIconOf(s(), 'appA', 'c')).toBe('Heart');
  expect(folderIconOf(s(), 'appB', 'c')).toBeUndefined();
  expect(folderIconOf(s(), null, 'c')).toBeUndefined();
});
it('clearing an icon removes the entry, and prune drops ids no longer listed for that account only', () => {});
it('forgetAccount removes only that account', () => {});
it('hydrate drops unknown icon names and malformed data', () => {});
it('offers webmail\'s 18 icons in its order', () => { expect(FOLDER_ICON_NAMES).toHaveLength(18); });
it('tints role icons only when colourful is on', () => {
  expect(roleIconColor('inbox', false, true, c)).toBe('#60a5fa');
  expect(roleIconColor('inbox', false, false, c)).toBe(c.textSecondary);
  expect(roleIconColor('inbox', true, false, c)).toBe(c.text);
  expect(roleIconColor('trash', false, true, c)).toBe(c.textMuted);
});
it('defaults colorfulSidebarIcons to true and round-trips it through export/import', () => {});
it('imports a Saturday first day of week', () => { /* importSettings({firstDayOfWeek:6}) → 6 */ });
```

- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement the libs, the store, and the settings key and validator fix.**
- [ ] **Step 4: Wire the UI.**
  - **Drawer:** an own, non-account node uses `folderIconOf(state, activeAccountId, node.id)` when set, otherwise `iconFor(…)`. Its colour comes from `roleIconColor(node.role, isSelected, colorfulSidebarIcons, c)`. Shared folders keep `iconFor`, because Settings can't set them.
  - **Settings:** the icon choice is written on save with the editor's `owner` app account, never the live one. When the list renders for `shownAccountId` with folders loaded, `prune(shownAccountId, mailboxes.map(m => m.id))` runs. Both delete paths call `setIcon(owner, id, null)` after the server confirms.
- [ ] **Step 5: Run the gate, then commit** `feat: pick an icon per folder, and turn the coloured sidebar icons off`.

### Task 4: Tag visibility, order and parent

Research section 3. Size **M**.

**Files:**
- Create: `src/lib/keyword-nesting.ts`. A port of webmail `lib/keyword-nesting.ts`, adapted below.
- Test: `src/lib/__tests__/keyword-nesting.test.ts`.
- Modify: `src/stores/keywords-store.ts`.
  - `KeywordDef` gains `visibility?: KeywordVisibility` and `parentId?: string | null`.
  - Add `move(id, direction)`.
  - Sanitise both fields in `hydrate`.
- Test: `src/stores/__tests__/keywords-store.test.ts` (new).
- Modify: `src/stores/settings-store.ts`. Add `nestedTags: boolean` (default `false`, webmail key, exported).
- Modify: `src/lib/settings-search.ts`. Add an entry for `settings.keywords.nesting.label`.
- Modify: `src/components/settings/KeywordSettings.tsx`.
- Shares: `settings-store.ts` and `settings-search.ts` (Task 3), and `keywords-store.ts` (Task 5 reads it).

**Interfaces:**
- Produces:
  - `type KeywordVisibility = 'show' | 'unread' | 'hide'`, and `keywordVisibility(def: KeywordDef): KeywordVisibility` (absent → `'show'`).
  - `normalizeKeywordLevel(name: string): string`. This replaces the inline slug in `KeywordForm`.
  - `composeKeywordId(parentId: string | null, name: string): string`.
  - `MAX_KEYWORD_ID_LENGTH = 255 - '$label:'.length` (248).
  - `KeywordNode = KeywordDef & { children: KeywordNode[]; depth: number }`.
  - `effectiveParentId(def: KeywordDef, defined: ReadonlySet<string>): string | null`:
    - `parentId === null` → root;
    - a `parentId` string → that parent, if defined;
    - `parentId` absent → webmail's id-derived parent (`work/clients` → `work`), if defined;
    - otherwise → root.
  - `buildKeywordTree(defs: KeywordDef[]): KeywordNode[]`. Keeps the array order within a level. A def whose parent chain loops or reaches an undefined parent is placed at the root, exactly once.
  - `filterKeywordTree(nodes, isVisible)`, and `countKeywordNodes(nodes)`, as in webmail.
  - `descendantIds(defs: KeywordDef[], id: string): Set<string>`. Used by the parent picker.
  - `moveKeyword(defs: KeywordDef[], id: string, direction: 'up' | 'down', nested: boolean): KeywordDef[]`. Swaps array positions with the previous or next sibling: the same effective parent when `nested`, otherwise the adjacent entry. It returns the same array at an edge.
  - Store: `move(id: string, direction: 'up' | 'down'): void`, which reads `nestedTags` from the settings store.

- [ ] **Step 1: Write the failing tests.**

```ts
it('nests by an explicit parentId without changing the id', () => {
  const tree = buildKeywordTree([{id:'work',label:'Work',color:'blue'},{id:'acme',label:'Acme',color:'red',parentId:'work'}]);
  expect(tree[0].children.map(n => n.id)).toEqual(['acme']);
});
it('nests webmail-style ids (work/clients) under their defined parent', () => {});
it('parentId null keeps a slash id at the root', () => {});
it('places a tag whose parent is gone, or whose parents loop, at the root once', () => {
  // a.parentId='b', b.parentId='a'
  expect(countKeywordNodes(buildKeywordTree(defs))).toBe(2);
});
it('composes a child id under its parent and caps the length at 248', () => {
  expect(composeKeywordId('work', 'Big Client')).toBe('work/big-client');
});
it('moves a tag past its sibling only, skipping other parents\' children when nested', () => {});
it('excludes a tag and its descendants from its own parent choices', () => {});
it('hydrate drops an invalid visibility and a non-string parentId', () => {});
it('renaming keeps the keyword id', () => { update('red', { label: 'Urgent' }); expect(ids()).toContain('red'); });
```

- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement the lib, the store fields, `move`, and `nestedTags`.**
- [ ] **Step 4: Wire the UI in `KeywordSettings.tsx`.**
  - **Nesting toggle:** use `settings.keywords.nesting.label` / `.description`.
  - **Form:**
    - A visibility segmented control: `settings.keywords.visibility_field`, with `settings.keywords.visibility.show` / `.unread` / `.hide`.
    - When nesting is on, a parent picker: `settings.keywords.parent_field`, with `settings.keywords.no_parent`. It lists the tree minus the tag and its descendants.
    - A new tag's id is `composeKeywordId(parent, label)`, with the duplicate and length checks applied to that id.
    - Editing a tag never changes its id. A parent change writes `parentId`, and choosing "No parent" writes `null`.
  - **Rows:** each row gets ▲ / ▼ buttons, labelled `settings.appearance.message_list_order.move_up` / `move_down`, which call `move`. When nesting is on, the list renders as the tree, indented by depth.
- [ ] **Step 5: Run the gate, then commit** `feat: hide, reorder and nest tags`.

### Task 5: Show tags as a tree, and honour visibility

Research section 3. Size **S**.

**Files:**
- Create: `src/lib/tag-rows.ts`.
- Test: `src/lib/__tests__/tag-rows.test.ts`.
- Modify: `src/components/SidebarDrawer.tsx` (the tags section, `:1176-1205`).
- Modify: `src/components/TagSheet.tsx`.
- Shares: `SidebarDrawer.tsx` (Tasks 3, 6, 10).

**Interfaces:**
- Consumes: `buildKeywordTree`, `filterKeywordTree`, `countKeywordNodes` and `keywordVisibility` (Task 4); `useSettingsStore(s => s.nestedTags)`.
- Produces: `tagRows(defs: KeywordDef[], opts: { nested: boolean; counts: Record<string, { unread: number } | undefined>; selectedId: string | null; showAll: boolean; applyVisibility: boolean }): { rows: { def: KeywordDef; depth: number }[]; hiddenCount: number }`. When `nested` is false, every def is a root. With `applyVisibility`, the rows follow webmail's `isTagVisible` (`sidebar.tsx:1020-1030`):
  - a selected tag, or any tag while `showAll` is on, is always shown;
  - `hide` → hidden;
  - `unread` → shown while there is no count yet, or the count has `unread > 0`.

- [ ] **Step 1: Write the failing tests.**

```ts
it('hides a hidden tag, and counts it', () => { expect(r.rows.map(x => x.def.id)).not.toContain('h'); expect(r.hiddenCount).toBe(1); });
it('shows an unread-only tag until its count arrives, then only with unread mail', () => {});
it('always shows the selected tag and, with showAll, every tag', () => {});
it('keeps a hidden parent when a visible child needs it, at their depths', () => {});
it('flattens to depth 0 when nesting is off', () => {});
it('ignores visibility for the tag sheet', () => { /* applyVisibility:false → all rows */ });
```

- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement `tagRows`.**
- [ ] **Step 4: Render the rows.**
  - **Drawer:** `tagRows(…, { applyVisibility: true })`, rendered at `depth` with a local `showAllTags` state. When `hiddenCount > 0 || showAllTags`, a row shows `sidebar.show_all_tags` ({count}) or `sidebar.show_fewer_tags`.
  - **TagSheet:** `applyVisibility: false`, `showAll: true`, in tree order, with indentation.
- [ ] **Step 5: Run the gate, then commit** `feat: show tags as a tree in the sidebar and tag sheet, hiding the ones set to hide`.

### Task 6: Share a mail folder

Research section 4. Size **M**.

**Files:**
- Modify: `src/api/types.ts`. Add `CAPABILITIES.MAIL_SHARE = 'urn:ietf:params:jmap:mail:share'` and `MailboxRights.mayShare?: boolean`.
- Modify: `src/api/email.ts`. Add `getMailboxShareWith` and `setMailboxShare`.
- Test: `src/api/__tests__/mailbox-share.test.ts`.
- Modify: `src/lib/share-presets.ts`. Add `'mailbox'` to `ShareKind`, with `MAILBOX_PRESETS` copied from webmail `share-collection-dialog.tsx:58-77`. The order is `read, readWrite, manager`.
- Test: `src/lib/__tests__/share-presets.test.ts`.
- Modify: `src/lib/capabilities.ts`. Add `sessionSupportsMailShare` and `useHasMailShare`.
- Test: `src/lib/__tests__/capabilities-mail-share.test.ts`.
- Modify: `src/components/ShareCollectionSheet.tsx`.
  - Add mailbox strings, reusing the generic `sharing.*` keys.
  - Add an optional `reload` prop, called after each change, whose result replaces the shown shares.
  - Give the manager preset an RN description key, `sharing.preset.manager_mailbox_hint` ("Can also send as this folder's owner, delete it and share it again").
- Create: `src/components/MailboxShareSheet.tsx`.
- Modify: `src/components/settings/FolderSettings.tsx`. A "Share…" button in the editor sheet (`mailbox_context_menu.share`).
- Modify: `src/components/SidebarDrawer.tsx`. A "Share…" action in `openFolderSheet` (`:527`).
- Shares: `types.ts` (Task 7), `email.ts` (Task 2), `FolderSettings.tsx` (Tasks 2, 3) and `SidebarDrawer.tsx` (Tasks 3, 5, 10).

**Interfaces:**
- Consumes: `ShareCollectionSheet`, `getPrincipals`, `principalsListUsable`, `requireShownAccountScope`, `inAccount`.
- Produces:
  - `getMailboxShareWith(mailboxId: string, at: OpScope): Promise<Record<string, MailboxRights> | null>`.
    - Request: `Mailbox/get {accountId, ids:[id], properties:['id','shareWith']}`, with `using` = [CORE, MAIL, MAIL_SHARE], on `{gen}`.
    - Throws `Error('Folder not found')` when the folder isn't listed.
  - `setMailboxShare(mailboxId: string, principalId: string, rights: MailboxRights | null, at: OpScope): Promise<void>`.
    - Request: the patch `shareWith/<principalId>`.
    - Throws on `notUpdated`, or when `updated` lacks the id.
  - `sessionSupportsMailShare(session: JMAPSession | null, jmapAccountId: string | null | undefined): boolean`. False for a null session or account (it fails closed, unlike the other capability helpers). True when `accountCapabilities` of that account, or the session, has `MAIL_SHARE`.
  - `useHasMailShare(jmapAccountId: string | null | undefined): boolean`.
  - `MailboxShareSheet` props: `{ mailbox: Mailbox | null; ownerAppAccountId: string | null; onClose(): void }`. On open it takes `requireShownAccountScope(ownerAppAccountId)` once, and the target is `inAccount(at, mailbox.isShared ? mailbox.accountId : undefined)` with id `mailbox.originalId ?? mailbox.id`. That scope serves the initial load, every `onShare`, and the `reload`. If the scope can't be taken, the sheet closes and shows the error.
  - Offered when `useHasMailShare(<the folder's JMAP account>)` is true and (`!mb.isShared || mb.myRights.mayShare`).

- [ ] **Step 1: Check whether Stalwart advertises `mail:share`.**
  1. Start the webmail integration server: `STALWART_RECOVERY_ADMIN=admin:admin TEST_ACCOUNT_PASSWORD=test-pass-123 docker compose -f /tmp/webmail/integration/docker-compose.yml up -d stalwart`. Or use any server in `BULWARK_LIVE_JMAP`.
  2. Run `curl -s -u alice@example.org:test-pass-123 http://127.0.0.1:8025/jmap/session | jq '{session: (.capabilities | has("urn:ietf:params:jmap:mail:share")), accounts: [.accounts[] | .accountCapabilities | has("urn:ietf:params:jmap:mail:share")]}'`.
  3. Record the answer and the Stalwart version in your report.

  If it is not advertised, build the feature anyway: it stays hidden on Stalwart, as it does in webmail, and Task 12 records that.
- [ ] **Step 2: Write the failing tests.**

```ts
it('reads shareWith on demand with the mail:share capability, on the scope it was given', async () => {
  await getMailboxShareWith('c', { gen: 4, accountId: 'shared-1' });
  expect(call).toEqual(['Mailbox/get', { accountId: 'shared-1', ids: ['c'], properties: ['id', 'shareWith'] }, '0']);
  expect(using).toContain('urn:ietf:params:jmap:mail:share');
  expect(opts).toEqual({ gen: 4 });
});
it('grants with a shareWith/<principal> patch and revokes with null', async () => {});
it('throws when the server does not confirm the update', async () => { /* updated: {} → rejects */ });
it('offers webmail\'s three folder presets and detects them', () => { expect(presetOrder('mailbox')).toEqual(['read','readWrite','manager']); });
it('fails closed without a session, and reads the folder\'s own account capability', () => {
  expect(sessionSupportsMailShare(null, 'a')).toBe(false);
  expect(sessionSupportsMailShare(sessionWith({ a: [MAIL_SHARE] }), 'b')).toBe(false);
});
```

- [ ] **Step 3: Run them and confirm they fail.**
- [ ] **Step 4: Implement the API, presets, capability helpers, the sheet changes and `MailboxShareSheet`, then wire both entry points.**
- [ ] **Step 5: Run the gate, and on Stalwart (if advertised) share a folder from alice to bob.** Commit `feat: share a mail folder with other users on the server`.

### Task 7: Toasts when someone shares with you

Research section 4. Size **S–M**.

**Files:**
- Create: `src/stores/pending-notification-store.ts`. A factory extracted from `calendar-event-notification-store.ts`.
- Modify: `src/stores/calendar-event-notification-store.ts`. Rebuild it on the factory. Its exported API and every existing test stay unchanged.
- Create: `src/api/share-notifications.ts`.
- Create: `src/stores/share-notification-store.ts`.
- Create: `src/lib/share-notification-toast.ts` (pure: kind and message).
- Create: `src/lib/share-notification-presenter.ts`.
- Test:
  - `src/stores/__tests__/share-notification-store.test.ts`;
  - `src/lib/__tests__/share-notification-toast.test.ts`;
  - `src/api/__tests__/share-notifications.test.ts`;
  - `src/stores/__tests__/calendar-event-notification-store.test.ts` must still pass unchanged.
- Modify: `src/api/types.ts`. Add the `ShareNotification` type (RFC 9670 §3: `id, created, changedBy{name,email,principalId}, objectType, objectAccountId, objectId, oldRights, newRights, name`).
- Modify: `App.tsx`.
  - Start the presenter beside `startCalendarEventNotificationToasts` (`:650`).
  - Fetch at the same three points as the calendar store (`:938`, `:966`), and on `onStateChangeType('ShareNotification', …)` for the served primary account.
- Modify: `src/stores/auth-store.ts`. Replace the six `useCalendarEventNotificationStore.getState().reset()` calls with `resetPendingNotificationStores()`.
- Shares: `types.ts` (Task 6).

**Interfaces:**
- Produces:
  - `createPendingNotificationStore<T extends { id: string }>(cfg: { name: string; list: () => Promise<T[]>; destroy: (ids: string[], accountId: string, stillServing: () => boolean) => Promise<void> }): UseBoundStore<…{ pending: (T & { accountId: string; appAccountId: string })[]; fetch(): Promise<void>; acknowledge(ids: string[]): Promise<void>; reset(): void }>`. It keeps every guard the calendar store has: the generation, coalescing, the `seen` set keyed `${appAccountId}:${id}`, the drop after a switch, and the per-account destroy.
  - `resetPendingNotificationStores(): void`. Resets every store the factory made.
  - `getShareNotifications(): Promise<ShareNotification[]>`. Returns `[]` without `CAPABILITIES.PRINCIPALS`. Otherwise it sends `ShareNotification/query` sorted by `created` ascending, plus a back-referenced `/get`, on the own account, with `using` [CORE, PRINCIPALS].
  - `destroyShareNotifications(ids, accountId, stillServing?)`. Batched by `getMaxObjectsInSet()`, and re-checked before each batch, as `destroyCalendarEventNotifications` does.
  - `shareNotificationKind(n): 'shared' | 'changed' | 'revoked'` (webmail `share-notification-toaster.tsx:15-19`).
  - `shareNotificationMessage(n, t): { level: 'info' | 'warning'; text: string }`. Uses `share_notifications.{shared,changed,revoked,someone}` and `share_notifications.object.{folder,calendar,address_book,files}`.
  - `startShareNotificationToasts(): () => void`. It shows each notice, then refreshes the touched collections: `Mailbox` → `useEmailStore.fetchMailboxes()`, `Calendar` → `useCalendarStore.fetchCalendars()`, `AddressBook` → `useContactsStore.refresh()`; `FileNode` has no refresh. Then it acknowledges the batch.

- [ ] **Step 1: Write the failing tests.**

```ts
it('words a first grant as shared, a removal as revoked (warning), anything else as changed', () => {});
it('names the sharer, falling back to email, then "Someone"', () => {});
it('tags notices with their app account and drops a fetch that lands after a switch', async () => {});
it('never destroys account A\'s notices while the client serves account B with the same JMAP id', async () => {});
it('does not toast the same notice twice in a session after reset', async () => {});
it('asks for nothing when the server has no principals capability', async () => { expect(await getShareNotifications()).toEqual([]); expect(mockRequest).not.toHaveBeenCalled(); });
```

- [ ] **Step 2: Run them, and the calendar store's tests, and confirm only the new ones fail.**
- [ ] **Step 3: Extract the factory.** Run the calendar store tests: they still pass.
- [ ] **Step 4: Add the share API, store, toast helpers and presenter, and wire `App.tsx` and `auth-store.ts`.**
- [ ] **Step 5: Run the gate, then commit** `feat: show a toast when someone shares a folder, calendar or address book with you`.

### Task 8: Who sent the invitation, its update number, collapse, and "View in calendar"

Research section 5. Size **S–M**.

**Files:**
- Modify: `src/lib/calendar-invitation.ts`. Add `getInvitationActorSummary`, a port of webmail `lib/calendar-invitation.ts:255-325` including `getParticipantSignalScore`.
- Test: `src/lib/__tests__/calendar-invitation.test.ts`.
- Create: `src/lib/invitation-view-target.ts`.
- Test: `src/lib/__tests__/invitation-view-target.test.ts`.
- Modify: `src/components/email/CalendarInvitationBanner.tsx`.
- Shares: both files above with Task 9.

**Interfaces:**
- Produces:
  - `interface InvitationActorSummary { name: string | null; email: string | null; role: 'organizer' | 'attendee'; participationStatus: string | null; participationComment: string | null }`.
  - `getInvitationActorSummary(event: Partial<CalendarEvent>, method: InvitationMethod): InvitationActorSummary | null`. The organizer falls back to `organizerCalendarAddress`. It picks the responder for reply/counter/refresh, and the organizer for request/publish/add/cancel/declinecounter.
  - `invitationViewTarget(start: Date | null, bannerAppAccountId: string | null, shownAppAccountId: string | null): CalendarViewTarget | null`. Returns `{ date: 'YYYY-MM-DD' }` (no view, no event id). It returns null for an invalid date, or when the banner's account isn't the shown one.

- [ ] **Step 1: Write the failing tests.**

```ts
it('names the responding attendee for a reply, with their status and note', () => {
  expect(getInvitationActorSummary(replyEvent, 'reply')).toMatchObject({ name: 'Bob', role: 'attendee', participationStatus: 'accepted', participationComment: 'See you' });
});
it('names the organizer for a request, finding it by organizerCalendarAddress on Stalwart', () => {});
it('returns null without participants', () => {});
it('parks only a date, and nothing for another shown account', () => {
  expect(invitationViewTarget(new Date(2026, 9, 9, 15), 'appA', 'appA')).toEqual({ date: '2026-10-09' });
  expect(invitationViewTarget(new Date(2026, 9, 9), 'appA', 'appB')).toBeNull();
});
```

- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement both helpers.**
- [ ] **Step 4: Wire the banner.**
  - **Actor line:** one of `email_viewer.calendar_invitation.actor_sent_info` / `actor_response_info` (status from `response_*`) / `actor_counter_info` / `actor_refresh_info` / `actor_declined_counter_info`, followed by `actor_note` and the comment. An unknown name uses `actor_unknown`.
  - **Sequence pill:** `event_updated` ({sequence}) when `sequence > 0`.
  - **Collapse:** a chevron (`expand` / `collapse`) that hides everything but the title row. It is state per message, not persisted.
  - **"View in calendar":** shown when there is a start date. The label is `view_in_calendar`, or `review_proposal` for an organizer on a counter, or `review_request` for an organizer on a refresh. It calls `setPendingCalendarView(target)` and then `navigation.navigate('MainTabs', { screen: 'Calendar' })`.
- [ ] **Step 5: Run the gate, then commit** `feat: show who sent an invitation and its update number, collapse it, and open its day in the calendar`.

### Task 9: Review and apply a counter-proposal

Research section 5. Size **M**.

**Files:**
- Modify: `src/lib/calendar-invitation.ts`. Add `buildProposalPatch` and `buildInvitationChangeItems`, ported from webmail `calendar-invitation-banner.tsx:209-330` with `hasMeaningfulDifference` and `formatEventSummary`.
- Test: `src/lib/__tests__/calendar-invitation.test.ts`.
- Modify: `src/components/email/CalendarInvitationBanner.tsx`.
- Shares: both files with Task 8.

**Interfaces:**
- Consumes: `updateEvent(id, changes, sendSchedulingMessages, targetAccount)` (`src/api/calendar.ts:782`) and `requireShownAccountScope`.
- Produces:
  - `buildProposalPatch(current: Partial<CalendarEvent> | null, proposed: Partial<CalendarEvent> | null): Partial<CalendarEvent> | null`. It compares title, description, descriptionContentType, start, duration, timeZone, showWithoutTime, locations and virtualLocations, and returns null when nothing differs.
  - `interface InvitationChangeItem { label: 'title' | 'time' | 'location' | 'description'; before: string | null; after: string }`.
  - `buildInvitationChangeItems(current, proposed, formatDateTime: (iso: string | null) => string): InvitationChangeItem[]`. The banner maps `label` to `change_title` / `change_time` / `change_location` / `change_description`, and a null `before` to `change_empty`.
  - `canApplyProposal(args: { method: InvitationMethod; userIsOrganizer: boolean; existing: Partial<CalendarEvent> | null; patch: Partial<CalendarEvent> | null }): boolean`. True only when the method is counter, the user is the organizer, the existing event has an id and is not shared (`!existing.isShared`), and the patch is non-null.

- [ ] **Step 1: Write the failing tests.**

```ts
it('patches only what the proposal changes', () => {
  expect(buildProposalPatch({ start: '2026-10-09T10:00:00', duration: 'PT1H', title: 'A' }, { start: '2026-10-09T11:00:00', duration: 'PT1H', title: 'A' }))
    .toEqual({ start: '2026-10-09T11:00:00' });
});
it('returns null when nothing differs', () => {});
it('lists a moved time and a new location, before and after', () => {});
it('offers Apply only to the organizer of an own, existing event on a counter', () => {
  expect(canApplyProposal({ ...ok, existing: { ...ok.existing, isShared: true } })).toBe(false);
  expect(canApplyProposal({ ...ok, method: 'reply' })).toBe(false);
});
```

- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement the three helpers.**
- [ ] **Step 4: Wire the banner.**
  - **Change list:** for a counter where the user is the organizer, show the list under `proposed_changes`, each item using `change_from_to`. `userIsOrganizer` means `getOrganizerEmail(existing ?? event)` is in `currentUserEmails`.
  - **"Apply proposal"** (`apply_proposal`) opens an `Alert`, worded with the RN keys `email_viewer.calendar_invitation.apply_confirm_title` ("Apply the proposed changes?") and `apply_confirm_message` ("Every attendee will be sent the updated event. This can't be undone."). On confirm:
    1. take `requireShownAccountScope(ownerAppAccountId)`, the banner's existing scope;
    2. send `updateEvent(existing.baseEventId ?? existing.originalId ?? existing.id, patch, true, at)`, so an expanded occurrence's synthetic id is never sent;
    3. then `useCalendarStore.getState().refresh()` and the notice `proposal_applied`.

    On failure it shows `action_failed`, and after a switch the scope error. A busy flag blocks a second tap.
- [ ] **Step 5: Run the gate, then commit** `feat: review a counter-proposal and apply it for every attendee`.

### Task 10: RTL swipe bands, drawers and toggle

Research section 6. Size **S–M**.

**Files:**
- Create: `src/lib/rtl-layout.ts`.
- Test: `src/lib/__tests__/rtl-layout.test.ts`.
- Modify: `src/components/SwipeableRow.tsx` (`:285-296`, `:327-340`).
- Modify: `src/components/SidebarDrawer.tsx` (`:740-766`, `:812`).
- Modify: `src/components/contacts/ContactsSidebarDrawer.tsx` (`:106-128`).
- Modify: `src/components/calendar/CalendarSidebarDrawer.tsx` (`:69-105`).
- Modify: `src/components/ToggleSwitch.tsx` (`:39`), only if Step 1 confirms the bug.
- Modify: `src/i18n/index.ts`. Correct the `isLayoutRTL` comment, which says gestures should swap sides: swipes stay physical (decision 6).
- Shares: `SidebarDrawer.tsx` (Tasks 3, 5, 6).

**Interfaces:**
- Produces:
  - `bandEdgeStyle(side: 'left' | 'right', rtl: boolean): { left?: 0; right?: 0; alignItems: 'flex-start' | 'flex-end'; justifyContent: 'flex-start' | 'flex-end' }`. Pins a band to the physical `side`. RN swaps `left` / `right` and flex start / end in RTL, so the RTL result is the mirror.
  - `drawerClosedX(width: number, rtl: boolean): number`. Returns `-width` in LTR and `+width` in RTL.
  - `drawerSafeEdges(rtl: boolean): ('top' | 'bottom' | 'left' | 'right')[]`. Returns `['top','bottom','left']` in LTR, and `'right'` in place of `'left'` in RTL.
  - `toggleThumbX(on: boolean, rtl: boolean): number`. Returns `4` / `24` in LTR, and `-4` / `-24` in RTL.

- [ ] **Step 1: Verify on the emulator.**
  1. Switch the language to `ar` and restart. Follow the memory note on test APK builds: build for arm64 and x86_64.
  2. Screenshot the swipe bands in instant and reveal modes, each drawer opening, and a `ToggleSwitch` on and off.
  3. Record which are wrong. If the thumb already sits right in RTL, drop `toggleThumbX` and the ToggleSwitch change.
- [ ] **Step 2: Write the failing tests.**

```ts
it('pins a band to its physical edge in both directions', () => {
  expect(bandEdgeStyle('left', false)).toEqual({ left: 0, alignItems: 'flex-start', justifyContent: 'flex-start' });
  expect(bandEdgeStyle('left', true)).toEqual({ right: 0, alignItems: 'flex-end', justifyContent: 'flex-end' });
});
it('parks a closed drawer off the side it is anchored to', () => {
  expect(drawerClosedX(400, false)).toBe(-400);
  expect(drawerClosedX(400, true)).toBe(400);
});
it('keeps the inset on the drawer\'s own edge', () => { expect(drawerSafeEdges(true)).toEqual(['top', 'bottom', 'right']); });
it('moves the toggle thumb toward the start edge when off', () => { expect(toggleThumbX(false, true)).toBe(-4); });
it('leaves swipe actions physical: a rightward drag still fires rightAction in RTL', () => { /* resolveRelease from swipe-gesture.ts with dx>0 → rightAction */ });
```

- [ ] **Step 3: Run them and confirm they fail.**
- [ ] **Step 4: Implement the helpers and apply them.**
  - **SwipeableRow:** both band renderers use `bandEdgeStyle(side, isLayoutRTL())`. `translateX` and the action mapping stay physical.
  - **Drawers:** in all three, `drawerClosedX` sets the initial `Animated.Value` and the close target, and `SidebarDrawer` uses `drawerSafeEdges`. `left: 0` stays, since it already resolves to the right edge in RTL. There is no edge-swipe opener to change.
  - **ToggleSwitch:** use `toggleThumbX`, if Step 1 confirmed the bug.
- [ ] **Step 5: Run the gate, and repeat the Step 1 screenshots in `ar` and in `en`.** LTR must look unchanged. Commit `fix: put swipe actions, drawers and switches on the right side in right-to-left languages`.

### Task 11: Jalali month grid for Persian (last feature task, droppable)

Research section 7. Size **M**. If this task is dropped, Task 12 leaves 05:177 open.

**Files:**
- Modify: `package.json` and `package-lock.json`. Run `npm install jalaali-js@^2` (2.0.1 today). If types are missing, add `src/types/jalaali-js.d.ts`.
- Create: `src/lib/jalali-utils.ts`. A port of webmail `lib/jalali-utils.ts`, keeping `toJalali`, `toGregorian`, `JALALI_MONTHS`, `jalaliMonthLength`, `isJalaliLeapYear`, `startOfJalaliMonth`, `endOfJalaliMonth`, `eachDayOfJalaliMonth` and `shouldUseJalaliCalendar`. `getDayHeaderKeys` and `defaultFirstDayOfWeek` are unused there and stay out.
- Create: `src/lib/calendar-system.ts`.
- Test: `src/lib/__tests__/jalali-utils.test.ts` and `src/lib/__tests__/calendar-system.test.ts`. Webmail has no Jalali tests, so these are new.
- Modify: `src/lib/calendar-scroll-window.ts`. `ScrollWindowOptions` gains `calendar?: CalendarSystem`, and `baseRange('month')` uses it.
- Modify: `src/lib/calendar-month-scroll.ts`. `monthKeyOf(date, calendar?)` and `monthMask(days, key, calendar?)`.
- Modify: `src/lib/calendar-locale.ts`. `useCalendarLocale()` also returns `calendar: CalendarSystem`.
- Modify: `src/components/calendar/MonthView.tsx` (`:165`, `:199`, `:281-291`).
- Modify: `src/components/calendar/MonthScrollView.tsx` (`:128-173`).
- Modify: `src/screens/CalendarScreen.tsx` (`headerTitle` `:177-192`, `goPrev`/`goNext` `:606-623`).
- Shares: nothing with other tasks.

**Interfaces:**
- Produces:
  - `interface CalendarSystem`, with these members:
    - `kind: 'gregorian' | 'jalali'`;
    - `monthStart(d: Date): Date` and `monthEnd(d: Date): Date`, both at local midnight;
    - `addMonths(d: Date, n: number): Date`. For Jalali this is the 1st of the target month; for Gregorian it is date-fns `addMonths`, unchanged;
    - `monthKey(d: Date): number`, as `year * 12 + monthIndex`;
    - `dayOfMonth(d: Date): number`;
    - `isFirstOfMonth(d: Date): boolean`;
    - `monthYearLabel(d: Date, locale: Locale): string`;
    - `shortMonthLabel(d: Date, locale: Locale): string`.
  - `GREGORIAN: CalendarSystem`, `JALALI: CalendarSystem`, and `calendarSystemFor(localeCode: string): CalendarSystem`, which is `JALALI` only for `'fa'`.
  - `headerTitleFor(viewMode, currentDate, weekStartsOn, locale, calendar, firstDay?)` moves from `CalendarScreen.tsx` to `calendar-system.ts` and is exported. The Gregorian output is unchanged. For Jalali, month view gives `"<month> <jy>"`; week and day views use the Jalali day, month and year, in webmail's `formatWeekRange` / `formatFullDate` shapes.

- [ ] **Step 1: Write the failing tests.** Values were checked against jalaali-js 2.0.1.

```ts
it('converts Nowruz and the leap Esfand', () => {
  expect(toJalali(new Date(2024, 2, 20))).toEqual({ jy: 1403, jm: 1, jd: 1 });
  expect(toJalali(new Date(2025, 2, 20))).toEqual({ jy: 1403, jm: 12, jd: 30 });
  expect(isJalaliLeapYear(1403)).toBe(true);
  expect(jalaliMonthLength(1404, 12)).toBe(29);
});
it('builds a whole-week grid for Mehr 1405 starting Saturday', () => {
  const days = eachDayOfJalaliMonth(1405, 7, 6);
  expect(days[0].getDay()).toBe(6);
  expect(days.some(d => +d === +new Date(2026, 8, 23))).toBe(true); // 1405/07/01
  expect(days.length % 7).toBe(0);
});
it('steps month by month from Esfand 1403 to Farvardin 1404 and back, never skipping', () => {
  expect(JALALI.addMonths(new Date(2025, 2, 20), 1)).toEqual(new Date(2025, 2, 21));
  expect(JALALI.addMonths(new Date(2025, 2, 21), -1)).toEqual(new Date(2025, 1, 19));
});
it('gives the Jalali grid for a fa month range and the Gregorian one otherwise', () => {
  expect(baseRange('month', new Date(2026, 9, 8), { weekStartsOn: 6, calendar: JALALI }).start).toEqual(startOfJalaliMonth(1405, 7, 6));
  expect(baseRange('month', d, { weekStartsOn: 1 })).toEqual(/* unchanged Gregorian */);
});
it('labels the first of a Jalali month, and keys months by Jalali month', () => {
  expect(JALALI.isFirstOfMonth(new Date(2026, 8, 23))).toBe(true);
  expect(JALALI.monthKey(new Date(2026, 9, 22))).toBe(JALALI.monthKey(new Date(2026, 8, 23)));
});
it('only fa uses Jalali', () => { expect(calendarSystemFor('fa').kind).toBe('jalali'); expect(calendarSystemFor('ar').kind).toBe('gregorian'); });
it('titles a Jalali month "مهر 1405"', () => {});
```

- [ ] **Step 2: Run them and confirm they fail.** Then also run them on Node 20, as in Global Constraints.
- [ ] **Step 3: Install `jalaali-js`, and implement `jalali-utils.ts` and `calendar-system.ts`.**
- [ ] **Step 4: Thread `calendar` through.**
  - `baseRange`, `monthKeyOf` and `monthMask` take it.
  - `MonthView` builds its rows from `calendar.monthStart` / `monthEnd`, and renders day numbers with `calendar.dayOfMonth`. The free-scroll month label uses `calendar.isFirstOfMonth` / `shortMonthLabel`.
  - In `MonthScrollView`, the `CalendarScreen` window options, the title and the month arrows, use `calendar.addMonths`. Week and day steps are unchanged.
  - Every existing Gregorian test must pass unchanged.
- [ ] **Step 5: Run the gate twice, under the default Node and Node 20.** Then check on the emulator in `fa`: the month grid starts on 1 Mehr, and the arrows step Mehr → Aban → Mehr. Commit `feat: show the Persian (Jalali) month grid when the app is in Persian`.

### Task 12: Tick the parity items and record the follow-ups

Size **S**. It runs after every other task, and after the final branch review.

**Files:**
- Modify: `docs/parity/02-mail-list-folders.md` (:30, :35, :261, :342).
- Modify: `docs/parity/03-email-viewer.md` (:141).
- Modify: `docs/parity/05-calendar.md` (:177, :249).
- Modify: `docs/parity/08-settings-push-i18n-ui.md` (:221, :363).
- Modify: `PARITY_CHECKLIST.md`, `CHANGES.md`, and `docs/superpowers/plans/2026-10-04-webmail-parity-roadmap.md`.

**Interfaces:**
- Consumes: the commit hashes of Tasks 1-11 (`git log --oneline main..HEAD`), and Task 6's Step 1 finding.

- [ ] **Step 1: Tick each item, in the existing style.** Change `- [ ]` to `- [x]` and append `— fixed in <hash>[, <hash>]`, or `— closed …` where nothing was built.
  - 02:30 → Tasks 1, 2. Name the decision: own folders only, move up / down.
  - 02:35 → Task 3. Note that icons are device-local and keyed by app account, and also show in the drawer.
  - 02:261 → Tasks 4, 5. Note: "rename keeps the id, so no migration is needed (decision 2026-10-09)".
  - 02:342 → Tasks 6, 7. If Stalwart doesn't advertise `mail:share`, add "hidden on Stalwart, which does not advertise `urn:ietf:params:jmap:mail:share` (checked against <version>)".
  - 03:141 → Tasks 8, 9.
  - 08:221 and 08:363 → Task 10. Note that swipes stay physical, as in webmail.
  - 05:177 → Task 11, or leave it open with "deferred: Jalali dropped from phase 7" if Task 11 was dropped.
  - 05:249 → `- [x]` with `— closed: reminders refresh on launch, resume and device sync (decision 2026-10-09); a background refresh would need a Kotlin push route and a detached scheduler`.
- [ ] **Step 2: Recount `PARITY_CHECKLIST.md`.**
  1. Recount each area with `grep -c '^- \[x\]'` and `grep -c '^- \[ \]'` per file, and update the area table, the totals row and the dated counts sentence.
  2. Expected with every task landed: 02 77/77/0, 03 53/52/1, 05 61/60/1, 08 54/51/3, total 494/486/8.
  3. Expected without Task 11: 05 61/59/2, total 494/485/9.

  Trust the recount over these numbers.
- [ ] **Step 3: Update `CHANGES.md`.**
  - Add `## Phase 7: the last parity items (unmerged)` at the top of the phase list, above Phase 6e, with `Branch \`parity/phase-7-final-items\`, everything after a5e415e.`
  - Give it `### Improvements` and `### Fixes` bullets with short hashes, in the existing style.
  - Update the opening paragraph's done and open counts and its commit count.
- [ ] **Step 4: Update the roadmap.** Add `## Phase 7 follow-ups (the last parity items, 2026-10-09)` after the Phase 6e section, in its shape ("What's new for users", then "Left open"). Left open:
  - the `mail:share` finding;
  - folder `sortOrder` on shared folders (not offered; the right Stalwart checks is unverified);
  - tag definitions and folder icons are device-local and not in settings export;
  - Jalali covers only the month grid, titles and stepping, not the agenda, the mini calendar or event dates;
  - the RTL emulator checks;
  - 05:249 closed without a background refresh (the cheaper periodic-reschedule option is recorded);
  - sending from shared accounts (04:74) is a separate phase;
  - any reviewer follow-ups from the final branch review.
- [ ] **Step 5: Commit.** Run `git add` on the six docs paths explicitly, then commit `docs: tick the phase 7 parity items and record what is left`.

---

## Self-review

1. **Spec coverage.**

   | Decision | Covered by |
   |---|---|
   | 1, folder reorder | Tasks 1 and 2 |
   | 2, folder icons | Task 3: toggle, icons, Settings and drawer, app-account key |
   | 3, tags | Tasks 4 and 5: visibility, reorder, nesting with picker and tree, id kept, device-local |
   | 4, folder sharing | Tasks 6 and 7: capability gate, Step 1 check, toasts, reused sheet, principals and store pattern |
   | 5, banner | Task 8 (actor, sequence, collapse, view-in-calendar) and Task 9 (counter review, confirm, notify, banner scope) |
   | 6, RTL | Task 10: verify first, bands, three drawers, physical swipe |
   | 7, Jalali | Task 11: `fa` trigger, Jalali stepping, last feature task |
   | Out of scope | 05:249 closed in Task 12; 04:74 and the Excluded list are in "Not in this phase" |
   | Docs | Task 12 |

2. **Step scan.** Each step names its file, signature, keys or command. No step leaves a choice the plan should make.
   - The research's suggested drawer long-press reorder is left out; Settings alone is enough, per research.
   - The share entry is in both Settings and the drawer, as research proposes.
3. **Type consistency.**
   - `KeywordDef.parentId` / `visibility` (Task 4) are used by `tagRows` (Task 5).
   - `CalendarSystem` / `JALALI` / `calendarSystemFor` match across Task 11.
   - `setMailboxSortOrders` (Task 2) and `getMailboxShareWith` / `setMailboxShare` (Task 6) both live in `email.ts`, which is why those tasks are serialised.
   - `resetPendingNotificationStores` is defined and used in Task 7 only.
4. **Review Focus.** Each of the five lines has a named test in its owning task:
   - 1: Task 2 (API on the scope), Task 6 (scope-bound calls) and Task 9 (`canApplyProposal`);
   - 2: Task 2's planner and UI flag;
   - 3: Task 3 (store keying) and Task 7 (cross-account destroy);
   - 4: Task 4's loop test and Task 5's parent-kept test;
   - 5: Task 11's stepping test.
5. **Proportion.** The plan is about the research's length. Code blocks hold test names and assertions only.
