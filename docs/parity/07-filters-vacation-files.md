# Filters (Sieve), Vacation responder, Files (FileNode)

## Summary
Filters: RN carries a byte-for-byte port of WEB's Sieve parser/generator/tests as of ~1.7.2, so external/Nextcloud/opaque handling, `# Rule:` dedupe, brace-safe parsing and the store logic are at parity. It is missing the 1.7.3 "extended rules" change (multi-value conditions + attachment field + `mime` require); because both clients share one active script, a rule authored on WEB with those features either makes RN fall back to "opaque" mode or, worse, gets silently rewritten as `header :contains "undefined" ...` the next time RN saves anything. RN's FilterRuleModal also never re-seeds its state (always-mounted Modal), so editing a second rule shows and saves the first rule's fields. Vacation: RN has the basic JMAP VacationResponse flow but no HTML body, sends non-UTC `fromDate/toDate`, and has hard-coded English. Files: README's "UI stubs only" is stale - RN has real FileNode browsing (folder = blobId==null), create folder, single-file upload, rename, delete, download/share, RFC 9670 sharing with a principal picker and "shared with me" - but reads the non-existent `updated` property (dates always blank, sort-by-modified is a no-op), does not percent-decode WebDAV-created names, does not reset on account switch, and lacks preview, move/copy/paste/duplicate, favorites/recent, search, upload progress/limits and multi-file upload.

## Findings

### Filters (Sieve)

- [x] **RN generator corrupts WEB-authored attachment rules on any save** — fixed in 1c6aa68 — `P1` — `bug` (missing feature with data-loss side effect)
  - What WEB does: `attachment` field with `has_any`/`has_type` comparators emits `header :mime :anychild ...` and adds `mime` to `require` (`lib/sieve/generator.ts:48-67`, `:132`; types `lib/jmap/sieve-types.ts:16-30`; changelog 1.7.3 "Extended filter rules — attachment field and multi-value conditions").
  - What RN does: `src/lib/sieve/types.ts:21-26` has no `attachment` field. A single-value attachment rule from WEB passes RN's metadata validation (`src/lib/sieve/parser.ts:40-44` only requires strings) and is listed as an editable Bulwark rule. RN's generator has no attachment branch: `src/lib/sieve/generator.ts:36-62` falls through to `HEADER_MAP['attachment']` → `undefined`, emitting `header :contains "undefined" ""` and never adding `mime` to requires. Every RN save regenerates the whole script (`src/stores/filter-store.ts:102-118`: toggle, reorder, add, delete), so one toggle on the phone silently breaks the user's attachment rules server-side. WEB then re-reads that broken condition as a generic header rule.
  - Fix hint: port the WEB generator/parser/types diff (see next item) - `git diff` between `lib/sieve/generator.ts` and `src/lib/sieve/generator.ts` is ~60 lines. Until then, at minimum make `generateCondition` throw / keep `rawBlock` for unknown fields instead of emitting `"undefined"`.

- [x] **Multi-value conditions (string[] values) unsupported → WEB scripts become opaque on RN** — fixed in 1c6aa68 — `P1` — `missing`
  - What WEB does: `FilterCondition.value: string | string[]` (`lib/jmap/sieve-types.ts:40-49`); generator emits Sieve string-lists via `toValueList`/`formatStringArg` (`lib/sieve/generator.ts:15-32`, `57-90`); parser accepts list literals with `parseValueTail`/`classifyMatches` (`lib/sieve/parser.ts:344-400`, `455-484`) and validates array values (`parser.ts:37-44`); modal splits comma input on blur/save (`components/filters/filter-rule-modal.tsx:59-78`, `131-147`, `353-381`); summaries join with the locale's "or" (`components/settings/filter-settings.tsx:46-51`, `114-125`).
  - What RN does: `src/lib/sieve/types.ts:38` `value: string`; `src/lib/sieve/parser.ts:40-44` rejects array values so `parseScript` returns `OPAQUE` (`parser.ts:681`). Result: after a WEB user types "a, b" in one condition, RN shows the "edited outside the visual builder" banner with only raw editing and "Reset to visual builder" (which regenerates an empty script → all rules lost, `src/stores/filter-store.ts:188` + `saveFilters`). If a list value somehow reached the RN modal, `cond.value.trim()` at `src/components/filters/FilterRuleModal.tsx:159` would throw and `<Input value={condition.value}>` (`:271`) would receive an array.
  - Fix hint: apply the WEB diff to `types.ts`, `parser.ts` (`isValidCondition`, `parseValueTail`, `classifyMatches`, body regex), `generator.ts` (`toValueList`, `formatStringArg`, size scalar), then add comma-split/join helpers to `FilterRuleModal`, array-aware `summarizeRule`, and locale keys `value_placeholder_multi`, `attachment_type_placeholder`, `condition_fields.attachment`, `comparators.has_any/has_type` (present in WEB `locales/en/common.json`, absent in RN `locales/en/common.json` settings.filters).

- [x] **FilterRuleModal never re-initialises: editing rule B shows/saves rule A's fields** — fixed in 1c6aa68 — `P1` — `rn-only-bug`
  - What WEB does: `FilterRuleModal` is conditionally mounted (`components/settings/filter-settings.tsx:697-707`), so `useState(rule?.name)` etc. run fresh per open.
  - What RN does: `src/components/settings/FilterSettings.tsx:359-365` always renders `<FilterRuleModal visible={showRuleModal} rule={editingRule} .../>`; the modal seeds `name/matchType/conditions/actions/stopProcessing` only in `useState` initialisers (`src/components/filters/FilterRuleModal.tsx:74-82`) and has no reset effect. Opening "Add Rule" after editing a rule shows the previous rule's content; opening rule B after rule A shows A's fields but saves them under B's `id` (`:170`), overwriting B. Compare `SieveEditorSheet.tsx:33-39`, which does re-seed on `visible`.
  - Fix hint: either mount the modal conditionally (`{showRuleModal && <FilterRuleModal .../>}`) or add a `useEffect([visible, rule])` that resets all local state like `SieveEditorSheet` does.

- [x] **Vacation-active banner is not actionable** — fixed in 3ffcef2 — `P3` — `partial`
  - What WEB does: banner is a button that switches the settings tab to Vacation (`components/settings/filter-settings.tsx:483-507`, `vacation_configure` label).
  - What RN does: plain `View` with title/description only (`src/components/settings/FilterSettings.tsx:231-241`); no "Configure →" affordance.
  - Fix hint: accept an `onOpenVacation` prop from `SettingsScreen` and wrap the banner in a `Pressable`.

- [x] **Expanded ("IF / THEN") visual rule summary missing** — fixed in 3ffcef2 — `P3` — `partial`
  - What WEB does: `VisualRuleSummary` renders condition/action chips with IF/THEN labels and the match-type hint when `expandedFilterView` is on (`components/settings/filter-settings.tsx:89-156`, `612-616`); changelog 1.4.6 "Add expanded visual view for filter rules".
  - What RN does: the `filtersExpandedView` toggle exists (`src/components/settings/FilterSettings.tsx:350-355`) but only lifts the `numberOfLines` clamp on the same one-line summary (`:268`, `:292`); `if`/`then`/`match_all_conditions` locale keys are unused.
  - Fix hint: add a `VisualRuleSummary` component rendering rows of chips (all conditions, all actions) when `expandedView` is true.

- [ ] **Per-account (shared/group) filters not supported** — `P3` — `missing` (depends on whether RN gets managed shared-account settings at all) — deferred: RN has no managed/shared-account settings yet
  - What WEB does: `filter-store` tracks `availableAccounts`/`selectedAccountId` and every Sieve call takes an `accountId` (`stores/filter-store.ts:62-134`); `FilterSettings` scopes to `managedAccountId` and fetches that account's mailboxes for the move target list (`components/settings/filter-settings.tsx:188-232`, `248-255`); client `getSieveAccounts()` (`lib/jmap/client.ts:4465-4469`).
  - What RN does: `src/api/sieve.ts:20-23` always uses the primary Sieve account; store has no account selection (`src/stores/filter-store.ts:32`). No `managedAccount` concept exists in RN (`grep -ri managedAccount src` → none).
  - Fix hint: only if the Accounts area adds shared-account management: thread an optional `accountId` through `api/sieve.ts` and the store's `fetchFilters/saveFilters`.

- [x] **Sieve test files have mojibake in test names** — fixed in 1c6aa68 — `P3` — `rn-only-bug`
  - What WEB does: `lib/sieve/__tests__/*.test.ts` use "→" in `it(...)` names.
  - What RN does: `src/lib/sieve/__tests__/{parser,generator,external-rules}.test.ts` start with a UTF-8 BOM and contain "â†’" (double-encoded arrow) at e.g. `external-rules.test.ts:257`, `:343`, `generator.test.ts:369`, `parser.test.ts:104`. Cosmetic, but it shows the files were copied through a wrong encoding; re-copy from WEB when porting the 1.7.3 changes and add tests for list values / `:mime`.
  - Fix hint: rewrite the three files as UTF-8 without BOM from the WEB copies.

### Vacation responder

- [x] **fromDate/toDate sent without timezone designator (not a JMAP UTCDate)** — fixed in b538a0e — `P2` — `rn-only-bug` — not verified live against stw-test; RFC 8621 UTCDate semantics implemented
  - What WEB does: `datetime-local` → `new Date(local).toISOString()` (`"...T10:00:00.000Z"`) (`components/settings/vacation-settings.tsx:196`, `:207`) and displays via `utcToLocalDatetime` (`:16-20`).
  - What RN does: `toJmapDate` produces `"YYYY-MM-DDTHH:MM:SS"` with no `Z`/offset (`src/components/settings/VacationSettings.tsx:10-19`) and `fromJmapDate` just slices the server's UTC string, showing UTC as if local (`:21-24`). RFC 8621 `VacationResponse.fromDate` is a `UTCDate`; Stalwart will either reject the set (`invalidProperties`) or interpret the wall time as UTC, shifting the schedule by the user's offset. Not verified live - verify against stw-test (`reference_stalwart_stw_test_container.md`) before fixing.
  - Fix hint: parse the typed local time with `new Date(y, m-1, d, hh, mm).toISOString()` and format for display with the device timezone; better, use a native date-time picker.

- [x] **HTML vacation body missing** — fixed in b538a0e — `P2` — `missing`
  - What WEB does: "Formatted message (HTML)" toggle + `RichTextEditor`, sanitised on save with a plain-text fallback derived from the HTML, HTML preview (`components/settings/vacation-settings.tsx:47-48`, `81-83`, `109-127`, `242-258`, `279-293`); store carries `htmlBody` (`stores/vacation-store.ts:10`); changelog 1.7.8 "Vacation: HTML body support".
  - What RN does: store/API already carry `htmlBody` (`src/api/vacation.ts:11`, `src/stores/vacation-store.ts:15`) but the screen never reads or writes it (`src/components/settings/VacationSettings.tsx:63-71` saves only `isEnabled/fromDate/toDate/subject/textBody`). Saving from RN leaves any WEB-set `htmlBody` untouched (partial update), so no data loss - just no way to see/edit/clear it.
  - Fix hint: reuse the composer's editor (RN rich editor) behind an "HTML" toggle; when off, send `htmlBody: null`; derive `textBody` from HTML when empty.

- [x] **No "unsaved changes" gating; Save always enabled** — fixed in b538a0e — `P3` — `partial`
  - What WEB does: `hasChanges` compares local vs. store and disables Save when nothing changed or the end is before the start (`components/settings/vacation-settings.tsx:94-102`, `317`).
  - What RN does: `canSave` only checks warnings (`src/components/settings/VacationSettings.tsx:61`).
  - Fix hint: add a `hasChanges` memo mirroring WEB.

- [x] **"Start date in the past" warning missing** — fixed in b538a0e — `P3` — `partial`
  - What WEB does: `warnings.start_in_past` (`components/settings/vacation-settings.tsx:75-79`).
  - What RN does: only end-before-start, format, empty-body (`src/components/settings/VacationSettings.tsx:56-59`).
  - Fix hint: add the check; RN `locales/en/common.json` already has `settings.vacation.warnings`.

- [x] **Vacation screen is hard-coded English despite locale keys existing** — fixed in b538a0e — `P3` — `rn-only-bug`
  - What WEB does: all strings via `settings.vacation.*`.
  - What RN does: `VacationSettings.tsx` never calls `useLocaleStore`; "Vacation Responder", "Date Range", "Saved", warnings etc. are literals (`:57-59`, `:72-74`, `:88`, `:101-158`). RN `locales/en/common.json` already contains `settings.vacation.{title,description,status,date_range,message,preview,save,saving,warnings}`.
  - Fix hint: wire `t('settings.vacation.…')` like `FilterSettings.tsx` does.

- [ ] **Vacation fetch/save on a shared account** — `P3` — `missing` (same dependency as the filters item) — deferred: same dependency (no managed-account concept in RN)
  - What WEB does: `fetchVacationResponse(client, managedAccountId)` (`components/settings/vacation-settings.tsx:52-56`, `121-128`).
  - What RN does: always `jmapClient.accountId` (`src/api/vacation.ts:27`, `:43`).

### Files (JMAP FileNode)

- [x] **Modification date never shown / sort-by-modified is a no-op (reads `updated`, server property is `modified`)** — fixed in a0ce925 — `P2` — `bugfix-parity` (changelog 1.8.1 "Files: Show the modification date instead of the creation date (#700)", commit 348e032d)
  - What WEB does: requests and reads `modified` (`lib/jmap/client.ts:6478-6486` `FILE_NODE_PROPERTIES`; `lib/jmap/types.ts:891-895` explains that asking for the wrong name silently yields `undefined`; `stores/file-store.ts:177` `lastModified: node.modified || node.created`).
  - What RN does: `src/api/files.ts:18-21` requests `'updated'`; `src/api/types.ts:548` declares `updated?: string`; `FilesScreen.tsx:222-225` sorts on `a.updated` and `:527-529` renders `item.updated` → always undefined, so the list shows no date and "Sort: Modified" does nothing. `FilesSettings` preview promises a Modified column.
  - Fix hint: rename to `modified` in `FILE_NODE_PROPERTIES`, the `FileNode` type, `FilesScreen` sort/render; fall back to `created` like WEB.

- [x] **Percent-encoded names from WebDAV-created nodes shown raw** — fixed in a0ce925 — `P2` — `bugfix-parity` (changelog 1.9.0 "Decode percent-encoded FileNode names from WebDAV-created nodes (#869)", commit 5109aa05)
  - What WEB does: `decodeFileNodeName` (`lib/jmap/filenode-name.ts:17-28`) applied at the client boundary in `getFileNodes`/`listAllFileNodes`/`listAllFileNodesAcrossAccounts` (`lib/jmap/client.ts:23-25`, `:6518`, `:6567`, `:6594`); conservative (needs a valid `%XX`, refuses decoded `/` or NUL).
  - What RN does: `getAllFileNodes`/`getAllFileNodesAcrossAccounts` (`src/api/files.ts:61-126`) return `node.name` verbatim; "Spares%20Catalog" shows as such.
  - Fix hint: port `filenode-name.ts` to `src/lib/` and map nodes through it in both list functions (keep the raw name only if a rename must round-trip the original - WEB doesn't).

- [x] **Files drive not reset on account switch** — fixed in c0e1d6b — `P2` — `bugfix-parity` (changelog 1.9.0 "Reset the account-scoped Files drive on every account switch", commit 5c06ae8b)
  - What WEB does: `initedAccountRef` tracks the account; on change it `clearClient()`s and re-bootstraps (`components/files/files-app.tsx:110-114`, `160-179`).
  - What RN does: `FilesScreen` keeps `allNodes`/`path` in component state and loads only on mount (`src/screens/FilesScreen.tsx:113-114`, `171-173`); `switchAccount` resets contacts/calendar stores but nothing files-related (`src/stores/auth-store.ts:360-380`). Switching accounts while the Files tab is mounted keeps showing the previous account's tree (and any create/upload goes to the new account under a stale `parentId`) until pull-to-refresh.
  - Fix hint: subscribe to `useAuthStore(s => s.activeAccountId)` in `FilesScreen` and reset `path`/`selection` + call `loadFiles()` on change, or move the node cache into a store that `switchAccount` resets.

- [x] **Files capability gated on session capabilities, not the account's** — fixed in a0ce925 — `P3` — `bugfix-parity` (changelog 1.7.5 "Hide Files when the account lacks the filenode capability (#563)")
  - What WEB does: `supportsFiles(accountId)` checks `account.accountCapabilities` (or non-personal) and `probeFileNodeSupport` refuses to probe when the server advertises filenode but the account doesn't (`lib/jmap/client.ts:6418-6458`).
  - What RN does: `useHasFiles()` checks `session.capabilities` (`src/lib/capabilities.ts:33-35`); `App.tsx:184-193` disables the tab from that. An account whose `jmap-file-node-*` permissions were revoked still gets an enabled Files tab that errors on load.
  - Fix hint: check `session.accounts[filesAccountId].accountCapabilities[CAPABILITIES.FILES]` (or `!isPersonal`) in `useHasFiles`.

- [x] **No upload size limit from server config** — fixed in c0e1d6b — `P3` — `bugfix-parity` (changelog 1.4.10 "Files: Use dynamic server-configured maximum upload sizes")
  - What WEB does: filters oversized files against `client.getMaxSizeUpload()` and toasts `file_too_large` (`components/files/files-app.tsx:311-329`; `lib/jmap/client.ts:4179-4182`).
  - What RN does: `startUpload` passes the picked asset straight to `uploadFileNode` (`src/screens/FilesScreen.tsx:345-381`); `grep -ri maxSizeUpload src` → nothing. The server returns an opaque 4xx instead.
  - Fix hint: read `session.capabilities['urn:ietf:params:jmap:core'].maxSizeUpload` and compare with `asset.size` before uploading.

- [x] **Upload buffers whole file in memory, no progress, no cancel** — fixed in a0ce925 — `P2` — `partial` (changelog 1.4.12 "Stream WebDAV PUT uploads (#162)", 1.7.2 "Report real upload progress (#333)")
  - What WEB does: `uploadBlob(file, { signal, onProgress })` with XHR progress and an `AbortController`; progress bar with percent and Cancel (`stores/file-store.ts:591-658`; `components/files/file-browser.tsx:1178-1212`).
  - What RN does: `uploadBlob` reads the entire file with `new File(uri).bytes()` and posts an `ArrayBuffer` (`src/api/blob.ts:22-31`); `FilesScreen` shows only a spinner in the header button (`:460-464`). Large videos/PDFs from the document picker can exhaust memory; the user cannot cancel.
  - Fix hint: use `expo-file-system` `uploadAsync`/`FileSystem.createUploadTask` (supports progress callbacks and cancellation, streams from disk) for the JMAP upload URL, then `FileNode/set`.

- [x] **Single-file upload only; no duplicate-name handling** — fixed in c0e1d6b — `P3` — `partial`
  - What WEB does: multi-select input (`file-browser.tsx:1135-1141`), per-file progress `current/totalFiles`, `getUniqueName` appends " (1)" when a name already exists (`stores/file-store.ts:211-219`, `622-628`).
  - What RN does: `getDocumentAsync({ multiple: false })` (`src/screens/FilesScreen.tsx:357-360`); uploading the same name twice creates two nodes with the same name.
  - Fix hint: `multiple: true` + sequential upload loop; reuse WEB's `getUniqueName` against `visibleFiles`.

- [ ] **No in-app preview (image/text/markdown/PDF/audio/video/eml)** — `P2` — `missing` — deferred: the OS viewer/share sheet stays the mobile answer for now; no inline viewer ported
  - What WEB does: `ImagePreviewModal` and `FilePreviewModal` (text, markdown, PDF incl. mobile pdf.js viewer, audio, video, EML) chosen via `getFilePreviewKind` (`lib/file-preview.ts:29-68`; `components/files/file-preview-modal.tsx`, `image-preview-modal.tsx`, `pdf-mobile-viewer.tsx`; `files-app.tsx:487-495`, `690-708`).
  - What RN does: tapping a file calls `shareAttachment` which downloads to cache and hands off to the OS share/viewer sheet (`src/screens/FilesScreen.tsx:248-258`; `src/lib/email-export.ts` "preview" variant). Works but there is no inline viewer and no "recent files" tracking.
  - Fix hint: reuse whatever attachment viewer the mail area has (image modal / WebView for text+PDF); N/A if the team decides the OS viewer is the mobile answer - then close this item.

- [x] **Move (to folder / to parent), cut/copy/paste, duplicate, new text file, undo missing** — fixed in c0e1d6b — `P2` — `missing` — Move to… (folder picker) and Duplicate done; deferred: cut/copy/paste, new text file, undo (lower priority on mobile)
  - What WEB does: `moveToFolder`, `moveToParent`, `cutResources`/`copyResources`/`pasteResources` (copy via `copyFileNode` = new node reusing the blobId), `duplicateResource`, `createTextFile`, `undoLastAction` with toast Undo (`stores/file-store.ts:825-933`, `1006-1015`; `lib/jmap/client.ts:6787-6830` `copyFileNode`; context menu `file-browser.tsx:1674-1801`; drag-drop onto folders and ".." rows).
  - What RN does: actions sheet offers Preview/Share, Save to device, Sharing & access, Rename, Delete only (`src/screens/FilesScreen.tsx:804-858`); `src/api/files.ts` has `updateFileNode(id, { parentId })` (`:149-160`) so move is one call away, but no copy helper.
  - Fix hint: add "Move to…" (folder picker built from `allNodes` folders, then `updateFileNode(id, { parentId })`) and "Duplicate" (`FileNode/set create` with original `blobId/type/size`, mirroring WEB `copyFileNode`). Cut/copy/paste and undo are lower priority on mobile.

- [x] **Favorites, recent files, search/filter, details pane missing** — fixed in c0e1d6b — `P3` — `missing` — search field and a type/size/modified line in the actions sheet done; deferred: favorites/recent (optional)
  - What WEB does: favorites and recent (pruned against server nodes on refresh, changelog 1.4.12 #146) persisted in localStorage (`stores/file-store.ts:243-248`, `518-527`, `988-1004`); in-list search (`file-browser.tsx:494-525`, `1106-1132`); details sidebar with type/size/modified/path (`:1929-1969`).
  - What RN does: none of these (`FilesScreen.tsx` has no search state; settings has no favorites store).
  - Fix hint: a header search field filtering `visibleFiles` is cheap; details can be a row in the actions sheet; favorites/recent optional.

- [x] **Multi-select batch download; batch delete only** — fixed in c0e1d6b — `P3` — `partial`
  - What WEB does: multi-select toolbar offers Download (N) and Delete (N) (`file-browser.tsx:979-999`).
  - What RN does: selection header offers Delete only (`src/screens/FilesScreen.tsx:405-427`).

- [x] **Sort direction/key only changeable in Settings; no in-screen column sort** — fixed in c0e1d6b — `P3` — `partial`
  - What WEB does: clickable Name/Size/Modified headers toggle sort (`file-browser.tsx:814-828`, `1529-1546`).
  - What RN does: sort comes from `filesDefaultSortKey/Dir` settings only (`FilesScreen.tsx:134-135`, `210-231`).
  - Fix hint: a sort chip in the header cycling name/size/modified + direction; fix the `modified` property first.

- [x] **Settings exposed but ignored: folder layout "Sidebar" and "Show thumbnails"** — fixed in c0e1d6b — `P3` — `rn-only-bug` — thumbnails implemented (authenticated Image), folder-layout radio removed (sidebar is N/A on a phone)
  - What WEB does: `folderLayout: 'sidebar'` renders `FolderTreeSidebar` and hides folders from the list (`file-browser.tsx:497-500`, `1223-1269`); `showThumbnails` renders image thumbnails (`:272-297`, `:1494-1496`).
  - What RN does: `FilesSettings.tsx:161-171`, `219-224` offer both toggles and preview them, but `FilesScreen` never reads `filesFolderLayout` or `filesShowThumbnails` (only `showIcons/coloredIcons/showHiddenFiles/sort/view`, `:131-136`).
  - Fix hint: either implement thumbnails (`<Image source={{ uri: getFileNodeDownloadUrl(node), headers: { Authorization } }}>` for image extensions) and drop the folder-layout radio (sidebar is N/A on a phone), or hide both settings.

- [ ] **Legacy flat-name migration not run on RN** — `P3` — `missing` (changelog 1.7.3 #379; WEB `stores/file-store.ts:286-479`) — deferred: WEB runs the one-time migration; not ported to mobile
  - What WEB does: on first listing, reparents nodes named with `/`, `∕`, `⁄`, `／` separators and replaces blob-backed "dir marker" files with real folders, with a progress overlay (`files-app.tsx:245-263`, `710-734`).
  - What RN does: reads only the real hierarchy (`src/api/files.ts:6-14` comment acknowledges WEB migrates). A user who never opens WEB sees legacy files as flat names at the root. Acceptable if WEB is always used at least once; otherwise port `migrateLegacyFlatNodes`.

- [ ] **Deep link `/files/<folder>` and `?preview=` not handled** — `P3` — `missing` (changelog 1.8.1 "Deep links for mail, calendar, contacts, files") — partly: `/files` links open the Files tab since 5802cae; folder paths and `?preview=` are ignored
  - What WEB does: `parseFilesPath`/`buildFilesPath` walk the drive to the folder and open the preview (`components/files/files-app.tsx:190-278`; `lib/deep-links.ts:381`).
  - What RN does: `src/navigation/linking.ts` (5802cae) turns any `/files/...` link into `{ kind: 'files' }` and opens the tab; `Files: undefined` in `src/navigation/types.ts:35`.
  - Fix hint: parse the rest of the path in `linking.ts`, pass it to `Files` as a `path` param and walk `allNodes` by names.

- [x] **Hard-coded English throughout Files screen and ShareSheet** — fixed in c0e1d6b — `P3` — `rn-only-bug`
  - What WEB does: everything via `files.*` locale keys (`locales/en/common.json` `files` has ~120 keys incl. `share`, `shared`, `shared_with_me`, `shared_by`).
  - What RN does: `FilesScreen.tsx` ("New folder", "Delete this item?", "Shared by", "Upload unavailable"…, e.g. `:148`, `:310`, `:521`, `:621`, `:722-727`, `:825-849`) and `ShareSheet.tsx` (`:41-45`, `:160-166`, `:175`, `:219-242`) use literals, even though RN `locales/en/common.json` already has a `files` block (`:1513`) with most of these keys.
  - Fix hint: wire `useLocaleStore(s => s.t)` with the existing keys; add `share/shared/shared_with_me/shared_by` from WEB.

- [ ] **Stability warning banner not shown** — `P3` — `partial` — deferred: product call, not shown on mobile
  - What WEB does: persistent yellow "stability_warning" above the browser (`files-app.tsx:617-620`; changelog 1.4.10 "Update file feature disabled messages and add stability warnings").
  - What RN does: nothing. Optional; product call.

- [x] **Storage quota not surfaced in Files** — `P3` — `missing` (partly N/A) — done in 490355c: the quota shows in Account settings; Files shows none (like WEB's mobile layout)
  - What WEB does: passes `quota` from the email store into the navigation rail beside Files (`files-app.tsx:55`, `:569`); changelog 1.7.5 "Storage quota not shown with Stalwart (#577)".
  - What RN does: `FilesScreen` shows no quota. Whether RN shows quota anywhere is outside this area; if it exists in Settings/Account, this is N/A.

- [x] **README still says "file storage - UI stubs only"** — fixed in c0e1d6b — `P3` — `rn-only-bug` (docs)
  - `repos/react-native/README.md:30` lists filters, S/MIME, plugins, themes and file storage as stubs; filters, vacation and files are real implementations (`src/api/files.ts`, `src/screens/FilesScreen.tsx`, `src/components/files/ShareSheet.tsx`, `src/api/__tests__/files.test.ts`). Update the README when the items above land.

## Verified at parity (brief list, so the fixer knows what NOT to redo)
- Sieve parser/generator/types are a faithful port up to 1.7.2: `diff -w --strip-trailing-cr lib/sieve/parser.ts repos/react-native/src/lib/sieve/parser.ts` shows only the multi-value/attachment hunks (and `debug.warn` → `console.warn`). Included and identical: `@metadata` JSON round-trip, external-rule parsing with origin labels (Roundcube/Nextcloud/etc., changelog 1.4.14 #201), Nextcloud marker regions preserved verbatim, `# Rule:` dedupe of Bulwark blocks that failed to re-parse (1.7.0 "literal braces" fix, `parser.ts` `findBodyOpenBrace` + `filteredExternal`), vacation-only script detection, `externalRequires` merge, `INBOX` canonical path (1.7.1 #313: `FilterRuleModal.tsx:57`), all 10 action types, `computeRequires` (fileinto/copy/imap4flags/reject/body/vacation), `stop` folding into `stopProcessing`. Since then the webmail writes "Keep" as `fileinto "INBOX"` (62465e1e, #1027) and added the vacation `include`, `:mailboxid` targets, `redirect :copy` and the spam guard; ported in f63d739, d53bfec, 3f88868 and 6c31c8d.
- Filter store semantics identical: skip server-managed `vacation` script (1.4.10), keep activation via `onSuccessActivateScript` on create/update (1.4.10), external/opaque rules read-only, bulwark rules kept contiguous before external ones, `addRule/updateRule/deleteRule/reorderRules/toggleRule`, rollback on failed save, opaque banner with "Open raw editor" / two-step "Reset to visual builder", `SieveScript/validate` via uploaded blob with error-method handling, `createSieveScript('filters')`.
- Filter rule editor: name/match type/conditions (from/to/cc/subject/header+name/size/body)/comparators/actions (move & copy folder picker from own non-shared mailboxes, forward, reject text, add_label from keywords store, mark read/star/discard/keep/stop)/stop-processing; empty-name/condition/action validation; comparator reconciliation on field change; default first mailbox for move/copy. Reorder via up/down chevrons instead of drag (fine on mobile). Delete uses a native confirm. Mailboxes are loaded at login (`src/stores/auth-store.ts:84`), so WEB fix #485 (load mailboxes when Filters opened directly) is not needed.
- Raw Sieve editor: warning banner, Validate with server errors, two-step confirm save, re-seeds on open, atomic `setOpaqueScript`.
- Vacation: `VacationResponse/get|set` on singleton with `core+mail+vacationresponse` using, default object when the list is empty, capability gating (`isVacationSupported`), enable toggle + status pill, subject, plain-text body, preview, end-before-start warning, empty-body warning, error surfacing.
- Files API: folder detection `blobId == null` (`src/api/files.ts:12-14`), `FileNode/get ids:null`, which Stalwart caps at `maxObjectsInGet` (500), continued since 4eb8c47 by paging `FileNode/query` (which lists folders too since Stalwart 0.16.6) and batched gets (#1069), `shareWith/myRights` requested explicitly, `principals:owner` in `using` only when advertised (sharing is gated on `principals` since caea3d0), real-hierarchy folder create without blob/type/size, cascade delete with `onDestroyRemoveChildren`, MIME-type >30 chars → `application/octet-stream` (1.4.12), cross-account "shared with me" aggregation with `accountId:nodeId` namespacing and owner-routed download URLs, shared subtrees browsable and writes hidden inside them, `Share2`/`Users` badges, ShareSheet with the same read/readWrite/manager presets as WEB `FILE_PRESETS`, custom-rights detection, principal search excluding self, revoke, refresh after change; unit tests in `src/api/__tests__/files.test.ts`.
- Files UI: list/grid toggle persisted to settings, folder breadcrumb, pull-to-refresh, hidden-file filter, colored/plain icons, long-press multi-select (own nodes only), rename/new-folder prompts rejecting `/`, delete confirmation naming folder cascade, path stack pruned when a folder disappears, Files tab disabled when the capability is missing.

## N/A on mobile
- Drag-and-drop upload / whole-folder upload (`uploadFolder`, `getDroppedFilesAndFolders`), drag-out of files, marquee selection, keyboard shortcuts (Ctrl+A/C/X/V, F2, Delete, Backspace), right-click context menus, resizable folder-tree sidebar, breadcrumb right-click dropdown, `?preview=` window title updates, `window.open` blob preview safety list (`isMimeTypeSafeForInlinePreview`).
- WebDAV proxy client (`lib/webdav/client.ts`, `stores/webdav-store.ts`) - WEB itself only uses it for calendar collections now; the Files app is JMAP-only, so RN correctly has no WebDAV code.
- Pro-shell cross-account Files picker / `accountFolders` / `__account_root__` breadcrumb sentinel, `filesEnabled` admin policy gate (RN has no policy store), plugin hooks `onSieveScriptGenerate`/`onFiltersSave`.
- Drag-to-reorder filter rules (RN uses chevrons), line-number gutter and Tab-inserts-spaces in the Sieve editor (RN shows "N lines" below it).
- "Attach from Files" in the composer and "Save attachment to Files" in the viewer: neither client implements these (WEB composer only takes local files, `components/email/email-composer.tsx:1391-1555`; no `createFileNode` call outside the Files store), so nothing to port.
