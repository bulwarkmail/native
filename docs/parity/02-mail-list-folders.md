# Mail list, mailboxes/folders, unified views, search, tags, batch actions

## Summary
RN covers the core single-folder loop well (folder tree incl. shared/group accounts with owner-routed mutations, incremental Email/queryChanges refresh, offline seed, swipe actions with reveal mode, multi-select with archive/move/delete/tag and an undo snackbar WEB does not even have). The biggest gaps are: (1) tags are invisible in the list and there is no tag view/tag counts; (2) spam/not-spam only moves the message and never flips `$junk`/`$notjunk` (#850), and there is no not-spam in the list at all; (3) search is always folder-scoped (WEB defaults to all folders, #788) with no history/suggestions; (4) the unified inbox is a one-shot, inbox-only, cross-account-only screen with no actions, paging, counts, Unread/Starred/All-mail views or per-role views; (5) folder management is create/rename/delete only (no subfolders, move, reorder, empty folder, mark folder read); (6) several WEB bugfixes are still live in RN: #771 substring dedup hides folders, permanent delete has no confirmation, Sent/Drafts show sender instead of recipient, "Never" mark-as-read marks read instantly, pins are written as `$important` instead of `$pinned`. One P1 RN-only bug: opening a message from the unified inbox that is not in the active folder page renders another message's body in the pager.

## Findings

### Folder tree / mailboxes

- [x] **Folders whose name contains a system folder name disappear (#771)** — `P2` — `bugfix-parity` — fixed in 516c9c9
  - What WEB does: dedup only drops a root folder whose name is an *exact* (trimmed, case-insensitive) match of a role folder in the same account (`lib/utils.ts:270-333`, comment cites #771; changelog 1.9.0).
  - What RN does: `deduplicate()` in `src/lib/mailbox-tree.ts:49-68` uses `lower.includes(rn) || rn.includes(lower)` — "Old Inbox", "2025 Archive", "Sent to Accounting" vanish from the drawer and the move sheet (also from `findTrashMailbox` etc. only indirectly).
  - Fix hint: replace the substring test with `r.name.trim().toLowerCase() === lower`; keep the nested/parent guards. Add a case to `src/lib/__tests__/mailbox-tree.test.ts`.

- [x] **Role folders not localized (#404)** — `P3` — `missing` — fixed in 6ae21d5
  - What WEB does: `localizeMailboxName(role, name, t)` maps inbox/sent/drafts/trash/archive/junk/important/flagged/all to translated labels (`lib/mailbox-label.ts:35`); used by sidebar (`components/layout/sidebar.tsx:520`), move menu, context menus.
  - What RN does: raw server name everywhere: drawer `src/components/SidebarDrawer.tsx:491`, list header `src/screens/EmailListScreen.tsx:637-641`, `MoveSheet.tsx:120`, `FolderSettings.tsx:26-29` (English-only pill).
  - Fix hint: add `src/lib/mailbox-label.ts` (port of WEB) using `useLocaleStore().t` keys `sidebar.mailboxes.*` (already present in `locales/*/common.json`), apply in the four places.

- [x] **Setting to hide the total message count on folders (#498)** — `P3` — `missing` — fixed in 6ae21d5
  - What WEB does: `showFolderTotalCount` setting (`stores/settings-store.ts`, `components/settings/layout-settings.tsx:236`) hides the `/ total` part in `SidebarRowCounts` (`components/layout/sidebar.tsx:207-209`).
  - What RN does: `RowCounts` always shows unread/total (`src/components/SidebarDrawer.tsx:68-79`).
  - Fix hint: add `showFolderTotalCount` to settings-store + LayoutSettings toggle; gate `total` in `RowCounts`.

- [x] **Create subfolder / choose parent when creating** — `P3` — `partial` — fixed in 6ae21d5
  - What WEB does: "New subfolder" in the folder context menu and `subfolder_of` in settings (`components/layout/mailbox-context-menu.tsx:187-193`, `components/settings/folder-settings.tsx:408-423`); store `createMailbox(client, name, parentId, accountId)` (`stores/email-store.ts:3753`), incl. creating in a shared account.
  - What RN does: `FolderSettings.saveDraft` always calls `createMailbox({ name })` (`src/components/settings/FolderSettings.tsx:96`) although `createMailbox` in `src/api/email.ts:156` already accepts `parentId` and `accountIdOverride`.
  - Fix hint: add a "Parent folder" select (own folders, or the shared account when creating there) to the editor modal and pass `parentId`.

- [ ] **Move folder to another parent (#855) and reorder folders (sortOrder)** — `P3` — `missing` — partial in 6ae21d5: "Move under" picker + parent re-fetch done; deferred: sortOrder reorder UI (no drag-and-drop on mobile yet)
  - What WEB does: drag & drop in folder settings and sidebar reparents (`moveMailbox` `stores/email-store.ts:3898-3956`, refetches after reparent per #855) and reorders via `sortOrder` (`reorderMailboxes` `:3859`); folder-settings DnD plan `components/settings/folder-settings.tsx:241-262`.
  - What RN does: no UI; `updateMailbox` in `src/api/email.ts:185` accepts `parentId` but not `sortOrder`. Tree sorts by `sortOrder` already (`src/lib/mailbox-tree.ts:70-81`).
  - Fix hint: in the rename editor add a "Move under…" picker (own-account folders, excluding descendants) → `updateMailbox(id, { parentId })` then `fetchMailboxes()`; optionally up/down buttons writing `sortOrder`.

- [ ] **Assign/clear a folder role, custom folder icons, colorful-icon toggle** — `P3` — `missing` — partial in 6ae21d5: role picker + #288 role icons done; deferred: per-folder custom icons and the colorful-icon toggle (cosmetic)
  - What WEB does: role dropdown per folder (`components/settings/folder-settings.tsx:366-380`, store `setMailboxRole` `stores/email-store.ts:3830`), per-folder icon picker (`folder-settings.tsx:77`, `folderIcons` setting), `colorfulSidebarIcons` toggle (`layout-settings.tsx:222`). Distinct icons for shared/important/memos/scheduled/snoozed roles (#288, `components/layout/sidebar.tsx:131-160`).
  - What RN does: fixed role colours always on, `iconFor` knows only inbox/sent/drafts/trash/junk/archive/star (`src/components/SidebarDrawer.tsx:36-66`); no role assignment.
  - Fix hint: low priority; at least extend `iconFor` with the #288 roles (important/memos/scheduled/snoozed/shared) and ideally a role picker in FolderSettings using `updateMailbox(id, { role })` (needs `role` added to the `changes` type).

- [x] **Hide the server "Scheduled" role folder when the virtual Scheduled row is shown (#495)** — `P3` — `bugfix-parity` — fixed in 6ae21d5
  - What WEB does: filters `role === 'scheduled'` nodes out of the own tree while the virtual row is rendered (`components/layout/sidebar.tsx:986-990`).
  - What RN does: drawer always renders the virtual "Scheduled" quick row (`src/components/SidebarDrawer.tsx:447-453`) and would also list a Stalwart `role: scheduled` mailbox as a plain folder.
  - Fix hint: skip nodes with `role === 'scheduled'` in `buildMailboxTree`/drawer when `jmapClient.hasDelayedSend()`.

- [x] **Empty folder (Trash/Junk) — with #711 pagination** — `P2` — `missing` — fixed in 3194b5e
  - What WEB does: "Empty folder" banner/button in Trash & Junk and in the folder context menu (`components/email/email-list.tsx:457-479`, `components/layout/mailbox-context-menu.tsx:213-219`); `client.emptyMailbox` loops `Email/query` + back-referenced `Email/set destroy` in batches of `min(500, maxObjectsInSet)` and never gates on `total` (`lib/jmap/client.ts:2288-2325`, changelog 1.8.1 #711); store zeroes counters (`stores/email-store.ts:3958`).
  - What RN does: nothing — the only way is select-all-on-page + delete, page by page.
  - Fix hint: add `emptyMailbox(mailboxId, accountId?)` to `src/api/email.ts` mirroring the WEB loop (stop when `found.length === 0 || destroyed === 0 || found.length < batch`), a confirm `Alert`, a button in the list header when `currentMailbox.role` is trash/junk, then `refreshEmails()` + `fetchMailboxes()` and `dropFromCache`.

- [x] **Mark folder / folder tree / all folders as read** — `P2` — `missing` — fixed in 6ae21d5
  - What WEB does: folder context menu → `markMailboxAsRead` (paged `Email/query notKeyword $seen` + `Email/set`, `lib/jmap/client.ts:2327-2364`), "mark folder tree read" and "mark all folders read" with confirm (`components/mail/mail-app.tsx:2571-2645`, `client.markAllAsRead` `:2366`); store zeroes unread counters (`stores/email-store.ts:4003-4043`).
  - What RN does: only per-message and batch-on-loaded-page mark read (`EmailListScreen.tsx:456-464`).
  - Fix hint: long-press on a drawer folder row → action sheet (Mark all read / Empty / Rename / Delete / New subfolder); api `markMailboxAsRead(rawId, accountId)` with the paged loop; then `fetchMailboxes()` and, if current, `refreshEmails()`.

- [x] **Retry button after a failed first load does not retry the mailbox fetch** — `P2` — `rn-only-bug` — fixed in 3194b5e
  - What WEB does: retries mailbox fetch on first login for lazy provisioning (#217) and keeps the tree on later failures (#780).
  - What RN does: when `fetchMailboxes` fails with zero mailboxes it sets `error` (`src/stores/email-store.ts:610-612`); the list shows the error with a "Retry" that calls `refreshEmails()` (`src/screens/EmailListScreen.tsx:812`), which returns immediately because `currentMailboxId` is null (`email-store.ts:773`). The mount effect only re-runs when `mailboxes.length` changes, so the user is stuck until an app restart.
  - Fix hint: Retry should call `fetchMailboxes()` when `mailboxes.length === 0` (then the inbox-select effect kicks in); consider one automatic retry after ~2 s on first login.

- [x] **No coalescing of concurrent refreshes (maxConcurrentRequests / 429)** — `P3` — `partial` — fixed in f07e039
  - What WEB does: `coalesceRefresh` shares an in-flight `fetchMailboxes`/`refreshCurrentMailbox`/tag-count run and queues at most one re-run (`stores/email-store.ts:383-425`, #780).
  - What RN does: every push event awaits `fetchMailboxes()` then `refreshEmails()` (`src/stores/email-store.ts:981-1015`); overlapping pushes, the mount effects (`EmailListScreen.tsx:554-567`) and `archiveEmail`'s follow-up `fetchMailboxes` can all run in parallel; a `RateLimitError` (`src/api/jmap-client.ts:436-440`) is only logged. The tree itself is preserved on failure (`email-store.ts:604-612`), so this is perf/noise rather than data loss.
  - Fix hint: wrap `fetchMailboxes`/`refreshEmails` bodies in a small in-flight map keyed by `activeAccountId` with a single queued re-run, like WEB's `coalesceRefresh`.

- [x] **Tap the unread count of a folder to open it filtered to unread** — `P3` — `missing` — fixed in 6ae21d5
  - What WEB does: unread badge is a button that toggles `isUnread: true` on that folder (`components/layout/sidebar.tsx:570`, `components/mail/mail-app.tsx:2533-2567`).
  - What RN does: counts are static text (`SidebarDrawer.tsx:68-79`).
  - Fix hint: make the unread count pressable → `selectMailbox(id)` then `setFilters({ isUnread: true })`.

- [x] **Shared-account header has no folder actions** — `P3` — `missing` — fixed in 6ae21d5
  - What WEB does: right-click on a shared account header offers "New folder" in that account (`components/layout/sidebar.tsx:handleSharedAccountContextMenu`, `mailbox-context-menu.tsx:119-147`; changelog 1.9.0 "route shared-folder management to the owner account").
  - What RN does: `FolderSettings` manages own folders only (`src/components/settings/FolderSettings.tsx:47-50`); the account node in the drawer only expands/collapses (`SidebarDrawer.tsx:499-503`).
  - Fix hint: after the subfolder/move work, add an account picker (own + shared accounts the user `mayCreateChild` in) to the folder editor and pass `accountIdOverride`.

### Unified mailbox / cross-account views

- [x] **Unified scope: account-bounded by default, cross-account opt-in; single-account + group inboxes case** — `P2` — `partial` — fixed in 6ae21d5
  - What WEB does: unified views stay inside the active account (own + shared/group folders) unless `unifiedCrossAccount` is on *and* the admin gate allows it (`components/mail/mail-app.tsx:465-500`, `stores/settings-store.ts:405-431`); the section is shown with one account as soon as `includeGroupInUnified && hasGroupInboxes` (`components/layout/sidebar.tsx:905-907`).
  - What RN does: "All inboxes" is shown only when `accounts.length > 1` (`src/components/SidebarDrawer.tsx:438-446`) and always spans every account (`src/api/unified-inbox.ts:236-257`). A single account with group inboxes gets no unified view even with "Include Group Inboxes" on (`ReadingSettings.tsx:257`). Admin policy gates do not exist in RN (see N/A).
  - Fix hint: show the row when `accounts.length > 1 || (includeGroupInUnified && mailboxes.some(m => m.isShared))`; add a `unifiedCrossAccount` toggle (default off, like WEB) and pass only the active account id when it is off. Note WEB's default for `includeGroupInUnified` is `true` (`settings-store.ts:639`) while RN defaults to `false` (`src/stores/settings-store.ts:235`).

- [x] **Unified per-role views (All Sent/Drafts/Junk/Archive/Trash) with live counts** — `P3` — `missing` — fixed in 6ae21d5
  - What WEB does: one row per role present in any account with summed unread/total (`lib/unified-mailbox.ts:295-320`, sidebar rows `components/layout/sidebar.tsx` "unified_*"), counts projected from live mailbox lists.
  - What RN does: inbox only (`src/api/unified-inbox.ts:149`), no counts on the "All inboxes" row.
  - Fix hint: after the per-account mailbox fetch, pick `role` instead of hard-coding inbox; sum `unreadEmails` of each account's inbox for the drawer badge.

- [x] **All mail / Unread / Starred cross views + per-account folder selection** — `P2` — `missing` — fixed in 6ae21d5
  - What WEB does: `buildCrossFilter` (OR of included mailboxes AND `notKeyword $seen` / `hasKeyword $flagged`) fanned out per account (`lib/unified-mailbox.ts:338-492`); default = inbox + custom folders (`CROSS_EXCLUDED_ROLES`), narrowed by `allMailFolderIds[accountId]` chosen in Layout settings (`components/settings/layout-settings.tsx:291-340`); rows show the source folder chip (`components/email/thread-list-item.tsx:385`, `resolveSourceFolderName` `lib/unified-mailbox.ts:63`).
  - What RN does: none.
  - Fix hint: reuse `fetchInboxEmailsForJmapAccount` with a filter built like `buildCrossFilter` over `Mailbox/get` results minus excluded roles; add a `sourceFolder` label to `UnifiedEmail` rows; folder picker can come later.

- [x] **Unified list has no pagination ("load more")** — `P2` — `missing` — fixed in 6ae21d5
  - What WEB does: `loadMoreUnifiedEmails` / cross-view load-more with `position` per account (`stores/email-store.ts:4079-4107`, `1473-1515`).
  - What RN does: fixed `perAccountLimit = 25`, no `position`, no `onEndReached` (`src/api/unified-inbox.ts:236-241`, `src/screens/UnifiedInboxScreen.tsx:175-182`).
  - Fix hint: keep a per-account `position`, add `onEndReached` that re-queries each account at its own offset and merges.

- [x] **Unified search** — `P3` — `missing` — fixed in 6ae21d5
  - What WEB does: text + advanced filter fan-out in all unified/cross views (`lib/unified-mailbox.ts:177-207`, `455-492`; changelog 1.7.8).
  - What RN does: no search box on `UnifiedInboxScreen`.
  - Fix hint: add the same search bar as `EmailListScreen` and AND `{ text: toWildcardQuery(q) }` into each account's query.

- [x] **No actions on unified rows (swipe, star, read, delete, archive, spam, selection)** — `P2` — `missing` — fixed in 6ae21d5
  - What WEB does: every list action resolves the email's own client + owner account via `resolveEmailActionContext` (`stores/email-store.ts:581-640`), incl. batch actions grouped by `sourceAccountId` (`:2634-2660`, `:2740-2760`), archive into the owner's archive (`components/mail/mail-app.tsx:2141-2160`); changelog 1.7.5/1.7.7 "route counter/keyword updates to the email's own account in aggregate views".
  - What RN does: rows are plain `Pressable`s (`src/screens/UnifiedInboxScreen.tsx:95-138`); nothing but open.
  - Fix hint: wrap rows in `SwipeableRow`; because the JMAP client is single-account, actions on a *different registry account* need the detached `jmapPost` path (`unified-inbox.ts:116-131`) with `Email/set` against `email.jmapAccountId`; for the active account and its group accounts route through `setEmailKeywords(..., email.jmapAccountId)` / `moveEmail(...)` overrides.

- [x] **Unified list stays stale after acting on a message; just-read mail handling** — `P3` — `partial` — fixed in 6ae21d5
  - What WEB does: aggregate views refresh through the fan-out on push (`refreshCurrentMailbox`, #791) and keep just-read/unstarred rows in the Unread/Starred views until re-opened (`retainedInViewIds`, `stores/email-store.ts:1007-1050`).
  - What RN does: `UnifiedInboxScreen` loads once per mount/`includeGroup` change (`:57-59`); after opening (mark read) or deleting in the thread screen and going back, the unread dot/row is stale until pull-to-refresh. No push hookup.
  - Fix hint: `useFocusEffect` → reload, or patch the local list from the thread screen result; when Unread/Starred views are added, keep the WEB retain semantics.

- [x] **Opening a unified-inbox message that is not in the active folder page shows another message's body** — `P1` — `rn-only-bug` — fixed in c8be383; the viewer's actions still hit the open folder's account and followed the live list until 5c7301b and 9c31de2 (audit B3, B5)
  - What WEB does: opens the clicked row object itself and fetches by source client/account (#847, `components/mail/mail-app.tsx:3111-3190`).
  - What RN does: `UnifiedInboxScreen.onOpen` switches account then navigates to `EmailThread` (`src/screens/UnifiedInboxScreen.tsx:61-86`). `EmailThreadScreen` pages over the *active folder's* `emails` (`src/screens/EmailThreadScreen.tsx:131-133`, FlatList `data={emails}` `:538`, `initialScrollIndex={Math.max(0, findIndex)}`). A group-inbox message (or any message not in the first page of the user's own inbox snapshot) is not in `emails`, so index 0 is shown: the pane renders `emails[0]` while the toolbar/`activeEmailId` (and delete/archive/spam) refer to the message that was tapped; with an empty snapshot the body area is blank. Bare-id `findIndex` also collides across accounts (Stalwart reuses id ranges, #847).
  - Fix hint: when `route.params.emailId` is not found in `emails` (or `jmapAccountId` is set), page over a one-element list `[{ id, threadId }]` instead of `emails`; compare ids together with the owning account.

- [x] **Unified fetch re-discovers the session and mailboxes on every refresh** — `P3` — `rn-only-bug` — fixed in 6ae21d5
  - What RN does: `fetchInboxForAccount` does `/.well-known/jmap` + `Mailbox/get` + `Email/query` + `Email/get` per account per load (`src/api/unified-inbox.ts:175-234`); the active account is also fetched detached instead of via the live client/snapshot.
  - Fix hint: cache `apiUrl`/`primaryJmapId`/inbox id per account (keyed by serverUrl+username) for the session; use the live `jmapClient` + existing inbox snapshot for the active account.

### List rendering and behaviour

- [x] **Sent/Drafts rows show the sender ("me") instead of the recipient (1.4.12)** — `P2` — `bugfix-parity` — fixed in 3194b5e
  - What WEB does: `showRecipient = role === 'sent' || role === 'drafts'` → uses `email.to[0]` for name/avatar (`components/email/thread-list-item.tsx:128-131`, `579-583`).
  - What RN does: `getSenderName` always reads `from` (`src/screens/EmailListScreen.tsx:31-37`, row `:80-81`, avatar `:118`).
  - Fix hint: pass `currentMailbox?.role` into `EmailRow` and pick `to[0] ?? from[0]` for sent/drafts (also in `UnifiedInboxScreen` if role views are added).

- [x] **Tags are not rendered on list rows (and no tag row tint)** — `P2` — `missing` — fixed in 3194b5e
  - What WEB does: `TagBadge`s per row from `getEmailTagIds` (both `$label:` and legacy `$color:`), thread rows union all messages' tags, optional row tint by first tag (`components/email/thread-list-item.tsx:152-155`, `609-611`, `lib/thread-utils.ts:187-244`, `hooks/use-tag-display.ts`).
  - What RN does: `EmailRow` shows no tags; `tagPill/tagDot/tagText` styles exist but are unused (`src/screens/EmailListScreen.tsx:1481-1495`). Tags are only visible inside the thread screen tag menu.
  - Fix hint: compute tag ids from `item.keywords` (`$label:*`, `$color:*`), look up `useKeywordsStore().keywords` for label/colour (unknown ids → grey with raw id), render pills on the subject row; add a `tintListRowsByTag` setting if desired.

- [x] **Tag view (tap a tag → cross-folder `hasKeyword` list, #175) and tag counts in the drawer** — `P2` — `missing` — fixed in 6ae21d5
  - What WEB does: "Tags" sidebar section with unread/total per tag (`fetchTagCounts`, `stores/email-store.ts:1192`), visibility rules (`components/layout/sidebar.tsx:1002-1013`), `selectKeyword` → `getEmails(undefined, …, '$label:<id>')` across all folders (`stores/email-store.ts:1343-1420`, changelog 1.4.13 #175), counts kept in step with read/unread (1.7.8).
  - What RN does: no tag section in `SidebarDrawer`; `EmailFilters` has no keyword field (`src/stores/email-store.ts:140-149`).
  - Fix hint: add `keyword?: string` to `EmailFilters` and a "Tags" section in the drawer; when set, `buildJmapFilter` should omit `inMailbox` (search across folders) and add `{ hasKeyword: '$label:<id>' }`; counts via one `Email/query` (calculateTotal) per tag, optional.

- [x] **Answered / forwarded status icons (1.4.8)** — `P3` — `missing` — fixed in 3194b5e
  - What WEB does: `Reply`/`Forward` icons from `$answered`/`$forwarded` (`components/email/thread-list-item.tsx:120-121`, `396-412`).
  - What RN does: none (no reference to `$answered` anywhere in `src/`).
  - Fix hint: add the two icons next to the star/paperclip in `EmailRow`.

- [x] **Pin uses `$important` instead of `$pinned`; no pinned-first order or pin icon** — `P2` — `bug` — fixed in 3194b5e
  - What WEB does: pin toggles the `$pinned` keyword (`components/mail/mail-app.tsx:2274-2300`), rows show a `Pin` icon (`thread-list-item.tsx:119`), and the query puts `$pinned` first (`lib/jmap/client.ts:1433-1444`, `buildEmailSort` `lib/message-list-order.ts:165-195`), thread groups too (`lib/thread-utils.ts:82-100`).
  - What RN does: `togglePin` writes `$important` (`src/stores/email-store.ts:1151-1173`), `isPinned` reads `$important` (`src/screens/EmailListScreen.tsx:47-49`); no icon, no ordering. A pin set in RN is invisible in WEB and vice versa.
  - Fix hint: switch the keyword to `$pinned`; show a pin icon; optionally sort pinned to the top client-side (server sort needs the polarity probe, see next item).

- [x] **Configurable message-list order presets/custom levels (#718) incl. Stalwart `hasKeyword` polarity probe; native issue #5** — `P2` — `partial` — fixed in bea3fc4
  - What WEB does: presets (unread/starred/tagged first) or up to 3 levels mapped to the JMAP sort, Inbox-only or all folders (`lib/message-list-order.ts`, `components/settings/message-list-order-settings.tsx:52-62`, `getMessageListOrderFor` `stores/settings-store.ts:1396`); polarity probe per account because Stalwart inverts `isAscending` on keyword comparators (`lib/jmap/client.ts:1376-1431`), `unsupportedSort` fallback (`:1490-1500`); thread grouping mirrors the order (`lib/thread-utils.ts:82`).
  - What RN does: only `receivedAt` asc/desc via `mailSortAscending` (persisted, header toggle `src/screens/EmailListScreen.tsx:699-711`, store `setSortAscending` `src/stores/email-store.ts:1039-1053`). This satisfies the "per default" part of native issue #5 but nothing else.
  - Fix hint: port `message-list-order.ts` (pure, no deps) and pass `buildEmailSort(levels, …)` as `sort` to `queryEmails`/`getEmailQueryChanges`; probe polarity once per account like `probeKeywordSortPolarity`; add a settings screen with the presets. Keep `setSortAscending`'s snapshot invalidation for any order change.

- [x] **Threading: counts only within the loaded page, no Thread/get counts, no conversation open, representative message wrong in ascending sort** — `P2` — `partial` — fixed in 3194b5e
  - What WEB does: groups by `threadId`, `emailCount` from `Thread/get` across folders (`fetchThreadEmailCounts` `stores/email-store.ts:3731-3751`, `lib/thread-utils.ts:14-72`), representative = latest email, mobile tap opens the whole conversation via `getThreadEmails` routed to the owner (#814, `components/mail/mail-app.tsx:3240-3275`), "collapse all threads".
  - What RN does: collapses same-`threadId` rows within the page and counts within the page (`src/screens/EmailListScreen.tsx:224-248`); keeps the *first* row encountered, i.e. the oldest when `mailSortAscending` is on; tapping opens only that single message (`EmailThreadScreen` pages over `emails`, no `Thread/get` anywhere).
  - Fix hint: `Thread/get` for the visible thread ids (chunked) to get real counts; pick the newest message as representative; a conversation screen belongs to the viewer area but the list should hand over `threadId` + owner account.

- [x] **Drafts do not open in the composer / no "Edit draft"** — `P2` — `missing` — fixed in 3194b5e
  - What WEB does: a `$draft` message opens the composer (`handleEditDraft` `components/mail/mail-app.tsx:1812`, list `onEditDraft` `components/email/email-list.tsx:47,616`, context menu `components/email/email-context-menu.tsx:225-233`); viewer shows a draft banner.
  - What RN does: tapping a draft opens the read-only `EmailThreadScreen`; `Compose` params have no draft/edit mode (`src/navigation/types.ts:7-24`), locale keys `email_viewer.draft_banner`/`edit_draft` exist but are unused.
  - Fix hint: in `handleRowPress`, if `item.keywords.$draft` (or folder role is drafts) navigate to `Compose` with a `draft: { id, to, cc, bcc, subject, body, blobId }` param; on send, destroy the old draft (composer area).

- [x] **Permanent delete without confirmation (Trash, `deleteAction: permanent`, junk auto-permanent)** — `P2` — `bugfix-parity` — list side fixed in 3194b5e (single, batch, swipe via `src/lib/delete-confirm.ts`); viewer side done in d2ed27f (`src/screens/EmailThreadScreen.tsx`)
  - What WEB does: confirm dialog before any permanent destroy, single and batch (`components/mail/mail-app.tsx:2086-2100`, `components/email/email-list.tsx:229-247`).
  - What RN does: `deleteEmail`/`deleteEmailsBatch` destroy immediately when in Trash, when `deleteAction === 'permanent'`, or junk + `permanentlyDeleteJunk` (`src/stores/email-store.ts:1286-1298`, `1449-1458`); the swipe fires without any prompt (`EmailListScreen.tsx:369-378`), and no undo is offered (correctly, `:1322-1324`).
  - Fix hint: compute `destroy` in the screen before calling the store (same rule) and show `Alert.alert` with Cancel/Delete; same for the thread screen `onDelete`.

- [x] **"Never" mark-as-read (`markAsReadDelay === -1`) marks read instantly** — `P2` — `rn-only-bug` — fixed in d2ed27f
  - What WEB does: `-1` → never, `0` → instant, else timer (`components/mail/mail-app.tsx:1511-1528`).
  - What RN does: `if (markAsReadDelay > 0) { timer } else { markRead() }` (`src/screens/EmailThreadScreen.tsx:236-245`) so the "Never" option in `ReadingSettings.tsx:171` behaves like "Instant".
  - Fix hint: add `if (markAsReadDelay === -1) return;` before the branch.

- [x] **Load-more appends duplicates when new mail shifts positions** — `P3` — `rn-only-bug` — fixed in f07e039
  - What WEB does: filters `newEmails` by existing ids before appending (`stores/email-store.ts:1620-1625`).
  - What RN does: `merged = [...emails, ...newEmails]` with no dedup (`src/stores/email-store.ts:714-716`); a message that arrived between pages appears twice (duplicate FlatList keys, double rows).
  - Fix hint: `newEmails.filter(e => !existingIds.has(e.id))`.

- [x] **Incremental-refresh window "cap" is a no-op** — `P3` — `rn-only-bug` — fixed in f07e039
  - What RN does: `out.slice(0, Math.max(limit, out.length))` (`src/stores/email-store.ts:885`) never trims although the comment says it caps the window to the page size; harmless but misleading (the snapshot can grow past `emailsPerPage`).
  - Fix hint: either drop the line and comment, or use `Math.max(limit, baseEmails.length)` if the intent is "at least the previous window".

- [x] **Swipe "spam" available in Sent/Drafts and no "not spam" in Junk** — `P3` — `rn-only-bug` — fixed in 3194b5e
  - What WEB does: spam action hidden for sent/drafts/scheduled and flips to "not spam" inside Junk (`components/email/thread-list-item.tsx:523`, `components/email/email-hover-actions.tsx:117-140`, changelog 1.7.7).
  - What RN does: `handleSwipeAction 'spam'` only checks `currentMailboxId !== junkMailboxId` (`src/screens/EmailListScreen.tsx:379-388`), so a swipe in Sent moves your own mail to Junk; in Junk the swipe silently does nothing.
  - Fix hint: skip when `currentMailbox.role` is sent/drafts; in junk call an `undoSpam` (see next item) and change the band label to "Not spam".

- [x] **Spam / not-spam do not flip `$junk`/`$notjunk` (#850) nor honour "trash-and-read"** — `P2` — `bugfix-parity` — fixed in 3194b5e; the viewer's Spam and Not spam stayed a plain move until 5e42c67 (#695)
  - What WEB does: `markAsSpam` patches `mailboxIds` + `keywords/$junk: true` + `keywords/$notjunk: null` (+ `$seen` when `deleteAction === 'trash-and-read'`); `undoSpam` restores the original mailbox with `$junk: null`, `$notjunk: true` (`lib/jmap/client.ts:2422-2475`, store `stores/email-store.ts:2947-3100`, undo toast in `components/mail/mail-app.tsx:2228-2270`).
  - What RN does: swipe and thread-screen spam are plain `moveToMailbox` calls (`src/screens/EmailListScreen.tsx:381`, `src/screens/EmailThreadScreen.tsx:344-356`); the keywords stay untouched, so other clients/Stalwart's classifier never learn; undo label reads "Email moved to Junk".
  - Fix hint: add `markAsSpam(ids, junkRawId, accountId, alsoMarkRead)` / `undoSpam(ids, targetRawId, accountId)` to `src/api/email.ts` writing the keyword pointers; store actions with `pendingUndo.kind = 'spam'` (type already exists, `src/stores/email-store.ts:155`) whose `undoLast` also restores the keywords; queue-safe via an outbox `keywords` op.

- [x] **Batch spam / batch not-spam** — `P3` — `missing` — fixed in 3194b5e
  - What WEB does: `batchMarkAsSpam`/`batchUndoSpam` (`stores/email-store.ts:3104-3236`), "Not spam" button in the Junk selection toolbar (`components/email/email-list.tsx:396-411`, changelog 1.7.8).
  - What RN does: selection header has star/read/tag/move/archive/delete only (`src/screens/EmailListScreen.tsx:572-630`).
  - Fix hint: add a shield button that calls the batch spam/undo-spam from the previous item depending on `currentMailbox.role === 'junk'`.

- [x] **Selecting a collapsed thread row selects/acts on only its newest message** — `P2` — `bug` — fixed in 3194b5e
  - What WEB does: the thread checkbox toggles every message of the thread (`toggleThreadSelection`, `components/email/thread-list-item.tsx:640-660`); single delete/archive on a thread row uses `moveThreadToMailbox` for archive (`components/mail/mail-app.tsx:2141-2180`).
  - What RN does: `selectedIds` holds the representative id only (`src/screens/EmailListScreen.tsx:336-352`, `436-442`), so "3 selected" may be 3 conversations but batch delete/move/archive/tag touch one message each (`deleteEmailsBatch` filters `emails` by id, `email-store.ts:1443`); swipe actions on a thread row likewise act on one message.
  - Fix hint: when threading is on, expand each selected representative to all `emails` with the same `threadId` before calling the batch store actions (and for swipe archive/delete/move on rows with `threadCount > 1`).

- [x] **Keep search/filters when switching folders (#553)** — `P3` — `bugfix-parity` — fixed in f07e039
  - What WEB does: re-runs the active text/advanced search in the newly selected folder (`components/mail/mail-app.tsx:2501-2512`).
  - What RN does: `selectMailbox` resets `searchQuery` and `filters` (`src/stores/email-store.ts:676-677`) and the list input follows (`EmailListScreen.tsx:504-511`).
  - Fix hint: keep `searchQuery`/`filters` in `selectMailbox` (seed the base snapshot only when they are empty) so the search re-runs in the new folder; offer "Clear" as today.

- [x] **Just-read mail dropped from an open Unread-filtered list on the next push refresh** — `P3` — `bugfix-parity` — fixed in f07e039
  - What WEB does: retains rows the user just read/unstarred in the Unread/Starred views until the view is re-opened (`stores/email-store.ts:1007-1050`, `mergeRetainedRows`; changelog 1.9.0).
  - What RN does: `markRead` patches the row in place, but the next `refreshEmails` (push or pull) re-runs the `notKeyword $seen` query (`src/stores/email-store.ts:279`, `917-944`) and the row vanishes while the user is looking at it.
  - Fix hint: keep a `retainedIds` set per filter session; after a full re-query, splice retained rows (from the previous `emails`) back at their old index.

- [x] **Search runs on every keystroke** — `P3` — `rn-only-bug` — fixed in 3194b5e
  - What WEB does: searches on submit / suggestion pick (`components/search/search-box.tsx:108-115`).
  - What RN does: 300 ms debounce into `setSearchQuery` → full `Email/query` + `Email/get` per pause (`src/screens/EmailListScreen.tsx:512-516`); with the `*` wildcard a single letter matches the whole mailbox.
  - Fix hint: search on `onSubmitEditing` (keep the clear button live), or debounce ≥ 600 ms with a minimum of 2 characters.

- [ ] **Date format: no regional date-locale setting; relative strings hard-coded** — `P3` — `partial` — partly: 0205aa0 localized the relative strings; there is still no `dateLocale` setting (see area 08, "Language list not localized")
  - What WEB does: user-selectable regional format (`dateLocale`, changelog 1.7.7) and a preset picker (#331); strings localized.
  - What RN does: `formatListDate` follows the app locale only (`src/lib/date-format.ts:17-31`), "Just now"/"m ago" are English (`:38-41`).
  - Fix hint: localize the relative strings via `t()`; add a `dateLocale` select if parity is wanted.

- [x] **Show avatars in Junk (off by default, 1.5.1); avatar priority** — `P3` — `partial` — fixed in bea3fc4
  - What WEB does: `showAvatarsInJunk` hides favicon/photo images in Junk (`components/email/thread-list-item.tsx:137`); avatar priority contact photo > plugin (Gravatar) > favicon > initials (`components/ui/avatar.tsx:236`).
  - What RN does: favicons always load, including in Junk (`src/components/SenderAvatar.tsx:37`); no contact-photo lookup.
  - Fix hint: pass `disableImages={currentMailbox.role === 'junk' && !showAvatarsInJunk}` into `SenderAvatar`; contact photos optional.

- [x] **Per-message actions from the list (mobile long-press menu)** — `P3` — `partial` — fixed in 3194b5e
  - What WEB does: long-press on mobile opens the context menu (reply/forward/move/tag/pin/spam/mark read/copy link) (`components/email/thread-list-item.tsx:181-190`, `components/email/email-context-menu.tsx`).
  - What RN does: long-press enters selection (`EmailListScreen.tsx:98,425`); single-message move/tag/spam need a swipe (two configurable directions) or opening the message.
  - Fix hint: optional — selection mode already exposes most actions; add "spam" to the selection header (see above) and this is close enough.

- [x] **Own → shared/group folder move (cross-account move, 1.7.2)** — `P3` — `missing` — fixed in 0205aa0
  - What WEB does: copy+delete via `crossAccountMoveEmails`, drop into shared mailboxes allowed (`stores/email-store.ts:1980-2026`, `2169`).
  - What RN does: refuses with "Messages can only be moved within the same account" (`src/stores/email-store.ts:1183-1186`, `1396-1399`); `MoveSheet` is scoped to the same account so the message is only reachable by a future picker. `MoveSheet` also allows Drafts as a target (`MoveSheet.tsx:102-103`) which WEB excludes (`email-context-menu.tsx:163`).
  - Fix hint: exclude `role === 'drafts'` targets; cross-account move = `Email/get` blob → `Blob/upload` to the owner → `Email/import` → destroy (import helper already exists in `src/api/email.ts:423`).

- [x] **Undo snackbar / toast strings not localized; move toast lacks folder path** — `P3` — `partial` — fixed in 3194b5e
  - What WEB does: toasts localized, full folder path in move toast (changelog 1.5.0).
  - What RN does: hard-coded English labels in the store (`src/stores/email-store.ts:1202, 1252, 1328, 1379, 1425, 1520`), "UNDO" (`UndoSnackbar.tsx:73`), list empty/loading strings (`EmailListScreen.tsx:805-830`), filter modal labels, `MoveSheet`/`TagSheet` titles.
  - Fix hint: route through `useLocaleStore().t` (keys already exist for many: `email_list.*`, `notifications.*`).

### Search

- [x] **Search folder scope: always the current folder; no all-folders default (#788) and no folder picker** — `P2` — `bugfix-parity` — fixed in 3194b5e; "All folders" only searched the open folder's account until ee50418 (#1082)
  - What WEB does: `searchMailboxId` defaults to `""` = all folders, is a separate, persisted choice in the filter panel (`stores/email-store.ts:95-101`, `2344-2378`, changelog 1.9.0 #788); cross-mailbox queries.
  - What RN does: `buildJmapFilter` always starts with `{ inMailbox: current }` (`src/stores/email-store.ts:255`); the filter modal has no folder field.
  - Fix hint: add `folder?: string | 'all'` to `EmailFilters` (default `'all'` while a text query or filter is active, i.e. omit `inMailbox`); expose a folder select in the modal; the base-view snapshot logic already keys off `isBaseView`.

- [x] **Body filter, per-chip removal** — `P3` — `partial` — fixed in 3194b5e
  - What WEB does: `body` condition (`lib/jmap/search-utils.ts:62-64`); each chip has an X (`components/search/search-chips.tsx:260-266`).
  - What RN does: no `body` field; chips are read-only, only "Clear" all (`src/screens/EmailListScreen.tsx:725-796`).
  - Fix hint: add `body` to `EmailFilters`/`buildJmapFilter`; make each chip's X call `setFilterField(key, undefined)`.

- [x] **Search suggestions and recent-search history (#845)** — `P3` — `missing` — fixed in 3194b5e
  - What WEB does: recent searches (max 10, persisted) + contact/sender matches under the search box, keyboard navigable, pick a contact → `from:`/`to:` filter (`stores/search-history-store.ts`, `lib/search-suggestions.ts:183`, `components/search/search-box.tsx:34`, `components/mail/mail-app.tsx:2807-2826`).
  - What RN does: plain `TextInput` (`EmailListScreen.tsx:677-698`).
  - Fix hint: small zustand store persisted in AsyncStorage; render a dropdown under the input when focused (recent + `useContactsStore` matches); tapping a contact sets `filters.from`.

### Tags / keywords

- [ ] **Tag definition features: visibility, nesting/parent, reorder, rename with migration, unknown tags** — `P3` — `partial` — partial in 3194b5e: unknown `$label:` ids listed/removable in TagSheet; deferred: visibility, nesting, reorder, rename migration (device-local tag model, see native issue #1)
  - What WEB does: `visibility: show|unread|hide` (`stores/settings-store.ts:180-190`, `components/settings/keyword-settings.tsx:98-132`), nested ids `parent/child` (`lib/keyword-nesting.ts`, `keyword-settings.tsx:213-243`), drag reorder (atomic, changelog 1.9.0), rename keyword migrates messages (`renameKeyword`/`client.migrateKeyword` `lib/jmap/client.ts:1963`), tag picker lists unknown ids present on a message so they can be removed (`components/email/tag-picker.tsx:484-491`).
  - What RN does: `{ id, label, color }` only (`src/stores/keywords-store.ts:9-13`); `TagSheet` lists defined tags only (`src/components/TagSheet.tsx:76-95`), so a `$label:work/clients` set by WEB can neither be seen nor removed on RN. Tag definitions are device-local (see native issue #1).
  - Fix hint: show unknown `$label:*` ids found on the selected emails at the bottom of `TagSheet`; add `visibility` when the drawer tag section lands; nesting/reorder are lower priority.

- [x] **"Reset defaults" wipes the tag list with no confirmation (removed in WEB 1.8.1)** — `P3` — `bugfix-parity` — fixed in 6ae21d5
  - What WEB does: removed the button ("one stray click wiped a carefully built tag list", changelog 1.8.1 Changes).
  - What RN does: `KeywordSettings.tsx:94-97` → `resetDefaults()` immediately (`src/stores/keywords-store.ts:85-88`).
  - Fix hint: remove the button or guard with `Alert.alert` confirm.

- [x] **Scan for keywords no local tag explains (#658)** — `P3` — `missing` — fixed in 6ae21d5
  - What WEB does: `discoverKeywords` pages `Email/query`+`Email/get keywords` and proposes label/colour for unknown `$label:`/`$color:` ids (`lib/jmap/client.ts:1616-1676`, `lib/keyword-discovery.ts:140`, `components/settings/keyword-settings.tsx:374-490`).
  - What RN does: none; after a reinstall all tags must be re-typed with the exact id.
  - Fix hint: port `discoverKeywords` (cap 5000 like offline sync) + `findUnrecognizedKeywords` (pure) and an "Add" list in `KeywordSettings`.

- [x] **Keyword palette parity** — `P3` — `partial` — fixed in 6ae21d5
  - What WEB does: `KEYWORD_PALETTE` keys (`stores/settings-store.ts:226-280`) are the tag ids of the default tags and the colour names used by `suggestKeywordColor`.
  - What RN does: `colors.tags` keys in `src/theme/tokens.ts`; defaults are `important/work/personal/todo` (`src/stores/keywords-store.ts:15-20`) whereas WEB's `DEFAULT_KEYWORDS` (`settings-store.ts:281`) are colour-named. A message tagged on one client with a default tag shows as unknown on the other.
  - Fix hint: verify the key sets match; consider aligning the default ids with WEB's.

### Offline cache (RN only, sanity check)

- [x] **Offline sync covers the primary account only; shared folders never cached** — `P3` — `rn-only-bug` — fixed in 0205aa0
  - What RN does: `runOfflineSync` discovers via `queryEmailsByFilter` which hard-codes `jmapClient.accountId` (`src/lib/offline-sync.ts:55`, `src/api/email.ts:733-747`), so opening a group-folder message offline always fails; `selectMailbox` seeding for a shared folder therefore always yields nothing (`src/stores/email-store.ts:647-666` looks up by raw id, which is correct).
  - Fix hint: iterate `jmapClient.getSharedMailAccounts()` in the sync with `accountIdOverride`, storing the account id in the cache index (`getFullEmails(ids, accountId)` already exists).

## Verified at parity (do not redo)
- Folder tree: nesting, per-account grouping of shared/group accounts with unread roll-up, expanded state persisted, role priority sort (`src/lib/mailbox-tree.ts`, `SidebarDrawer.tsx`); create/rename/delete own folders with server error surfaced (`FolderSettings.tsx`); delete-with-emails confirm.
- Shared/group folders: queries and every mutation (read/star/pin/tag/move/archive/delete/undo/import) routed to the owner account with the unprefixed id (`refFor`, `src/stores/email-store.ts:64-99`); thread screen fetches by owner (`EmailThreadScreen.tsx:90-96`); state-change handling per account (`email-store.ts:981-1015`).
- Folder tree preserved when a refresh fails (#780 equivalent, `email-store.ts:604-612`), shared-account failure isolated (`:595-601`); Mailbox/changes incremental sync with drain.
- Missing Archive/Trash/Junk → error alert (`EmailListScreen.tsx:363-387`), never silently destroys when Trash is missing (#195 equivalent).
- Delete semantics: trash / trash-and-read (#323) / permanent / junk auto-permanent, single and batch (`email-store.ts:1268-1335`, `1434-1527`); undo snackbar for archive/delete/move (single + batch) — RN is ahead of WEB here.
- Archive single / by year / by month with folder creation in one request, batch archive, "Reorganize existing archive" (`src/api/email.ts:579-692`, `ReadingSettings.tsx:105-159`).
- Swipe actions: configurable per direction, instant and reveal modes, pure gesture module with tests, stale-props fix (`SwipeableRow.tsx`, `swipe-gesture.ts`); more actions than WEB (pin, move). RTL: RN ships no RTL locales, nothing to do yet.
- Multi-select: long-press, select-all-visible/indeterminate, batch star/read/tag/move/archive/delete (`EmailListScreen.tsx:320-500`).
- Pagination via `onEndReached`, pull-to-refresh, incremental `Email/queryChanges` + `Email/changes` refresh with per-account state tokens, base-view restore after search (#10), sort change invalidates snapshots (#5), offline seed and fallback.
- Search: full-text with wildcard suffix (`src/lib/search-utils.ts` = WEB `toWildcardQuery`), from/to/subject/date/attachment/unread/starred tri-state filters, chips row, search inside a shared folder routed to its owner.
- Keyword writes send the whole `keywords` map (no JSON-pointer escaping issue, no `false` values) — not affected by 5c484af1 / be97c8bf; tag ids normalized exactly like WEB `normalizeKeywordLevel` (`KeywordSettings.tsx:118-123`); batch tag toggle via `TagSheet` with "all have it" semantics.
- Unread dot (#27), date formats smart/relative/full with 12/24h, preview toggle, density-aware rows, sender favicon avatars with failure cache, `.eml`/`.zip` import into the open folder, Scheduled quick view, "Include group inboxes" setting and shared badge/account dot in the unified list.
- Mark-as-read delay (0/3s/5s) in the thread screen; both clients still display `receivedAt` in the list (WEB `lib/email-date.ts` is not wired into the list yet).

## N/A on mobile
- Category tabs / message-list tabs (`stores/message-list-tabs-store.ts`) — plugin-registered; RN has no plugin runtime.
- Hover quick actions, keyboard navigation/shortcuts, right-click context menus, drag-and-drop of mail onto folders/tags and folder-tab drag (Pro) — desktop interactions; RN has swipe + selection instead.
- Admin policy gates for unified/cross views (`usePolicyStore` feature flags) — RN has no admin policy channel; only the user-side toggles apply.
- Return-to-list-after-action setting — the RN thread screen always returns after delete/archive/spam.
- "Refresh" toolbar button and F5/Ctrl+R interception — pull-to-refresh covers it.
- Favicon unread badge, sidebar collapse/resize, Pro multi-pane shell, folder subscription (neither client exposes `isSubscribed`).
- Plugin search hooks / external search results, `onEmailsFetched` transforms.
- Source-folder chip on rows is N/A *until* All-mail/cross views exist in RN.
