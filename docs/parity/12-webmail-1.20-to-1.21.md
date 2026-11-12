# Webmail 1.20.0 to 1.21.1 and main after it

## Summary
File 11 covered the webmail up to 1.19.1 (4887ed457). This file walks the changelog sections 1.20.0 (2026-11-03), 1.21.0 (2026-11-07) and 1.21.1 (2026-11-11), and every webmail commit in `4887ed457..2c21722ae` (369 without merges; 61 of them after the 1.21.1 tag and not in a changelog section yet). 1.21.1 is the latest webmail release on 2026-11-12. Checked against native origin/main ce5d4dd4. Web paths are relative to the webmail root, native paths to this repo.

The commits were split by area into four lists (reading and the mail list; compose and PIM; platform; desktop, admin and deploy), each walked by its own pass, and the rows merged here. Eleven rows that two passes both found are kept once. Where a pass cited a merge or the current file instead of a commit, the commit history is folded into a merge (the local webmail clone is shallow at some points).

Counts: 101 rows, P1 2, P2 15, P3 84.

What stands out:
- Two P1s. An organisation that locks external content to "block" still gets remote images from trusted senders in the app. Saving a contact rewrites every email, phone and address entry under new keys and drops what the form doesn't show (labels such as "car", `pref`, extra address parts).
- The organisation policy grew a lot in 1.20 and 1.21 (device rules, announcements, classification labels, refused accounts, external mail, session limits). The app keeps the policy's `organisation` part but reads only the signature, disclaimer, recovery and templates from it. The push-without-content rule is being built on the security branch (fix/security-audit-2026-11, 6e1ead37 and follow-ups), so it is not repeated here.
- Push catch-up: the webmail now fetches what changed while its live connection was down (#1553). The app reconnects without catching up.
- Smaller P2 bugs with a direct port: folder lists over the server's get limit (#1502), tags with non-Latin names (#1613), deleted-item recovery on Stalwart 1.0 (#1480), template placeholders with a default (#1609), HTML event descriptions, repeating tasks (#1621), regex filter rules (#885).
- The webmail's offline database, app lock and remote wipe are large and mostly desktop-driven; they are P2/P3 rows with notes.

Classification: `bug` = fixed in the webmail, still live in the app; `missing`; `partial`. Not applicable on mobile and left out (same list as files 10 and 11, plus the desktop app): admin panel, plugins and marketplace, sidebar apps, command palette, keyboard shortcuts and keyboard navigation, print, Bulwark Lite, CSP/third-party switch as a server feature, Mountain View, desktop-only layout (drag and drop, hover, multi-pane, window menus, tray, popout windows), the desktop app (Electron, lib/desktop), server routes the app doesn't use, Docker, Kubernetes and deploy, docs, demo mode, CI, boot skeleton and web first-paint performance, and translation-only entries. None of the 369 commits changes the contract of a webmail route the app calls (/api/config, the OAuth metadata, /login hand-off, handoff/redeem, pair/redeem, /api/admin/policy, /api/bimi); /api/config only gained keys and `policy.defaults` can now hold lists, which the app's sanitizer drops without harm.

## Findings

### Security

- [x] **Signing in again to an account already on the phone leaves the old OAuth grant open on the server** — `P3` — `partial` — fixed in 77d28679
  - What WEB does: when an account that is already signed in signs in again, the refresh token it replaces is revoked instead of left valid on the server (`lib/auth/lite-tokens.ts`, `stores/auth-store.ts`). 66d46d23a (#1571, changelog 1.21.0 Security, Lite only).
  - What RN does: revokes the refresh token only on sign-out and removal (`src/stores/auth-store.ts:553`, `:918`, `:1177`). A new sign-in to a registered account (`wasRegistered`, `src/stores/auth-store.ts:436`) stores the new credentials over the old ones without revoking them. Read from the code, not tried on a device. Low risk: the old token is gone from the phone, only the server grant stays.
  - Fix hint: before writing the new credentials of a registered OAuth account, call revokeRefreshToken with the old bundle, best effort.

### Reading mail

- [ ] **A trusted sender still loads remote content while the organisation locks remote content to "block"** — `P1` — `bug`
  - What WEB does: remote content counts as blocked by the organisation when the policy locks or limits External content to "block", not only under no-third-party traffic, and then neither trusted senders nor "load once" lift it, in the reader, replies, reopened drafts and previews (`hooks/use-third-party-mode.ts:35`, `:90`, `components/email/email-viewer.tsx:1563`). 84de2395f, 128f61646 (1.20.0 Security).
  - What RN does: only no-third-party traffic overrides trust (`src/stores/policy-store.ts:315`, `src/components/EmailBodyView.tsx:443`); with the setting locked to "block" a trusted sender passes `!trusted && ... !== 'allow'` and the WebView loads remote images (`src/components/EmailBodyView.tsx:513-533`). The composer's quote does the same (`src/screens/ComposeScreen.tsx:537-538`).
  - Fix hint: add the "locked or limited to block" check from the policy restrictions to `remoteBlockedByOrg` in EmailBodyView and ComposeScreen.

- [x] **A message reported as phishing keeps working links, and there is no Report phishing** — `P2` — `missing` — fixed in 70b0d65b, e3a47be5
  - What WEB does: when the admin sets a report address, Report phishing sends the message to it (forward or ARF), moves it to Junk with `$phishing`; a message with `$phishing` shows a banner and every link in it is turned off (`lib/phishing-report-flow.ts:72`, `lib/phishing-links.ts:13`, `:26`, `components/email/email-viewer.tsx:3280`). 50f95f446.
  - What RN does: nothing reads `$phishing` (no match in `src/`), so a message reported on the webmail opens on the phone with live links and no warning; the body goes through EmailBodyView unchanged (`src/components/EmailBodyView.tsx:613`).
  - Fix hint: first strip links and show the banner for `$phishing` in the body HTML; then add the action behind the org policy's `phishingReport` address.

- [ ] **Received mail doesn't show its classification label** — `P3` — `missing`
  - What WEB does: shows the SIO-Label / Sensitivity label of received mail that matches a label the organisation defined (`lib/classification/labels.ts:286`, `components/email/received-label-chip.tsx:8`). 912462054.
  - What RN does: no classification code; MessageHeader shows tags, flags and the via badge only (`src/components/email/MessageHeader.tsx:244-280`).
  - Fix hint: port `receivedLabel` and show a chip in MessageHeader when the org policy has labels.

- [x] **Your own sent messages say "via <identity>" in the reader** — `P3` — `bug` — fixed in d624f983
  - What WEB does: the reader no longer names the identity on a message of your own, since it read like a delegation warning; only the sub-address tag stays (`components/email/email-identity-badge.tsx:113-119`). 279a1dd59 (shallow).
  - What RN does: shows "via {name}" when the From is one of your identities and the name differs (`src/components/email/MessageHeader.tsx:146-154`, `:272-276`).
  - Fix hint: drop the `direction: 'from'` case in MessageHeader; keep the `to` case and the tag.

- [x] **The unverified-sender notice names the forwarder instead of the original sender** — `P3` — `bug` — fixed in 4c8647dc
  - What WEB does: names the sender by a passing DKIM domain first, else the MAIL FROM domain with an SRS rewrite decoded back to the original domain (`lib/email-headers.ts:98`, `:140-151`). 34a37c29b (#1542).
  - What RN does: uses the raw envelope domain, so a forwarded message says "sent from <forwarder>" (`src/lib/email-headers.ts:212-217`).
  - Fix hint: port `srsOriginalDomain` and the DKIM-first order into getSenderVerification.

- [x] **Quoted history of iPhone Mail and Outlook replies isn't folded** — `P3` — `bug` — fixed in d6e192d4
  - What WEB does: folds Outlook for Windows' header block marked only by its top rule, Outlook mobile's `#mail-editor-reference-message-container`, and iPhone Mail's run of cite blockquotes (`lib/quote-collapse.ts:39-46`, `:95`, `:184`). 3b4a0c4c8 (#1476).
  - What RN does: separators are `#divRplyFwdMsg`, `#appendonsend`, `div.moz-cite-prefix` only, and any content after the first quote stops the fold (`src/lib/quote-collapse.ts:42-50`, `:130-132`).
  - Fix hint: add the five selectors and the onlyQuotesAfter check to the injected script.

- [x] **A person's avatar letters and colour differ between places, and Han names show the surname** — `P3` — `bug` — fixed in 4059f006
  - What WEB does: one avatarInitials/avatarColor for every avatar: a name without real words falls back to the address' local part ("max.mustermann@" gives MM), the colour comes from the address so it doesn't change with the name, a signed-in account keeps its switcher colour, and an all-Han name shows the given name (王阳明 → 阳明) (`components/ui/avatar.tsx:130`, `:158`, `:183`). e2b383bd2 (#1581), dde5bbf5a.
  - What RN does: initials from the name or the address' first letter, colour hashed from the name, and account avatars use another palette keyed by address (`src/lib/avatar-utils.ts:42-50`, `:96-111`, `src/components/SenderAvatar.tsx:90-91`, `src/components/SidebarDrawer.tsx:848`). No Han rule.
  - Fix hint: port avatarInitials and avatarColor into avatar-utils; widgets and push notifications use the same helpers, so they follow.

- [x] **No BIMI logo on mail between the organisation's own domains on the same server** — `P3` — `partial` — fixed in c8f8f29a, 0c5d0f92
  - What WEB does: a message without any Authentication-Results whose From domain is one of the organisation's internal domains gets the BIMI logo (Stalwart doesn't stamp locally submitted mail) (`lib/email-headers.ts:209`, `hooks/use-brand-domain.ts`, `components/email/external-sender-chip.tsx:77`). 531358eb3.
  - What RN does: requires a DMARC pass, so internal mail gets initials (`src/lib/avatar-bimi.ts:41-49`). RN has no internal-domain list (no External sender chip; no match for internalDomains in `src/`).
  - Fix hint: needs the internal domains (identities' domains plus org policy) first; then pass them to brandIndicatorDomain. The verified check mark next to the name (4d595f775) is still the open file 11 row.

- [x] **The address sheet has no "Find mail" from that person** — `P3` — `partial` — fixed in e3d1bf43
  - What WEB does: right-click on an address offers copy, write, add to contacts and find its mail, which runs a `from:` search (`components/email/address-context-menu.tsx:84-90`, `lib/mail-search-request.ts:23`). acb827bf1.
  - What RN does: AddressActionSheet has copy, new message and view/add contact (`src/components/email/AddressActionSheet.tsx:34-73`).
  - Fix hint: add a row that opens the list with a `from:` search (the pending-mail-search route already exists, `src/navigation/pending-mail-search.ts`).

### Mail list

- [x] **Recover deleted items lists nothing on Stalwart 1.0 for a regular user** — `P2` — `bug` — fixed in f4bbdc1d
  - What WEB does: keeps archived items without `accountId`, which Stalwart 1.0 leaves out for users without Impersonate after it has already limited the list to the account asked for (`lib/recovery/archived-items.ts:151`). d70b51f09 (#1480).
  - What RN does: drops every item whose `accountId` isn't the account's, including items with none (`src/lib/recovery/archived-items.ts:128`), so the list stays empty.
  - Fix hint: one-line port: skip only when `accountId` is present and different.

- [x] **Trash has no Restore, and a mixed selection can't be marked unread** — `P3` — `missing` — fixed in aef6aea9
  - What WEB does: notes the folder a message came from when Bulwark moves it to Trash; in Trash, Restore puts it back there (or in the Inbox); a selection with read and unread mail offers both (`lib/trash-origin.ts:32`, `:70`, `components/email/email-context-menu.tsx:290`, `components/email/email-list.tsx:875-884`). e8d8486b8.
  - What RN does: no Restore in the list or reader (moves only, `src/components/MoveSheet.tsx`); the selection bar toggles to "Mark as read" whenever one row is unread (`src/screens/EmailListScreen.tsx:1381-1388`).
  - Fix hint: record the origin in the trash paths of email-store (AsyncStorage, capped), add Restore to the Trash selection bar and the reader menu.

- [ ] **Select all doesn't offer the rest of the folder** — `P3` — `partial` — not done: the selection and every batch action work on loaded rows; running them by query needs a store rework
  - What WEB does: select all ticks every loaded conversation and then offers "Select all N in this folder" (`components/email/email-list.tsx:977-1007`). 1.21.0 Mail.
  - What RN does: selects the loaded rows only (`src/screens/EmailListScreen.tsx:977-983`).
  - Fix hint: after select all, offer the folder total and run the batch actions by query.

- [x] **No setting to hide the attachment chips under list rows** — `P3` — `missing` — fixed in 3a01b64e
  - What WEB does: "Show attachments in the list" under Settings > Message list turns the chips off; the paperclip and the verification code chip stay; admins can preset or lock it (`components/email/attachment-chips.tsx`, `components/settings/message-list-settings.tsx`). c136bd816, 9c7d5ae29, efc17bda8 (#1604).
  - What RN does: chips always render when the row can open attachments (`src/screens/EmailListScreen.tsx:353-361`); no setting in `src/stores/settings-store.ts`.
  - Fix hint: a boolean in settings-store and Message list settings that skips ListAttachmentChips and its loader.

- [x] **The Move sheet has no filter and no recent folders** — `P3` — `missing` — fixed in 329468fe
  - What WEB does: Move lists recent folders first, then the folders in mail-client order, other accounts under their names, with a filter field on long lists, also from the selection bar (`components/email/move-target-list.tsx:18`, `:44`, `:106`). 56e833fe6, 1.21.0 Mail.
  - What RN does: a scrolled tree with no search and no recents (`src/components/MoveSheet.tsx:73-87`, `:113-140`).
  - Fix hint: a TextInput over the list using the same filter as the search folder tree, and a small recent-targets list in AsyncStorage.

- [x] **The unified "All Trash" can't be emptied** — `P3` — `missing` — fixed in 97265b45
  - What WEB does: the All Trash (and All Junk) row has a menu that empties that folder in every account (`components/layout/mailbox-context-menu.tsx:132`, `:285`). 648bbf536 (#1540).
  - What RN does: unified role views exist (`src/api/unified-inbox.ts:36`) but UnifiedInboxScreen only deletes selected rows (`src/screens/UnifiedInboxScreen.tsx:353-371`); Empty folder is per account (`src/components/SidebarDrawer.tsx:626-645`).
  - Fix hint: an "Empty" button in the unified Trash and Junk views that calls emptyMailbox per account after one confirm.

- [x] **"Mark folder as read" is offered with nothing unread, and folder actions fail offline** — `P3` — `bug` — fixed in 790eb40d
  - What WEB does: greys out Mark as read when the folder tree has no unread mail, and greys out actions that need the server while offline, with an "offline" header (`components/layout/mailbox-context-menu.tsx:58`, `:327`). f92b7d942.
  - What RN does: the folder sheet always lists Mark folder as read and the other actions (`src/components/SidebarDrawer.tsx:587-597`); offline they end in an error alert (`:562-573`).
  - Fix hint: hide or disable the read rows when unreadEmails is 0 over the subtree, and disable rename, create, delete and share while the network store says offline.

- [x] **The undo send bar squeezes its text with long button labels** — `P3` — `bug` — fixed in faae7363
  - What WEB does: the toast's actions wrap onto their own line when their labels don't leave the text a readable width (`components/ui/toast.tsx:291`). dc273ae94 (#1599, Russian).
  - What RN does: label (one line, flex 1) and the uppercase "SEND NOW" and "UNDO" buttons share one row (`src/components/UndoSnackbar.tsx:163-187`, `:200-220`); in Russian ("ОТПРАВИТЬ СЕЙЧАС", "ОТМЕНИТЬ") the countdown text has little room left on a phone. Read from the code, not tried on a device.
  - Fix hint: `flexWrap: 'wrap'` on the bar with the buttons in their own row, or a second line when the label gets narrower than a minimum.

- [x] **A page loaded while a new search starts can land in the new results** — `P3` — `bug` — fixed in 7d66267d
  - What WEB does: pagination, refresh and delta sync capture the list request and the search input, and drop their answer when either changed (`stores/email-store.ts:1741`, `:4360`). fa7c58ca0, c1d4edb80.
  - What RN does: loadMoreEmails checks account and folder only before appending (`src/stores/email-store.ts:1395-1396`); the spanning path also checks the query (`:1369-1372`).
  - Fix hint: compare searchQuery and filters after queryEmailPage as the spanning path does, and clear `loading` on every early return.

### Search

- [x] **No "Search in" setting for where a new search looks** — `P3` — `missing` — fixed in 2edfcfd6
  - What WEB does: Settings > Message list > Search in: all folders or only the open folder; admins can preset or lock it (`stores/settings-store.ts:737`, `lib/search-default-scope.ts`). e4338ac47, c4d9a918b (#1485).
  - What RN does: a typed search always runs over all folders except in Trash and Junk (`src/stores/email-store.ts:289-299`); the scope can be changed per search only.
  - Fix hint: a setting read in effectiveFolderScope, with the policy lock.

- [x] **Search suggestions don't include senders of the mail on screen** — `P3` — `partial` — fixed in 25e0b977
  - What WEB does: while typing, suggests contacts and the senders of the listed mail (`components/search/search-box.tsx:70-73`, `lib/search-suggestions.ts`). 4c5f3d8f2.
  - What RN does: suggests contacts only (`src/screens/EmailListScreen.tsx:1138-1154`).
  - Fix hint: add matches from `emails[].from` after the contact matches, deduplicated by address.

- [ ] **No search with no connection** — `P3` — `missing` — not done: needs the offline database, decision 14
  - What WEB does: searches the mail kept on the device offline (word starts, phrases, German compounds, umlauts) and mixes kept matches into online results (1.21.0 Offline).
  - What RN does: the offline cache keeps bodies in AsyncStorage for reading only (`src/stores/offline-cache-store.ts:1-10`); search goes to the server. May belong to the offline inventory instead.
  - Fix hint: a local filter over cached bodies when offline; full parity needs the webmail's local database.

### Folders and tags

- [x] **Accounts with more folders than the server's get limit show a cut or empty folder list** — `P2` — `bug` — fixed in f18029ca
  - What WEB does: when Mailbox/get without ids is capped (Stalwart 0.16 cuts at maxObjectsInGet, 1.0 answers requestTooLarge) it pages through Mailbox/query and gets, and retries when the state moves mid-load (`lib/jmap/client.ts:652`, `:2517`). 8ef3ad901 (#1502).
  - What RN does: one Mailbox/get without ids for the own account and each shared account (`src/api/email.ts:178-190`, `:198-224`); on 1.0 requireMethodResult throws, on 0.16 the tree misses folders.
  - Fix hint: port the capped check and the query/get paging into getMailboxesWithState and getSharedMailboxes.

- [x] **Tags named in Cyrillic or other non-Latin letters can't be saved** — `P2` — `bug` — fixed in defb045d
  - What WEB does: a name with no a-z slug gets a generated `tag-<hash>` id, as does a name whose slug is taken; duplicates are checked by name under the same parent, in settings, the tag picker and shared tags (`lib/keyword-nesting.ts:87-97`, `:117`, `:148`). d3c9eec8f (#1613).
  - What RN does: the id is the slug only, so "Работа" gives an empty id and Save stays disabled with no message, and "Банк 1" and "Счета 1" both give "1" (`src/lib/new-tag.ts:22-46`, `src/components/settings/KeywordSettings.tsx:338-341`, `src/components/NewTagRow.tsx:33`).
  - Fix hint: port generatedKeywordLevel, chooseKeywordId and isKeywordNameTaken into new-tag.ts and use them in both places. Renames already keep the id in RN (39b6f6542 needs nothing).

- [ ] **A tag made in a group account's tag picker isn't shared with the group** — `P3` — `bug` — not done: the app only reads shared tags (no write path); fba71cbd hides New tag in group accounts so it no longer makes a personal tag there
  - What WEB does: "New tag" in a group account adds the tag to the group's shared tags, and is hidden for members who can't change them (`components/email/tag-picker.tsx:57-76`). 9eae5ae9d (#1613).
  - What RN does: NewTagRow always adds to the user's own tags (`src/components/NewTagRow.tsx:24-38`), while group rows show the group's merged tags (`src/screens/EmailListScreen.tsx:605-611`).
  - Fix hint: pass the scope to NewTagRow and save through the shared tags store for a group account.

- [ ] **New accounts start with seven colour tags; admins can't set default tags** — `P3` — `bug`
  - What WEB does: new accounts start with no tags, or with the admin's `defaults.emailKeywords` (`stores/settings-store.ts` DEFAULT_SETTINGS, `lib/admin/policy-defaults.ts:31-40`). 3163864b1 (#1612).
  - What RN does: DEFAULT_KEYWORDS (Red, Orange, ...) for every new account and on reset (`src/stores/keywords-store.ts:35`, `:117`, `:211`).
  - Fix hint: start empty, take the policy default when there is one.

- [ ] **Tag colours are limited to the palette** — `P3` — `missing` — not done: needs a hex KeywordColor in keywords-store (not this agent's file) and every tag renderer
  - What WEB does: a tag takes any colour from a hex code or the colour dialog (`lib/tag-hex-color.ts:14`, `:74`). 4cb4ccf1c.
  - What RN does: KeywordColor is a palette name (`src/stores/keywords-store.ts:11`); a hex tag colour synced from the webmail falls back. Not checked how RN draws an unknown colour.
  - Fix hint: accept `#rrggbb` in KeywordColor and add a hex field to the tag form.

- [x] **Shared mailboxes can't be shown compact in the drawer** — `P3` — `missing` — fixed in acab8b21
  - What WEB does: "compact shared mailboxes" folds a shared account with one Inbox into a single row (`lib/compact-shared-mailbox.ts:18`, `stores/settings-store.ts:936`). fca08981a (1.20.0, #1483).
  - What RN does: shared accounts always show as a header with their folders (`src/components/SidebarDrawer.tsx:1235-1248`).
  - Fix hint: optional; port compactSharedMailbox behind a setting.

### Attachments

- [x] **Exchange's second copy of an inline image shows as an attachment chip** — `P3` — `bug` — fixed in 15338268
  - What WEB does: hides an `attachment`-disposition image whose Content-ID the body references when another part with the same Content-ID, type and size is already hidden as embedded (`lib/attachment-visibility.ts:106`, `:134-149`). c8900fe06 (#1614).
  - What RN does: an explicit `attachment` disposition always keeps its chip (`src/lib/attachment-display.ts:107-117`).
  - Fix hint: port the twin check and pass the message's attachment list into isEmbeddedInBody.

- [x] **Shown as plain text, a message's inline images are nowhere** — `P3` — `bug` — fixed in 15338268
  - What WEB does: when an HTML message is read as plain text, inline images are listed as attachments, since the body no longer shows them (`lib/attachment-visibility.ts:101-112`, `components/email/email-viewer.tsx:3030`). e49de8a04, 51327019e (#1614).
  - What RN does: AttachmentChips still hides parts the HTML references, and isn't told about the plain view (`src/components/email/AttachmentChips.tsx:80`, `src/components/email/MessageContent.tsx:94-102`, `:157`).
  - Fix hint: pass `plainView` (and the plain-text setting) to AttachmentChips and skip the embedded filter then.

- [x] **An attachment can't be renamed when saving a copy** — `P3` — `missing` — fixed in 0ebc5bae
  - What WEB does: a Rename button on each reader attachment opens a dialog that keeps the extension, and the copy saves under the new name; the composer can rename before sending (`components/email/reader-attachments.tsx`, `components/email/rename-attachment-dialog.tsx:21`, `lib/attachment-name.ts:55`). fc54c1915, 8093ccb7a, 2c21722ae (#1623).
  - What RN does: Save and Share hand the file to the share sheet under its generated name (`src/lib/email-export.ts:278-304`). Not checked whether the Android save target lets the user change the name.
  - Fix hint: a "Save as…" entry in the attachment sheet with a name prompt before downloadAttachment. The composer side belongs to the compose inventory.

### Import and export

- [x] **An .eml imported into Drafts isn't an editable draft** — `P3` — `bug` — fixed in 85df1bb2
  - What WEB does: imports into Drafts with `$draft` and `$seen`, so the message opens in the composer (`lib/file-drop/import-keywords.ts`). 34ac66abf (#1535).
  - What RN does: imports with `$seen` only (`src/api/email.ts:1082-1093`, `src/stores/email-store.ts:1448`).
  - Fix hint: pass `{ $seen: true, $draft: true }` when the target folder's role is drafts.

- [ ] **No mbox or PST import, and no folder or account export** — `P3` — `missing` — not done: large feature, decision 14
  - What WEB does: imports mbox, Outlook PST/OST, EML and ZIP with folders, dates and read/flag state, pausing and resuming; exports a folder or the account as mbox or an EML ZIP, also the mail kept offline (`lib/mail-import/engine.ts`, `lib/mail-import/mbox.ts`, `lib/mail-export/engine.ts`). d714957f9, a06281f23, 15f0bd198, 3cda05a1f.
  - What RN does: imports .eml and .zip of .eml into the open folder (`src/lib/eml-import.ts:1-40`, `src/screens/EmailListScreen.tsx:705-753`); exports one message (`src/lib/email-export.ts`).
  - Fix hint: mbox import and folder export as mbox through the share sheet are the parts that fit a phone; PST can stay webmail-only.

### Compose and send

- [x] **A template placeholder with a default, `{{name:default}}`, is neither filled nor caught by the send check** — `P2` — `bug` — fixed in 17c9046e
  - What WEB does: placeholders can carry a default; the fill dialog starts the field with it, and the send check flags an unfilled one, also with an address in angle brackets (`lib/template-utils.ts:10-11`, `:88`, `lib/placeholder-check.ts:8`, `components/templates/placeholder-fill-modal.tsx`). ea7e2eedf, 6866201e2 (#1609).
  - What RN does: the regexes only know `{{name}}` (`src/lib/template-utils.ts:19`, `src/lib/placeholder-check.ts:11`). Templates are shared with the webmail through account metadata (`src/stores/templates-store.ts:7-16`), so a webmail template with `{{checkin_time:15:00}}` inserted in the app gets no fill prompt (`src/screens/ComposeScreen.tsx:2399`) and the placeholder warning doesn't fire, so it goes out with the braces.
  - Fix hint: port both regexes and getPlaceholderDefaults; prefill the fill sheet with the default.

- [ ] **No classification labels in the composer; mail goes out unlabelled where the organisation requires one** — `P2` — `missing`
  - What WEB does: admins define labels in the organisation policy; the composer has a label picker, sent mail carries SIO-Label, Sensitivity and a subject prefix, and a required label stops the send (`lib/outgoing/classification.ts:1-30`, `components/email/classification-label-picker.tsx`, `lib/classification/labels.ts:315`). Changelog 1.20.0 (Security: Classification labels).
  - What RN does: nothing; no label code in src. The app already reads the policy and keeps its `organisation` block (`src/lib/org-policy.ts:57`), which is where the labels live (`OrganisationPolicy['labels']`, `lib/classification/labels.ts:27`).
  - Fix hint: port lib/classification/labels.ts, add a label row to the composer options, apply headers and prefix in the send path, and refuse to send when a label is required and none is picked.

- [x] **No Tags menu in the composer** — `P3` — `missing` — fixed in 49762298
  - What WEB does: a Tags menu next to Options; replies and forwards start with the original's tags, a group account offers its shared tags, drafts keep them and the sent copy carries them (`components/email/email-composer.tsx:1359`, `lib/jmap/client.ts:5411`, `lib/draft-composer-data.ts`). 5354d6066, 54e4a03a3 (#1610).
  - What RN does: drafts are created with `$seen` and `$draft` only (`src/api/email.ts:2049`); the composer has no tag state.
  - Fix hint: reuse TagSheet in the composer options and pass the keywords to the draft and the send.

- [x] **Undo send is off by default and has no 5-second choice** — `P3` — `partial` — fixed in 6ed687aa
  - What WEB does: on by default with 5 s; choices 0, 5, 10, 30, 60 (`stores/settings-store.ts:492`, `:1144`). Changelog 1.21.0 (Compose: Undo send is on by default).
  - What RN does: default 0 and choices 0, 10, 30, 60 (`src/stores/settings-store.ts:442`, `:678`); an imported webmail settings file with 5 falls back to 0. The countdown itself is there (`src/stores/send-undo-store.ts:92`).
  - Fix hint: add 5 and make it the default for new installs.

- [x] **Closing the composer has no "Draft saved" notice with Open and Discard** — `P3` — `partial` — fixed in bc54de1c
  - What WEB does: closing keeps the draft and shows "Draft saved · Open · Discard"; Discard has its own Undo (`lib/compose/draft-close-toast.ts:58`). 656073804, changelog 1.21.0.
  - What RN does: with unsaved changes it asks Save or Discard (`src/screens/ComposeScreen.tsx:1859-1867`); with everything saved it closes without a word (`:1894-1907`), so there is no quick way back to the draft or to drop it.
  - Fix hint: after a close that kept a draft, show a toast with Open (navigate to Compose with the draft) and Discard.

- [x] **Reply starts a second draft when a reply to that message is already saved** — `P3` — `missing` — fixed in 7e61fa9e
  - What WEB does: finds the newest draft whose In-Reply-To names the message and opens it again on Reply (`lib/reply-drafts.ts:18`, `:33`). Changelog 1.21.0 (Mail: Reply picks up a reply you already started).
  - What RN does: Reply always builds a new composer from the message (`src/screens/EmailThreadScreen.tsx:620-625`).
  - Fix hint: look for a `$draft` in the thread whose inReplyTo matches the message's Message-ID and open that draft instead.

- [x] **A forwarded message's header doesn't list To and Cc** — `P3` — `missing` — fixed in 729bde85
  - What WEB does: the forward header has From, Date, Subject, To and Cc (`lib/quote-header.ts:24-25`, `:50-51`). Changelog 1.21.0.
  - What RN does: From, Date and Subject only (`src/lib/quote-header.ts:107-110`).
  - Fix hint: add the two lines and their labels.

- [x] **Replies don't come from the address the mail was delivered to** — `P3` — `missing` — fixed in 891d9e74
  - What WEB does: when To, Cc and Bcc match no identity, it picks the identity from Delivered-To, X-Original-To and the like (`lib/reply-identity.ts:27`, `:48-55`). Changelog 1.20.0 (#1353).
  - What RN does: matches To, Cc and Bcc only (`src/lib/reply-identity.ts:52`); no delivery headers are read anywhere in src.
  - Fix hint: port the DELIVERY_HEADERS step and fetch those headers with the reply source.

- [x] **Pictures in an HTML template go out as data: URIs that Gmail and Outlook don't show** — `P3` — `bug` — fixed in 3226f868
  - What WEB does: uploads each data: image of a template and sends it as an inline cid: part (`lib/template-utils.ts:191`, used at `components/email/email-composer.tsx:2667`). Changelog 1.20.0 (#1492).
  - What RN does: inserts an HTML template as it is (`src/lib/template-utils.ts:209-210`); the send path turns only `data-cid` images into parts (`src/lib/compose-html.ts:298-316`), so a template's `<img src="data:...">` stays in the HTML.
  - Fix hint: on template insert, upload each data: image like insertInlineImages does (`src/screens/ComposeScreen.tsx:2199`) and tag it with its cid.

- [x] **No switches to leave the signature out of new mail or out of replies** — `P3` — `missing` — fixed in 570efabf
  - What WEB does: "Insert signature in new mail" and "in replies, forwards and quick replies", both on by default (`stores/settings-store.ts:781-782`, `components/email/email-composer.tsx:771-777`). Changelog 1.20.0 (#1493).
  - What RN does: always inserts the identity's signature (`src/screens/ComposeScreen.tsx:1386`); no such settings (`src/stores/settings-store.ts`).
  - Fix hint: two settings on the Composing page and a check before placing the signature.

- [x] **A message can't be saved as a template from the composer** — `P3` — `missing` — fixed in 0fda58fd
  - What WEB does: saves the open message as a template with just a name, HTML kept as HTML (`components/templates/quick-save-template-dialog.tsx`, `components/email/email-composer.tsx:6696`). Changelog 1.21.0 and 1.20.0 (#1506).
  - What RN does: templates are made only in Settings (`src/components/settings/TemplateSettings.tsx:33`, `:106`); the composer only inserts them.
  - Fix hint: a "Save as template" entry in the composer options that asks for a name and calls addTemplate.

- [x] **No picker to tick recipients from the contacts or the directory** — `P3` — `missing` — fixed in 26aaa502
  - What WEB does: a recipient picker lists the user's contacts with the directory on its own tab (`components/contacts/directory-picker-dialog.tsx:6`, `components/email/email-composer.tsx:6680`). Changelog 1.21.0.
  - What RN does: only suggestions while typing; RecipientPicker is the same suggestion list full screen (`src/components/compose/RecipientPicker.tsx:14-19`).
  - Fix hint: a sheet with Contacts and Directory tabs and check boxes, reusing ContactPickerSheet and DirectoryBrowser.

- [x] **Insert link asks only for the address** — `P3` — `partial` — fixed in 7fee8823
  - What WEB does: asks for the text and the address (`components/email/link-dialog.tsx`). Changelog 1.21.0.
  - What RN does: one field for the URL; without a selection the link text is the URL (`src/screens/ComposeScreen.tsx:2310-2321`, `src/lib/editor-html.ts:548-575`). The editor bridge already takes a label (`src/components/RichTextEditor.tsx:209`).
  - Fix hint: add a text field to the link prompt and pass it as the label.

- [x] **Send warnings come as several questions in a row** — `P3` — `partial` — fixed in c68f0eed
  - What WEB does: one question before sending lists everything that's missing (`components/email/send-warnings-dialog.tsx`). Changelog 1.21.0.
  - What RN does: empty subject, placeholders, attachment and confirm each open their own Alert (`src/screens/ComposeScreen.tsx:2498`, `:2542`, `:2570`, `:2728-2729`).
  - Fix hint: collect the findings first and show one sheet with "Send anyway".

- [x] **The HTML signature is edited as raw HTML code** — `P3` — `partial` — fixed in aa9b1876
  - What WEB does: signatures use the composer's rich editor and can be edited per address on the Composing page (`components/settings/signatures-section.tsx`). Changelog 1.21.0 (Settings).
  - What RN does: a monospace TextInput for HTML (`src/components/settings/IdentitySettings.tsx:403-412`).
  - Fix hint: reuse RichTextEditor for the signature field.

### Calendar

- [x] **An HTML event description shows its markup, and editing keeps it marked as HTML** — `P2` — `bug` — fixed in 227974f6
  - What WEB does: shows an HTML description as text, saves an edit as plain text, and duplicating keeps the format (`lib/calendar-description.ts:11`, `:35`). Changelog 1.20.0.
  - What RN does: shows `event.description` as text with the tags in it (`src/components/calendar/EventDetailSheet.tsx:363-366`); the editor loads it raw (`src/components/calendar/EventModal.tsx:299`) and saves `description` without touching `descriptionContentType` (`:412`). Device sync already converts (`src/device-sync/calendar/image.ts:66`).
  - Fix hint: port lib/calendar-description.ts: htmlToPlainText for display and editing, and send `descriptionContentType: 'text/plain'` with an edited description.

- [ ] **No "Suggest times" in the event editor** — `P3` — `missing` — not done: decision 14
  - What WEB does: finds the next slots free for every attendee whose calendar can be checked, and says who couldn't be checked (`components/calendar/find-a-time.tsx`). Changelog 1.20.0 (#1164).
  - What RN does: shows invitees' free/busy (`src/components/calendar/ParticipantAvailability.tsx`) but suggests no slot.
  - Fix hint: port the slot search on top of src/lib/calendar-free-busy.ts.

- [x] **Unanswered invitations aren't marked in the grid** — `P3` — `missing` — fixed in d8985c11
  - What WEB does: a "?" / "Reply" marker on unanswered invitations in month, week, day and agenda that opens the answers (`components/calendar/calendar-month-view.tsx:42`, `components/calendar/calendar-app.tsx:979`, `:1986`). Changelog 1.21.0.
  - What RN does: only declined and cancelled events are drawn differently (`src/lib/calendar-participants.ts:148-153`); RSVP is in the detail sheet only (`src/components/calendar/EventDetailSheet.tsx:232`).
  - Fix hint: a needs-action marker on event chips; tapping opens the detail sheet at the RSVP row.

- [ ] **No time zone picker for an event** — `P3` — `partial` — not done: the editor edits wall clocks in the calendar zone (src/lib/event-editor-times.ts); a zone of its own per event changes that time model and its save path, a larger change
  - What WEB does: events keep their own time zone, picked by city in the editor (`components/calendar/event-modal.tsx:24`, `:1456`). Changelog 1.21.0.
  - What RN does: keeps an event's zone when its times are untouched, but edits wall clock in the calendar zone and offers no zone choice (`src/lib/event-editor-times.ts:18-24`, `src/components/calendar/EventModal.tsx:45`).
  - Fix hint: a zone row in the editor using the zone list behind the calendar time zone setting.

- [ ] **The calendar shows only the active sign-in's calendars** — `P3` — `missing` — not done: needs per-login clients in the calendar store, a larger change
  - What WEB does: every signed-in account's calendars and tasks show together (`stores/calendar-store.ts:609`, `stores/task-store.ts`). Changelog 1.21.0; the 1.21.1 fix for an account added second (#1618) belongs to this.
  - What RN does: the store holds one login and resets on a switch (`src/stores/calendar-store.ts:313-357`).
  - Fix hint: needs per-login clients in the calendar store; a larger change.

- [ ] **An invitation in a calendar shared with the user can't be answered as its owner** — `P3` — `missing` — not done: needs calendar-delegate ported and the answer target in CalendarInvitationBanner (src/components/email, outside this agent's files), a larger change
  - What WEB does: answers as the owner with SENT-BY naming the user; group calendars answer as the group (`lib/calendar-delegate.ts`, `stores/calendar-store.ts:333`). Changelog 1.20.0 (#634).
  - What RN does: the banner imports only into the user's own calendars (`src/components/email/CalendarInvitationBanner.tsx:166-171`); no SENT-BY handling outside recurrence copying (`src/lib/recurrence-instances.ts:423`).
  - Fix hint: port calendar-delegate and offer the shared owner's calendar as an answer target.

- [ ] **Invitations from another of the organisation's domains warn about missing authentication** — `P3` — `bug` — not done: the policy's internal domains are dropped by sanitizePolicy in src/lib/org-policy.ts, which this wave may not edit; goes with the External sender chip
  - What WEB does: treats mail without Authentication-Results from the domains the External sender chip counts as internal (identity domains plus the policy's list) as internal (`lib/calendar-invitation.ts`, `lib/external-mail.ts:61`). 400dfb9c6 (#1593).
  - What RN does: only the domains of the user's own addresses count (`src/lib/calendar-invitation.ts:528-543`); the policy's internal domains aren't read.
  - Fix hint: read the internal domains from the organisation policy (the same list the External sender chip needs) and pass them in.

- [x] **The default calendar and address book show as "Stalwart Calendar (address)"** — `P3` — `bug` — fixed in 0460bb80
  - What WEB does: shows Stalwart's default collection names as plain "Calendar" and "Contacts", and a colleague's as "Calendar (bob@...)" (`lib/default-collection-name.ts`). e403478a0.
  - What RN does: shows the server name (`src/components/calendar/CalendarSidebarDrawer.tsx:364`, `src/components/contacts/ContactsSidebarDrawer.tsx:185`); `src/lib/address-book-label.ts:1-20` only avoids doubling the address.
  - Fix hint: port collectionLabel and use it in the drawers, pickers and settings.

- [x] **No choice how timed events look in the month view** — `P3` — `missing` — fixed in e3ad5339
  - What WEB does: bar, coloured text, or dot and text (`stores/settings-store.ts:485-486`, `:804`). Changelog 1.20.0 (#1449).
  - What RN does: always a filled chip (`src/components/calendar/MonthView.tsx:374-399`).
  - Fix hint: a setting in Calendar settings and two more chip styles.

- [ ] **No company calendars and no one-step free/busy share with a group** — `P3` — `missing` — not done: decision 14
  - What WEB does: read-only company calendars the admin lists under "Organisation" (`lib/company-calendars.ts`), and sharing free/busy with a group in one click, or by admin at sign-in (`lib/free-busy-share.ts`, `components/settings/free-busy-share-setting.tsx`). Changelog 1.20.0.
  - What RN does: free/busy is a per-calendar share preset (`src/components/calendar/CalendarShareSheet.tsx:6-23`); no company calendars.
  - Fix hint: both come from the organisation policy the app already reads (`src/lib/org-policy.ts`).

- [x] **Many calendar notifications at once come as a stack of separate toasts** — `P3` — `bug` — fixed in 0ff300c6
  - What WEB does: pages through them and shows many as one toast; share toasts name the collection. Changelog 1.21.0 (#1567, #1552).
  - What RN does: one toast per notification in a loop (`src/lib/calendar-event-notifications.ts:110-115`).
  - Fix hint: above two or three, one summary toast that opens the calendar.

### Tasks

- [x] **A repeating task shows only once in the calendar, and checking it off completes the whole series** — `P2` — `bug` — fixed in 7dbf2908
  - What WEB does: expands repeating tasks in month, week and day, honours overrides, ticks one occurrence through recurrenceOverrides, and moves a series to its next due (or start) date when it is checked off; reads Stalwart's singular `recurrenceRule` for tasks (`lib/calendar-tasks.ts:51`, `:60`, `:126`, `stores/task-store.ts:249`). 7ee54fa10, dbdf9efed, 4049ad2a8, 57f294f01 (#1621).
  - What RN does: task chips drop the rules (`src/screens/CalendarScreen.tsx:344-366`, `recurrenceRules: undefined` at `:362`), and the tick sets `progress: completed` on the task itself (`src/stores/calendar-store.ts:1588-1605`), so a weekly task is gone for good after one tick. RN's getEvents already normalises recurrenceRule (`src/api/calendar.ts:989`).
  - Fix hint: port the occurrence expansion and the toggle logic from task-store, keeping RN's own `originalId` for shared tasks (the web's later seriesId fix).

- [x] **Task lists can't be ticked on and off in the calendar drawer** — `P3` — `partial` — fixed in 200f07a0
  - What WEB does: task-only lists show below the calendars in month, week and day with the same tick as in Tasks, and their tasks show on the grid accordingly; the agenda's sidebar leaves them out (`components/calendar/calendar-sidebar-panel.tsx`, `lib/calendar-tasks.ts:16`). c476b5839, 903969a5a (#1589).
  - What RN does: hides task lists from the drawer (`src/screens/CalendarScreen.tsx:375-384`) and shows every task with a due date on the grid regardless of list (`:344-348`).
  - Fix hint: list task lists in CalendarSidebarDrawer and filter taskEvents by hidden ids.

- [ ] **Empty task lists, and task lists made in iOS, Thunderbird or DAVx5, count as event calendars; the app can't make a task list** — `P3` — `partial` — not done: needs a CalDAV PROPFIND/MKCALENDAR client for the component set, which the app does not have yet
  - What WEB does: reads `supported-calendar-component-set` over CalDAV once per account, and remembers a calendar made for tasks while it is still empty (`lib/webdav/calendar-collection.ts:5`, `:94`, `lib/calendar-targets.ts`). ae1c1bef7 (#1605), 91f211723 (#1595).
  - What RN does: decides only from the objects a calendar holds (`src/lib/calendar-component-detection.ts:1-10`), so an empty list is an event calendar; the calendar editor has no kind choice (`src/components/calendar/CalendarEditSheet.tsx`). File 10 left the component set for lack of a CalDAV client.
  - Fix hint: a PROPFIND against Stalwart's DAV endpoint for the component set; a "Tasks" kind on create.

- [x] **Tasks are off by default** — `P3` — `partial` — fixed in ffa3a3c8
  - What WEB does: tasks in task lists show and are on by default (`stores/settings-store.ts:1184-1185`). Changelog 1.21.0.
  - What RN does: `enableCalendarTasks: false` (`src/stores/settings-store.ts:493`). The 2026-09 audit listed the default as an open question.
  - Fix hint: turn it on for new installs once the task rows above are in.

### Contacts

- [x] **Saving a contact drops details the editor doesn't show** — `P1` — `bug` — fixed in 245825fc
  - What WEB does: an entry the user didn't touch goes back exactly as the card had it, under its key; an edited one is built on the card's entry, so properties the form doesn't show stay; a phone's custom type such as "car" shows and is kept (`components/contacts/contact-form.tsx:174-213`). Changelog 1.21.0 (Saving no longer rewrites fields you didn't touch), 1.21.0 (#1515).
  - What RN does: rebuilds every list from the form under new keys `e1`, `p1`, `a1`... with only the fields the form has (`src/lib/contact-form.ts:281-310`). The form keeps one context and one phone feature per entry (`:135-150`), so a save loses phone and email labels, `pref`, extra contexts and features, and address parts other than street, locality, region, postcode and country, on every entry, also the untouched ones.
  - Fix hint: keep the original entry and key per row and only rebuild rows the user changed, as entriesToSave does.

- [x] **Contacts in a read-only address book offer Edit, Move and Delete** — `P3` — `bug` — fixed in a60ada1f
  - What WEB does: leaves them out of the detail, list and context menu (`components/contacts/contact-detail.tsx`, `contact-context-menu.tsx`). 8dfaa3960.
  - What RN does: the Edit button and the Move and Delete entries are always there (`src/screens/ContactDetailScreen.tsx:354-370`, `:393`); only the form's address book list checks `mayWrite` (`src/screens/ContactFormScreen.tsx:514`). The server refuses the change afterwards.
  - Fix hint: hide them when the contact's address book has `myRights.mayWrite === false`.

- [x] **Related contacts show as an id** — `P3` — `bug` — fixed in 7fa42606
  - What WEB does: looks up the related card by uid and shows its name, which opens it (`lib/contact-related.ts:17`). 83c6e5eef (#1578).
  - What RN does: prints the `relatedTo` key, a uid (`src/screens/ContactDetailScreen.tsx:680-688`).
  - Fix hint: port findRelatedContact and push ContactDetail on tap.

- [x] **Contact event times are always 24-hour, and birthdays use English month names** — `P3` — `bug` — fixed in 010c0968 (the app has no date order setting)
  - What WEB does: contact activity follows the 12/24-hour setting; birthdays and anniversaries use the UI language and the date order setting (`lib/contact-dates.ts:8`). f73bd8837, 91e80b92d (#1616).
  - What RN does: `format(..., 'HH:mm')` (`src/components/contacts/ContactActivity.tsx:83`); partial dates use a fixed English month list (`src/lib/contact-utils.ts:259-277`).
  - Fix hint: use timePattern(timeFormat) and Intl.DateTimeFormat with the app locale.

- [ ] **No CSV import** — `P3` — `missing` — not done: decision 14
  - What WEB does: imports CSV from Outlook and Google with a column-matching step (`lib/contacts/csv-import.ts`, `components/contacts/contact-import-dialog.tsx:11`). Changelog 1.21.0.
  - What RN does: vCard only (`src/components/contacts/ContactImportSheet.tsx:140`, `:261-262`).
  - Fix hint: port csv-import.ts (pure) and add a column-matching step.

- [ ] **No merging of duplicate contacts** — `P3` — `missing` — not done: decision 14
  - What WEB does: merge duplicates with Undo (`lib/contacts/merge.ts`, `components/contacts/contact-merge-dialog.tsx`). Changelog 1.21.0.
  - What RN does: detects duplicates only on import (`src/components/contacts/ContactImportSheet.tsx:9`).
  - Fix hint: port merge.ts and offer Merge for two or more ticked contacts.

- [x] **Ticked contacts can't be written to or added to a group** — `P3` — `partial` — fixed in cc577c93
  - What WEB does: acts on all ticked contacts, Send email included. Changelog 1.21.0.
  - What RN does: Export, Move, Add tag and Delete (`src/screens/ContactsScreen.tsx:446`, `:456`, `:466`, `:475`).
  - Fix hint: a "Send email" action that opens Compose with the addresses, and "Add to group".

- [ ] **The directory can't be turned off, and the admin's same-domain rule isn't applied** — `P3` — `missing` — partly in e3446c72 (the directory can be turned off); not done: the same-domain rule, sanitizePolicy in src/lib/org-policy.ts drops directorySameDomainOnly and directoryHiddenLocalparts and may not be edited in this wave
  - What WEB does: users and admins can turn the directory off (#1457, changelog 1.20.0); the policy can limit every account list (directory, suggestions, sharing, delegation, free/busy) to the user's own domains and hide names such as noreply (`lib/directory-scope.ts`). a236eb555.
  - What RN does: handles a server refusal (`src/lib/contact-directory.ts:20`) but has no setting and reads no directory rule from the policy (`src/lib/org-policy.ts`).
  - Fix hint: a Contacts setting, and apply `directorySameDomainOnly` from the public policy in principal-directory.

### Files

- [x] **Search finds files in the Files trash** — `P3` — `bug` — fixed in 1d7304fc
  - What WEB does: leaves the `.Trash` subtree out of search hits (`lib/global-search/providers/files.ts:97-101`). Changelog 1.20.0.
  - What RN does: filterNodes skips only discoverable-only nodes and symlinks (`src/api/global-search.ts:469-485`).
  - Fix hint: drop nodes under findTrashFolder (`src/lib/files-trash.ts`).

- [x] **Uploading a name that exists always keeps both** — `P3` — `partial` — fixed in 97cf79f0
  - What WEB does: asks Replace, Keep both or Skip (`components/files/upload-conflict-dialog.tsx`). Changelog 1.21.0.
  - What RN does: numbers the new file " (1)" without asking (`src/api/files.ts:687`, `src/screens/FilesScreen.tsx:826-833`).
  - Fix hint: ask before the batch when a name exists; Replace can go through the trash as a delete does.

- [x] **An attached message without a file name is titled by that name, not its subject** — `P3` — `bug` — fixed in 17ce8106 (the header; the share and download name come from use-file-preview.ts, not changed)
  - What WEB does: calls an unnamed message part ("attachment", "Email.eml") by its subject and saves it under it (`components/files/file-preview-modal.tsx:60`, `:388`). 4f00deffe.
  - What RN does: the preview header shows `item.name` (`src/components/email/AttachmentPreviewModal.tsx:397`); the subject is only used for the body view (`:219`).
  - Fix hint: use the parsed subject in the header and as the share/download name for unnamed message parts.

### Filters and vacation

- [x] **A webmail rule with a regular expression stops the app from saving filters, or changes a body rule** — `P2` — `bug` — fixed in 1ff9421e
  - What WEB does: conditions can use Sieve `:regex` on headers and the body (`lib/jmap/sieve-types.ts:29-31`, `lib/sieve/regex.ts`). Changelog 1.20.0 (#885).
  - What RN does: accepts the rule from the metadata without checking the comparator (`src/lib/sieve/parser.ts:51-59`); on the next save of any rule the generator throws for a header condition (`src/lib/sieve/generator.ts:158-162`) and writes a body condition as `body :contains` (`:93-95`), which matches the pattern as plain text. The rule editor offers no regex (`src/lib/sieve/types.ts:29-33`). Read from the code, not tried on a server.
  - Fix hint: support `regex` in types, generator, parser and FilterRuleModal (with the `regex` require), or at least keep such rules read-only and write them back verbatim.

- [x] **A new rule can't be run on the Inbox's existing mail** — `P3` — `missing` — fixed in 0a3d1b66
  - What WEB does: the rule editor offers "Also apply to existing messages" with a count (`components/filters/filter-rule-modal.tsx:42-48`, `:346-377`, `components/settings/filter-settings.tsx:405-424`). bc955be10 (root commit; changelog 1.21.0).
  - What RN does: onSave takes only the rule (`src/components/filters/FilterRuleModal.tsx:86`, `:285`).
  - Fix hint: query the Inbox with the rule's conditions as an Email/query filter and apply the move or keyword actions in batch.

- [x] **Out of office can be switched on with an empty message** — `P3` — `bug` — fixed in cd93d10d
  - What WEB does: starts a blank reply with real text in the user's language, and an empty message never goes live (`components/settings/vacation-settings.tsx:249-255`, `:380-384`). Changelog 1.21.0; 2094cca38 removed the sample-text placeholder.
  - What RN does: only warns (`src/components/settings/VacationSettings.tsx:147`, `:175`); Save stays enabled (`:189-190`). The sample text is a placeholder in italics (`:397`, `:618`).
  - Fix hint: prefill an empty reply with the translated default and block Save while on with an empty body.

- [x] **The mail drawer doesn't say out of office is on** — `P3` — `missing` — fixed in aaf76949
  - What WEB does: a banner in the sidebar while it is on, which opens the settings and has "Turn off" (`components/layout/sidebar.tsx:1356-1406`). Changelog 1.21.0.
  - What RN does: SidebarDrawer has no vacation state; only Settings shows it.
  - Fix hint: a row at the top of the drawer from useVacationStore with a Turn off button.

- [ ] **Out of office has no "Block my calendar" and no organisation templates** — `P3` — `missing` — partly in e19398ea (Block my calendar); not done: the organisation templates, left for a later agent
  - What WEB does: a reply with dates puts a busy event in the calendar, on by default, lockable by the admin (`components/settings/vacation-calendar-block.tsx`); admins keep a template library that fills in name, dates and deputy (`components/settings/vacation-template-picker.tsx`); the date fields use the app's time zone. Changelog 1.20.0.
  - What RN does: none of these (`src/components/settings/VacationSettings.tsx`); dates are read in the device zone (`src/lib/vacation-dates.ts:1-16`).
  - Fix hint: the calendar block first; the templates come from the organisation policy.

### Auth and accounts

- [x] **No masked addresses under Settings > Security** — `P2` — `missing` — fixed in 19bae844
  - What WEB does: lists masked addresses on servers that offer them (Stalwart Enterprise, Inbuxa) through `x:MaskedEmail/query|get|set`; create (description optional), copy, describe, turn off, delete. Hidden on Stalwart Community instead of "not allowed" (`lib/stalwart/masked-email.ts:34-52`, `:109`, `:170`, `components/settings/masked-addresses-section.tsx:85`). 31de1649e, e88c259d6, a6fad9230 (#1641), ebc1a439b (#1624); changelog 1.21.1 (#1534).
  - What RN does: nothing; no MaskedEmail code in src. Account security only speaks `urn:stalwart:jmap` (`src/api/account-security.ts:13`).
  - Fix hint: port masked-email.ts onto the existing account-security request path and add a section to AccountSecuritySettings, shown only when the list call succeeds.

- [x] **Account security doesn't work on Inbuxa servers** — `P3` — `partial` — fixed in c4067311
  - What WEB does: picks the management capability per account, `urn:stalwart:jmap` or `urn:inbuxa:jmap:registry` (`lib/stalwart/management-capability.ts:3-13`, `lib/stalwart/jmap-passthrough.ts`). 764aecca0 (#1522).
  - What RN does: hard-codes `urn:stalwart:jmap` (`src/api/account-security.ts:13`, `:76`).
  - Fix hint: port getManagementCapability and pass the chosen capability into `using`; do it together with masked addresses, which use the same switch.

- [x] **No server settings for other mail apps (IMAP, SMTP, CalDAV, CardDAV)** — `P3` — `missing` — fixed in 31ea3a75
  - What WEB does: Settings > Security lists the IMAP/SMTP hosts, ports and security, and the CalDAV/CardDAV addresses, read from the server's Mozilla autoconfig, with the account address as username (`lib/mail-client-config.ts:1-40`, `components/settings/mail-apps-setup.tsx:58`, `components/settings/account-security-settings.tsx:1529`). e0f19bc6f, b44ad1503 (#1633).
  - What RN does: nothing; no autoconfig or IMAP/SMTP settings in src.
  - Fix hint: fetch `/.well-known/autoconfig/mail/config-v1.1.xml?emailaddress=` from the account's server and show copyable rows under Security, next to app passwords. Substitute the address for `%EMAILADDRESS%`.

- [x] **No link to the mail server's account page** — `P3` — `missing` — fixed in da0f091c (absolute http(s) URLs only; a path relative to the webmail is not resolved)
  - What WEB does: `ACCOUNT_MANAGEMENT_URL` and `ACCOUNT_MANAGEMENT_LABEL` from `/api/config` add a link under Settings > Account (`app/api/config/route.ts`, `components/settings/account-settings.tsx:51`, `:173`). 8689f0661 (#1570).
  - What RN does: reads only the help links, company name and no-third-party flag from the paired webmail's `/api/config` (`src/lib/org-policy.ts:475-525`); Settings > Account shows the auth method without a link (`src/components/settings/AccountSettings.tsx:131-136`).
  - Fix hint: add accountManagementUrl and accountManagementLabel to webmailLinksFromConfig and show the link under the auth method.

- [x] **The account switcher shows no unread count per account** — `P3` — `missing` — fixed in d1a26ab3 (the count only; the host still shows on every row)
  - What WEB does: each switcher row shows name, address and the Inbox's unread count; the server host only shows for an account in trouble or a shared address (`components/layout/account-switcher.tsx:16`, `:58`, `:286`). 2a726c0f4.
  - What RN does: rows show name, subtitle and host, no unread count (`src/components/SidebarDrawer.tsx:925-1017`).
  - Fix hint: read the other accounts' Inbox unread from the unified inbox data the app already loads and show a badge per row.

- [x] **Shared accounts can't be reordered in the folder list** — `P3` — `missing` — fixed in 3a5ed109 (stored on the phone per login, not in the synced settings)
  - What WEB does: an order for the shared accounts, saved per login in the settings, set by dragging or from the shared account's menu (`lib/shared-mail-order.ts`, `components/layout/mailbox-context-menu.tsx`, `components/settings/layout-settings.tsx`). 2b3b672b7, 7ac6606f6.
  - What RN does: shared accounts show in session order; the shared account sheet offers mark-read only (`src/components/SidebarDrawer.tsx:730-739`). No order setting in `src/stores/settings-store.ts`.
  - Fix hint: port shared-mail-order.ts and add Move up/Move down to the shared account sheet. Dragging is n/a on the phone.

- [x] **A Gmail, Outlook.com or iCloud address at sign-in gets no plain explanation** — `P3` — `missing` — fixed in 94a0db80
  - What WEB does: the email-first sign-in names the provider ("Gmail", "Outlook.com", "iCloud Mail") and says Bulwark can't reach it, instead of a failed lookup (`lib/auth/mail-server-address.ts:23-41`, `components/auth/login-server-field.tsx:65-68`). Changelog 1.21.0 Sign-in.
  - What RN does: discovery runs and, when it finds nothing, goes to the manual server step (`src/screens/LoginScreen.tsx:378-405`, `src/screens/login/ServerStep.tsx:17`). No provider names in src.
  - Fix hint: port unsupportedProvider and show its note on the email step before discovery.

- [x] **No language choice before sign-in** — `P3` — `missing` — fixed in a5324408
  - What WEB does: a language picker next to the theme button on the login page, carried into the account after sign-in (`components/auth/login-language-picker.tsx`, `lib/signed-out-choices.ts`). 32dc8b7ef.
  - What RN does: the sign-in screens follow the phone's language (`src/screens/login/LoginShell.tsx:45`); the language picker is under Settings after sign-in (`src/components/settings/LanguageSettings.tsx`). No Android per-app locale config in app.config.js or the manifest.
  - Fix hint: a language button in LoginShell that sets the locale store, or declare the locales for the Android 13+ per-app language setting.

### Settings

- [x] **Tag settings show the stored `$label:` keyword under each tag** — `P3` — `bug` — fixed in 9c9b4106
  - What WEB does: hides the stored keyword; with advanced settings on it is a tooltip only (`components/settings/keyword-settings.tsx`). 3609b5c99.
  - What RN does: prints `$label:{id}` on every tag card (`src/components/settings/KeywordSettings.tsx:170`).
  - Fix hint: drop the line, or show it only with advanced settings on.

- [ ] **Calendars can't be made or listed for a shared or group account from the settings** — `P3` — `missing` — not done: Settings has no calendar management section to add it to, and createCalendar takes no account; a larger change
  - What WEB does: while managing a shared account, a new calendar is created in that account and listed under it, offered only where the account allows one, with the server's refusal shown; the settings group shared calendars by account (`stores/calendar-store.ts`, `components/settings/calendar-management-settings.tsx`). 6a6398fed, 5afa9e66f, df2ae1966, 6ee7e1b7a (#1617).
  - What RN does: createCalendar takes no account and creates in the own account (`src/stores/calendar-store.ts:1416`, `src/api/calendar.ts:1247`, `src/screens/CalendarScreen.tsx:941`). The managed-account scope covers filters and out of office only (`src/stores/managed-account-store.ts:3-8`); Settings > Calendar has no calendar management (`src/components/settings/CalendarSettings.tsx`).
  - Fix hint: pass an account id through createCalendar and check `mayCreateChild`-style rights before offering it. May overlap the calendar inventory.

### Push and notifications

- [ ] **New mail notifications have no Archive action** — `P3` — `partial`
  - What WEB does: Archive, Mark as read and Reply, Archive only where archiving is allowed (`public/sw.js:1391`, `:1498-1501`, `:1598-1603`). Changelog 1.21.0 Notifications.
  - What RN does: Mark as read, Delete and Reply (`src/lib/push-background-task.ts:130-138`, `:649-651`, `:750`).
  - Fix hint: add an `archive` action to the notification payload and handler; respect the `archiveActionEnabled` gate (`src/lib/org-policy.ts:92`).

- [x] **Calendar event notifications fail for good once more pile up than the server returns in one get, and each shows its own toast** — `P3` — `bug` — fixed in 0ff300c6
  - What WEB does: queries and gets `CalendarEventNotification` a page of maxObjectsInGet at a time, capped at 20,000, and sums many up in one toast (`lib/jmap/client.ts` getCalendarEventNotifications, `components/layout/calendar-event-notification-toaster.tsx`). f7d71929b, f3de8898e, 6f93d81f5 (#1567).
  - What RN does: one unpaged query and get (`src/api/calendar-event-notifications.ts:46-67`); past maxObjectsInGet Stalwart refuses the get, nothing is shown or acknowledged and the error repeats. Each fresh notification gets its own toast (`src/lib/calendar-event-notifications.ts:110-115`).
  - Fix hint: page with `position`/`limit` from `jmapClient.getMaxObjectsInGet()` and a cap; one summary toast above a few notifications.

### Offline and app lock

- [x] **Offline keeps only recent message bodies, unencrypted, with one device-wide size cap** — `P2` — `partial` — fixed in a7176a1f (per-account window and total, organisation caps; the app keeps no attachments offline, so the attachment caps have nothing to cap); not done: encrypted store, offline search, drafts, calendar, contacts and files: own project, decision 14
  - What WEB does: an encrypted on-device database of mail, calendars, tasks, contacts and files; offline search, drafts and attachments saved offline, changes queued and replayed once, conflicts listed; per-account history and attachment caps with a per-account total (92ca06c84, 510ae2f7a), clear per account, export of kept mail to mbox/EML zip (changelog 1.20.0 and 1.21.0 Offline; `lib/offline/`, `lib/store/`).
  - What RN does: caches message bodies and optional attachment blobs of the last N days, bodies as JSON in AsyncStorage (`src/stores/offline-cache-store.ts:1-10`), with one device-wide day and MB setting (`src/components/settings/StorageSettings.tsx:39-41`, `:208-226`); plus the Outbox for mail sent offline. No offline search, calendar, contacts or files, no per-account caps, no encryption beyond the app sandbox.
  - Fix hint: a large project. First steps that fit the current cache: per-account caps, search over cached bodies, and offline drafts through the Outbox. Encryption at rest matters less in the app sandbox than in a browser, but org caps (see Organisation policy) need the per-account split.

- [ ] **No app lock** — `P3` — `missing`
  - What WEB does: locks the app and the mail kept on the device with a PIN, a passkey or Windows Hello after a chosen time (changelog 1.21.0 App lock; `lib/app-lock/`).
  - What RN does: no app lock; it relies on the phone's own lock, with Delete from a notification asking for the device unlock where needed (`src/lib/push-background-task.ts:132-136`) and screenshot protection (`src/lib/screen-privacy.ts:6-20`).
  - Fix hint: optional biometric or device-credential lock on foreground after a timeout (expo-local-authentication), which needs a new native module and manifest entries.

- [ ] **An admin's remote wipe doesn't reach the phone** — `P3` — `missing`
  - What WEB does: devices register with the instance and check in at start (`POST /api/devices`, `app/api/devices/route.ts:31`); an admin can wipe a lost device or all of a user's devices, and the device deletes its local data at the next check-in, also when its password was revoked (`lib/offline/device-wipe.ts:1-35`). `organisation.devices.wipeOnForcedSignOut` asks for deletion at once after a refused login. ce3e3b9db (desktop main process part); changelog `CHANGELOG.md:175-176`.
  - What RN does: no device registration, check-in or wipe; a refused login signs the account out, and its cached data is cleared only by the sign-out path (`src/stores/auth-store.ts:553`).
  - Fix hint: cross-repo. Registration needs a session cookie today (`app/api/devices/route.ts:27-29`), so the webmail needs a bearer-token registration for the app first; then the app checks in at start and on resume and wipes the account's caches, drafts and keychain entries on a `wipe` answer.

- [ ] **No "Copy code" action on a new-mail notification for a sign-in code** — `P3` — `missing`
  - What WEB does: the desktop notification for a sign-in mail gets a Copy code button when "show verification codes" is on, using the same code finder as the list chip (`lib/desktop/mail-notifications.ts:146`, `:153`). 677903094.
  - What RN does: the list shows the code chip (`src/screens/EmailListScreen.tsx:352`, `src/lib/verification-code.ts:398`), but notifications offer only Mark read, Delete and Reply (`android/app/src/main/java/com/anonymous/bulwarkmobile/BulwarkFcmModule.kt:205-264`).
  - Fix hint: when the notification task has the message body, run the code finder and add a fourth action that copies to the clipboard (Android `ClipboardManager` from the receiver; on iOS a notification category action that opens the app briefly).

### Organisation policy

- [x] **The organisation's device policies don't apply in the app (push text, downloads, export, watermark, offline caps, remote wipe)** — `P2` — `missing` — fixed in a7176a1f (downloads, export, watermark, offline caps); push text on the security branch; not done: remote wipe (needs a webmail change first, decision 14); n/a: print and the install prompt
  - What WEB does: `organisation.devices` turns off attachment and file downloads, mail and folder export, printing and the install prompt, keeps sender and subject off push notifications (enforced server-side in the push preview), adds a watermark, forbids or caps offline data (days, attachment size, total), and admins can wipe a lost device (`lib/admin/organisation-policy.ts:163-185`, `lib/device-policy.ts:1-26`, `app/api/push/preview/route.ts:268-275`, `lib/offline/device-wipe.ts`). Changelog 1.20.0 and 1.21.0 Organisation.
  - What RN does: keeps the policy's `organisation` part as sent (`src/lib/org-policy.ts:57-58`, `:191`) but reads only the signature and disclaimer from it (`src/lib/org-signature.ts:61-62`). Push notifications always show sender and subject (`src/lib/push-background-task.ts:637-641`); offline caching follows only the user's settings (`src/components/settings/StorageSettings.tsx:39-41`); no download or export guard, no watermark, no wipe.
  - Fix hint: port devicesForAccount and apply pushWithoutContent first (push task, generic text), then noDownloads/noExport on the attachment and export paths and noOffline plus caps on the offline cache. Print is n/a.

- [ ] **An account the server refuses keeps showing its cached mail** — `P2` — `missing`
  - What WEB does: a refused login or an idle sign-out hides the account's mail on the device until the user signs in again, for at most 30 days, and says how many unsent messages wait; with `wipeOnForcedSignOut` it is deleted at once (`lib/offline/device-wipe.ts:9-12`, `:727`, `:742`). Changelog 1.21.0 Organisation.
  - What RN does: keeps the refused account with its caches and marks it "Sign in again" (`src/stores/auth-store.ts:249-270`); the start shows the refused account's cached mail (`src/stores/auth-store.ts:971-981`).
  - Fix hint: while `needsSignIn` is set, show the sign-in prompt instead of the cached list; drop the account's caches after 30 days, or at once when the policy asks.

- [x] **No organisation announcement banner** — `P2` — `missing` — fixed in d1b6cde9
  - What WEB does: an admin announcement across the top of Mail, Calendar, Contacts, Files and Settings, per language, with severity, start and end time and an optional close (`lib/admin/organisation-policy.ts:141-152`, `components/org/org-announcement.tsx`). Changelog 1.20.0 Organisation.
  - What RN does: nothing; `organisation.announcement` is never read (only `src/lib/org-signature.ts` reads `organisation`).
  - Fix hint: a banner under the header of the main tabs, dismissal stored per announcement id.

- [ ] **Trash and Junk don't say how long the server keeps mail** — `P3` — `missing`
  - What WEB does: `organisation.retention.trashDays`/`junkDays` show a line in those folders (`lib/admin/organisation-policy.ts:157-161`, `components/email/retention-notice.tsx`). Changelog 1.20.0 Organisation.
  - What RN does: nothing; the policy part is not read.
  - Fix hint: a list header line in Trash and Junk.

### JMAP core and sync

- [ ] **Changes made while the live connection was down are not fetched after it reconnects** — `P2` — `bug`
  - What WEB does: after every successful SSE (re)connect it runs one state check and reports what changed since the last known states; the first connection of a push session only primes the baseline; SSE and catch-up events are de-duplicated by state; a check from a closed push session is dropped; the baseline survives a rate-limit pause (`lib/jmap/client.ts` connectSSE, readSSEStream, checkForStateChanges, rate-limit handler). 71350de4f, 34fec1ca0, 8633ffff9, 2f1daa52c (#1553; changelog 1.21.0 Push).
  - What RN does: the stream reconnects after a missed ping, a dropped socket, a refused stream (429/5xx), a token refresh or the 30-minute recycle without any catch-up (`src/api/push-stream.ts:229-237`, `:284-288`, `:300-341`, `:349-357`). App.tsx refreshes mailboxes and the open list only on foreground resume (`App.tsx:825-831`, `:865-870`); a network-back reconnect has no refresh (`App.tsx:873-879`). Contacts, calendar, Files and Scheduled get no catch-up at all. Mail that arrived during a Wi-Fi to cellular switch shows only with the next change or a pull to refresh.
  - Fix hint: keep a per-session state baseline in push-stream (Mailbox, Email, CalendarEvent, ContactCard, FileNode, EmailSubmission), poll it once on each `open` after the first, report only changed types through onStateChange, and skip SSE events whose state was already reported. Port all four commits together, since the later three fix the first.

### i18n

- [ ] **No Greek, Norwegian Nynorsk or Vietnamese** — `P3` — `missing`
  - What WEB does: 32 languages; Vietnamese new in 1.20.0 (#1448), Greek (#1554) and Nynorsk (#1560) in 1.21.0 (`i18n/routing.ts`). 7788813ef, 0ccbe0685 (#1573).
  - What RN does: 29 locales without el, nn and vi (`src/i18n/index.ts:24-54`, `locales/`).
  - Fix hint: `node scripts/sync-locales.mjs`, register el, nn and vi, translate the rn overlays. Nynorsk falls back to Bokmål for missing keys if the loader allows it.

## Checked without a row

Every other webmail commit in `4887ed457..2c21722ae` and every other changelog entry of 1.20.0 to 1.21.1, with the reason it got no row.

- 724aed257 (shallow): n/a, merge of desktop branches.
- f570277a6 (shallow): n/a, merge.
- 466fa7f97 (shallow): n/a, desktop app server environment.
- 35a4b034b (shallow): n/a, marketplace.
- 2f846bb2d (shallow): n/a, server sign-in budget state.
- be8aba2ae (shallow): n/a, merge.
- 88d64b7f9 (shallow): n/a, desktop offline store keys.
- 551b5ce4f (shallow): n/a, command palette.
- 059015c8d (shallow): n/a, desktop menu height and focus ring.
- 4508eddcc (shallow): n/a, desktop menu placement.
- 53eb91ab0 (shallow): already in RN, the details panel is native wrapping text rows (`src/components/email/MessageHeader.tsx:89`, `:308-357`).
- 5be615406 (shallow): n/a, desktop notice.
- 141748e1d (shallow): n/a, web first-start notices (offline and dictionary questions).
- 0202803e7 (shallow): already in RN where RN names folders (`src/components/MoveSheet.tsx:137`, `src/screens/EmailListScreen.tsx:2069`, `src/components/SidebarDrawer.tsx:589`); RN search rows have no folder chip and there is no Spam banner, an older gap outside this range.
- 59d655260 (shallow): n/a, popout message window.
- 335711422 (shallow): n/a, merge.
- b3c9d99df (shallow): n/a, webmail General/Notifications wording and desktop-only rows; RN settings have their own text (settings inventory).
- dc16e2c2d (shallow): n/a, admin wording.
- adbab2e4a (shallow): n/a, merge.
- 8bfc7cf8e: already in RN, the reader shows the conversation with newest and unread expanded (`src/screens/EmailThreadScreen.tsx:1057-1104`).
- 447fc4821, 111a50507: n/a, Pro message window.
- 3a9ec6123: n/a, hover and context-menu pointer.
- fe8fff338: n/a, keyboard j/k.
- a19bdefdc: already in RN, the split pane opens the row that took the removed one's place (`src/lib/use-message-pane.ts:22-33`).
- 044647ff3: n/a, desktop layout breakpoints.
- 9df9505da: test-only.
- 8251d99d8: n/a, first-screen catalog.
- 8c195fdd8: n/a, print and plugin reader actions.
- 512441662: n/a, desktop docked reply.
- 4127d7a2a: n/a, hover on the folded folder column.
- 831f230d6, 17230c4cd, 72c419eca, 1ab614042, 7c67160f6, 4afae90da, ad87e4852, 1cfc9b57a, 9f2fa8aeb, 9ea14e7cc, 4a7fb2a98, dc17df7b4, 1f365021f, c53b64700: n/a, web render and virtual-list performance and layout.
- 429f1b923: test-only.
- 45ab75c15, b799e0f1c, 3a197ab49: n/a, plugin search results.
- 931277254, 1be172f6d, d26979c6c, ae3349f52, 583e5e129, cc7388adf: n/a, Pro folder tabs.
- c4c5d47dd: already in RN in effect, the keyword sort verdict is stored per server for a week, so the extra round trip is rare (`src/lib/keyword-sort-polarity.ts:15-27`).
- 14579e5e3: n/a, keyboard focus.
- 9099dc892: already in RN, the height comes from the content wrapper with a ResizeObserver, so it grows and shrinks (`src/components/EmailBodyView.tsx:202-225`, `:255`).
- 736305c10, 3806c9e63: n/a, hover actions.
- f5eb0e7c4: n/a, web offline SQL statement.
- da108df9b: n/a, desktop attachment tile look and hover actions; RN chips have their own sheet (`src/components/email/AttachmentChips.tsx`).
- d6dde503e: already in RN, a refused rename throws the server's reason and the drawer re-reads folders after any folder action (`src/api/email.ts:311-327`, `src/components/SidebarDrawer.tsx:562-573`).
- 0e854cc22: already in RN, a role change is one Mailbox/set and an error shows the server's description (`src/components/settings/FolderSettings.tsx:166-180`, `src/api/email.ts:322-326`).
- 325783472, 032c58176: n/a, desktop reading-pane reply layout.
- b17de9ffd: n/a here, fix to the composer Tags menu (#1610), which RN doesn't have; that menu belongs to the compose inventory.
- f03fce5bf, 296f49740: already in RN, a refused create throws type and description (`src/api/email.ts:298-308`).
- 5ec91812e: n/a, web focus outline.
- 4d595f775: duplicate of the open file 11 row "No BIMI sender logos or verified-mark check" (RN has no verified mark).
- 2b7b981ab, 4aa95f450, 7ea42112e: test-only.
- 3e2d09fa8: search previews in RN show dates only (`src/components/search/GlobalSearchSheet.tsx:45`); missed reminders, outbox and settings lists belong to other inventories.
- 39b6f6542: already in RN, editing a tag keeps its id and only updates label and colour (`src/components/settings/KeywordSettings.tsx:50`, `:338`).
- 21677c528: already in RN, method errors throw through requireMethodResult (`src/api/email.ts:331-355`).
- 215f6d125: n/a, RN has no reading width setting (left to the OS in file 11).
- cbb54d0ec: translation-only.
- 1.21.0 Attachments under the header, after the security warning: already in RN, chips sit under MessageHeader, whose spoof warning comes first (`src/components/email/MessageContent.tsx:107-119`, `src/components/email/MessageHeader.tsx:335`). RN keeps its two-position setting.
- 1.21.0 Several selected messages starred, moved and marked at once: already in RN (`src/screens/EmailListScreen.tsx:1366-1424`).
- 1.21.0 A click on a draft opens the composer: already in RN (`src/screens/EmailListScreen.tsx:796`).
- 1.21.0 Ticked messages dropped when the search or filter changes: RN actions only touch selected rows still listed (`src/screens/EmailListScreen.tsx:995-1009`) and the selection clears on folder change (`:986-988`). An empty filtered folder says "No emails found" (`:1885`).
- 1.21.0 Right-click and ⋮ menus, drag and drop, folded folders on hover, Mail list and Reader performance: n/a.
- 1.21.0 A forwarded message's header lists To and Cc: RN's forward header has From, Date and Subject only (`src/lib/quote-header.ts:14-28`); this is composing, left to the compose inventory.
- 1.20.0 Apple Mail inline pictures as attachments (#1478): already in RN (`src/lib/email-inline-parts.ts:21-44`).
- 1.20.0 Body shrinks to its content (#1474): already in RN (see 9099dc892 above).
- 1.20.0 Several accounts each show their shared mailboxes (#1486): RN's drawer shows the active account's own and shared folders (`src/components/SidebarDrawer.tsx:769-801`).
- 1.20.0 Notification from a shared mailbox opens it (#1499): push, left to the platform inventory.
- 1.20.0 Pasted images stay inline (#1451), opening a reply no longer loads quoted remote images: compose; the quote part is noted in the P1 row.
- 1.20.0 Undo toast off the header on phones (#1472), Mountain View fixes, printing plain text: n/a.
- 1.21.1 Rows keep their measured height: n/a, web virtual list.
- 5c2d30696: n/a, desktop menus.
- f8a803ad4: n/a, desktop popover placement in a short window; RN menus are bottom sheets.
- 4cebd9072: test-only.
- 656073804: row "Draft saved notice".
- 043f17f5d: n/a for RN; sidebar apps use built-in icon names, no remote images (`src/components/settings/SidebarAppsSettings.tsx:196`).
- edaa66ee9: n/a, focus outline and docked-reply layout.
- 9e3e210f5, 5f75f0c63: web render perf; RN builds the quote once when the composer opens (`src/lib/compose-html.ts:50-81`).
- 013e56c5f: no counterpart; the app has no admin-configured extra scopes and sends no RFC 8707 resource (`src/lib/oauth-native.ts:151-160`). Whether an external IdP sign-in in the app should ask for Stalwart scopes is a sign-in question for the platform inventory.
- ea7e2eedf, 6866201e2, be51c5086: row "template placeholder default".
- 5354d6066, 54e4a03a3: row "Tags menu".
- e74d2aaa7, e29a6553e: n/a, window controls overlay (desktop/PWA).
- fc7b607ff: web menu wording ("…" on entries that open a dialog, Share translated); RN sheets use their own labels.
- 8dfaa3960: row "read-only address book".
- e211ae905, 749f2e938: n/a, drag and drop.
- eda317721: test-only.
- 4f00deffe: row "attached message title".
- 2fcb7cd54: n/a, print.
- e403478a0: row "Stalwart Calendar (address)".
- bc955be10: row "run a new rule on existing mail" (root commit).
- 2094cca38: covered by row "empty out-of-office message"; RN shows the sample as an italic placeholder (`src/components/settings/VacationSettings.tsx:618`).
- ae1cf7782: n/a, PWA status bar (root commit).
- ecfc6e0a6, 068012c67, a426fe5df, 0504570cd, 0f0567491, 5761327b9: merge commits (root, no parent), n/a.
- 606521c0c, 4e7f7db57: test-only (root commits).
- 97abbde3c: see "Could not check".
- 2ff726fc1, 543b8b068: n/a, Pro view (#1555).
- 34a37c29b: row "SRS forwarder".
- 34ac66abf: row ".eml imported into Drafts".
- a1050e262: n/a, web lazy loading.
- 55cf44105: n/a, web start-up perf.
- cd0f584f0: n/a, browser download gesture.
- d91724550: n/a, web render perf (root commit).
- 6a0a1cacc: n/a, screenshots.
- c476b5839, 903969a5a: row "task lists in the drawer".
- efb7c889f: n/a, desktop popover with More menu (#1598).
- 91f211723, ae1c1bef7: row "empty and other-client task lists".
- 83c6e5eef: row "related contacts".
- 400dfb9c6: row "organisation's domains".
- 86887ecc6, 5c8112fd5, 7796af03e (#1617): no row. RN creates calendars only in the user's own account (`src/stores/calendar-store.ts:1416`, `src/api/calendar.ts:1253`) and has no shared-account calendar management, so the wrong-account bug can't happen.
- f73bd8837, 91e80b92d: row "contact event times and birthdays".
- 76ed77033: editor time labels already follow calendarTimeFormat (`src/components/calendar/EventModal.tsx:195-196`, `:652`, `src/components/calendar/TasksSheet.tsx:346`). The native time picker follows the device's 24-hour setting (no is24Hour, `EventModal.tsx:958-970`); not worth a row.
- 7d8532f6b: n/a, typed time fields; RN uses native pickers.
- 7ee54fa10, dbdf9efed, 4049ad2a8, 57f294f01: row "repeating task".
- 54ff10869: n/a, print.
- a236eb555: row "directory" (admin page parts n/a).
- b9b182732: n/a, desktop print.
- 14b381090: already in RN in the part that matters; Save is disabled while saving (`src/screens/ContactFormScreen.tsx:633`).
- d2da0c885: n/a; RN renames with one field holding the whole name, no separate extension (`src/screens/FilesScreen.tsx:1619`).
- 1.21.1 Compose "Replies under the message" (#1606): n/a, desktop reading-pane layout.
- 1.21.1 Compose recipient suggestions from an older lookup (#1596): already in RN, server hits are keyed by query (`src/screens/ComposeScreen.tsx:772`, `:787`).
- 1.21.1 Calendar new calendar of an account added second (#1618): part of row "only the active sign-in's calendars".
- 1.21.0 Compose: a message can go out without text, already in RN (no empty-body check in `src/screens/ComposeScreen.tsx:2728-2729`); a reply left untouched leaves no draft, already in RN (`:1317-1318`, `:1894`); Undo send counts down, already in RN (`src/stores/send-undo-store.ts:92`); replies open under their message, full screen, new window, shortcuts, toolbar layout and dropped pictures: n/a.
- 1.21.0 Offline drafts kept when the server can't be reached: already in RN (`src/lib/compose-rescue.ts:1-30`); the rest of offline is platform.
- 1.21.0 Calendar reminders on every occurrence: already in RN (`src/lib/calendar-alert-scheduler.ts:12-31`); missed reminders are OS notifications.
- 1.21.0 Calendar drag to create and move: n/a. Rename from the menu: already in RN (CalendarEditSheet edit mode). Three-day week: n/a. "(No title)" quick event: web quick-create popover; RN's editor requires a title (`src/components/calendar/EventModal.tsx:557`), no row. Task Del with Undo: RN asks before deleting (`src/screens/CalendarScreen.tsx:859-870`), no row.
- 1.21.0 Contacts phone custom type (#1515): part of row "Saving a contact drops details".
- 1.21.0 Files double-click and drop upload: n/a. Saved messages open from Files: already in RN (`src/lib/file-preview.ts:133`). Office editing (#1518): n/a, the app has no WOPI editing (open question in `docs/audit-2026-09.md:1035`).
- 1.21.0 Mail "a click on a draft opens it in the composer": reading area, not checked here.
- 1.20.0 Composer proofreading (#1397): n/a, plugin.
- 1.20.0 Replies leave an empty line above the signature delimiter (#1503, 3530e056c): already in RN; a reply starts with an empty paragraph and the signature goes after it (`src/lib/compose-html.ts:80`, `src/lib/signature-utils.ts:299-303`).
- 1.20.0 Plain-text templates keep angle brackets and ampersands: already in RN (`src/lib/template-utils.ts:211-215`).
- 1.20.0 Switching a reply to plain text keeps quote and list markers: already in RN (`src/lib/compose-html.ts:83-90`).
- 1.20.0 Drafts wait for uploads (#1454) and discarding cancels uploads (#1489): already in RN (`src/screens/ComposeScreen.tsx:1218`, `:1829`).
- 1.20.0 Identity without display name (#1462): already in RN, only the address is checked (`src/components/settings/IdentitySettings.tsx:168`).
- 1.20.0 Contact group as attendees (#1507): already in RN (`src/components/calendar/ParticipantInput.tsx:57`, `:64`).
- 1.20.0 Tasks with a shared account without calendar access (#1465): already in RN (`src/api/calendar.ts:158-186`).
- 1.20.0 Out of office hidden without the vacation permission (#1488, a3d485397): already in RN (`src/lib/account-capability.ts:18-23`).
- 1.20.0 Out of office plain-text part in step: RN keeps separate plain and HTML fields and derives the plain one only when it is empty (`src/components/settings/VacationSettings.tsx:161`), no row.
- 1.20.0 Undo of the first filter rule: RN undoes a delete by putting the rule back (`src/lib/settings-undo.ts`, `src/components/settings/FilterSettings.tsx:206-209`); not the web's bug, no row.
- 1.20.0 Lite subscribe to calendar: n/a.
- e64c6c7bc: n/a, desktop OS policies (lib/desktop, app lock policy bridge).
- 0f3d53424: test-only.
- ea274b02e: n/a, web CSS; RN rows already end in an ellipsis (`src/components/settings/settings-section.tsx:218`).
- cbe7d5da4: n/a, desktop ADMX templates.
- a28617cbb: n/a, web offline-mode start message.
- 13272ad85: n/a, desktop quiet hours and taskbar flash.
- e0f19bc6f: row "No server settings for other mail apps".
- 2a726c0f4: row "The account switcher shows no unread count per account".
- 3609b5c99: row "Tag settings show the stored `$label:` keyword".
- e8f17e2e3: already in RN (`src/components/settings/SidebarAppsSettings.tsx:58-59`).
- b732acbcd: translation-only (settings row labels) plus a search test.
- d70c7201f: already in RN, the contacts pane is found by "contact" and "address book" (`src/lib/settings-search.ts:214-221`, `:299`).
- dcb505aac: n/a for calendar subscriptions, RN settings have no subscriptions page; the mail-app words go with the mail-apps row.
- adbbfe814: test-only.
- b97eba59c: test-only.
- 764aecca0: row "Account security doesn't work on Inbuxa servers".
- 31de1649e: row "No masked addresses".
- eee7917bb: n/a, operator inline app frames; RN sidebar apps are the user's own links (`src/components/settings/SidebarAppsSettings.tsx`).
- b350e3450: n/a, settings page reorg that mostly moves desktop rows; RN has its own page set (`src/screens/SettingsScreen.tsx`).
- 71350de4f: row "Changes made while the live connection was down".
- 34fec1ca0: same row.
- 7788813ef: row "No Greek, Norwegian Nynorsk or Vietnamese".
- 0131fa902: translation-only.
- 366d5f453: n/a, RN has no more-contrast setting (open file 11 row "No reading fonts, text spacing, more contrast").
- 8633ffff9: row "Changes made while the live connection was down".
- a6cab67bb: n/a, RN has no operator sidebar apps or image icons.
- 2f1daa52c: row "Changes made while the live connection was down"; RN's polling already primes silently on the first tick (`src/api/push-stream.ts:131-134`).
- 0d31ec134: n/a, web start-up performance.
- 22ebac6b3: n/a, web first paint.
- f7d71929b: row "Calendar event notifications fail for good".
- f3de8898e: same row.
- 6f93d81f5: same row.
- 8eb3431bc: n/a, RN has no welcome tips banner.
- 34398a32f: translation-only.
- cba56f59a: test-only.
- c8af72d3a: n/a, web sign-in first paint.
- 1314bf1ac: n/a, web prefetch.
- 61c46957f: n/a, service worker.
- 6494ee096: n/a, web start-up.
- dca5022a6: n/a, web prefetch.
- d4f5064e1: n/a, web start-up.
- 17c73cf5d: n/a, web prefetch.
- 4dfd3bf31: n/a, web first paint.
- c3b4a0d0f: n/a, web start-up store ordering.
- b1153faab: n/a, web signed-out redirect.
- b8afaf53f: n/a, web React hook.
- 27fedac8f: n/a, web rail prefetch.
- 0ccbe0685: n/a, RN has no address format; Nynorsk itself is in the i18n row.
- d2a51d7a7: n/a, web rail prefetch.
- 4718f4596: n/a, service worker offline shell.
- dac545fcf: n/a, web offline store start.
- 8689f0661: row "No link to the mail server's account page".
- 32dc8b7ef: row "No language choice before sign-in"; the login accessibility panel additions are n/a (focus outline, Caps Lock) or the open file 11 row (underline links, fonts).
- b9c244ee9: n/a, webmail offline store internals; RN has no such store (offline row).
- 3a93fe2c4: same.
- f529148f1: same.
- b2803edf7: same.
- 085302e9d: same.
- bd55e423a: release.
- 41da02cc3: n/a, webmail offline store internals.
- 5ef8c0e21: docs.
- e88c259d6: row "No masked addresses".
- 9977b7cff: translation-only.
- 08a3220ba: n/a, admin impersonation.
- d73c1d645: n/a, admin impersonation.
- cccc1a3b6: no row, the browser prompt needed the app name; RN's prompt sits inside the app (`src/components/PushOnboardingPrompt.tsx:140`).
- e9e88f8ed: same.
- f2e8bea80: already in RN, the unified view switches show whatever the account count (`src/components/settings/LayoutSettings.tsx:193-220`).
- 215c85bf8: already in RN, suggestions are computed from the typed query and server hits are used only for their own query (`src/screens/ComposeScreen.tsx:764-772`, `:787`).
- 6de3ada88: test-only.
- 353f2c053: n/a, Mountain View.
- f328982ac: n/a, keyboard focus outline.
- 9955f85a4: test-only.
- 2a90a73a1: translation-only.
- 6a6398fed: row "Calendars can't be made or listed for a shared or group account".
- 6ee7e1b7a: same row.
- 01eb59268: n/a, keyboard focus outline.
- 48043f9cd: n/a, CalDAV PROPFIND task-list detection; RN reads calendars over JMAP only (`src/api/calendar.ts:450-457`).
- 5afa9e66f: row "Calendars can't be made or listed for a shared or group account".
- df2ae1966: same row.
- 728b4d8fe: translation-only (line ending).
- 467284323: n/a, RN uses the native time picker, no typed time fields (`src/components/calendar/EventModal.tsx`).
- 8be6dd0db: n/a, CalDAV calendar home lookup.
- e33bae805: n/a, web store ordering; RN resets the calendar store when an account is added (`src/stores/auth-store.ts:437-442`). Not tried on a device.
- f33eb4941: n/a, web avatar lookup; RN account initials take the display name and email or username (`src/components/SidebarDrawer.tsx:960`).
- ba3b9eaec: release.
- 2b3b672b7: row "Shared accounts can't be reordered".
- 7ac6606f6: same row.
- 92ca06c84: offline row (per-account total).
- a6fad9230: row "No masked addresses".
- ebc1a439b: same row.
- b44ad1503: row "No server settings for other mail apps".
- 74da3b0e0: n/a, web React effect order; RN derives the blocked banner from the shown message (`src/components/EmailBodyView.tsx:529-533`, `:739-744`).
- 393089b3b: n/a, service worker.
- 510ae2f7a: offline row (organisation note on the per-account total).
- 1.21.1 Accessibility focus outline default and Off choice: n/a, keyboard focus.
- 1.21.1 Sign-in "Keep unticked sign-ins until the browser closes": n/a, web cookie session.
- 1.21.1 Admin "Return to my account": n/a, admin.
- 1.21.1 Sign-in Extra scopes per resource (#1583, 013e56c5f): n/a, webmail SSO config; the app's own OAuth already asks the 1.0.3 account scopes (`src/lib/oauth-native.ts:143-179`).
- 1.21.1 Notifications prompt title (#1577): see cccc1a3b6.
- 1.21.1 Settings unified views for one account (#1594): see f2e8bea80. Settings window scroll and Mountain View search: n/a.
- 1.21.0 Security build `.env`: n/a. Lite token revoke: row "Signing in again". Push preview renews only its own login, sign-out not undone by a renewing preview (#1509): already in RN, the push task won't write tokens back for a signed-out account (`src/lib/stored-token-refresh.ts:15`, `:87`).
- 1.21.0 Settings reorg and plain wording: n/a.
- 1.21.0 Calendar reminders from the local copy, per occurrence: already in RN as OS-scheduled local notifications (`src/lib/calendar-alert-scheduler.ts:1-4`, `:149-184`).
- 1.21.0 Notifications show sender and subject after the browser closed: already in RN (`src/lib/push-background-task.ts:637-663`). Actions: Archive is a row.
- 1.21.0 Installed app (PWA) features: n/a.
- 1.21.0 Settings: Offline, Privacy and About pages already exist in RN (`src/components/settings/StorageSettings.tsx`, `PrivacySettings.tsx`, `AboutSettings.tsx`); search finds everyday words already (`src/lib/settings-search.ts:276-307`). Account switcher at the top of the sidebar: n/a, desktop sidebar.
- 1.21.0 Sign-in asks for the email first and finds the server: already in RN (`src/screens/LoginScreen.tsx:378-383`).
- 1.21.0 Login page background, layout, branding palette, `OAUTH_PASSWORD_FALLBACK_ENABLED`: n/a, webmail login page.
- 1.21.0 policy.json hover actions (#1564): n/a, hover.
- 1.21.0 Performance (sign-in, start-up): n/a.
- 1.21.0 Push: a tap opens the new message, already in RN (notification carries emailId, `src/lib/push-background-task.ts:663`); sign-out and removal end push, already (`src/stores/auth-store.ts:907-913`, `:1176`); per-account notifications off, already (`src/lib/notification-mutes.ts`); do not disturb and quiet hours: the phone's own; subscription renewal: RN extends from the push task (`src/lib/push-background-task.ts:587`) and iOS renews itself (c704c7e6); two possible accounts get a plain "New email", already (`src/lib/push-background-task.ts:510`, `:675-705`).
- 1.21.0 Accounts (#1539): already in RN, only a 401 counts as refused (`src/api/jmap-client.ts:1011-1074`), a token endpoint outage stays a NetworkError (`src/api/jmap-client.ts:596-616`), and a refused account stops and asks to sign in again (`src/stores/auth-store.ts:249-270`).
- 1.21.0 Sign-in 1.0.3 scopes (#1527, #1550): already in RN (`src/lib/oauth-native.ts:143-179`). Callbacks under the base path (#1551): n/a.
- 1.20.0 Offline mode: offline row. Updates tab reload: n/a. Mobile app hand-off code and policy: already (ab2e5a60, 9d977773).
- 1.20.0 Several instances, Kubernetes, monitoring, usage stats, logging: n/a, server.
- 1.20.0 Security, trusted sender vs. organisation block in the reader and in replies and drafts: already in RN (`src/components/EmailBodyView.tsx:529-533`, `src/screens/ComposeScreen.tsx:534-541`). Plugin secrets: n/a.
- 1.20.0 Settings, two saves at once and "Delete junk for good" sync: n/a, RN doesn't sync settings with the server. Composing page shows the admin's locks: already (`src/components/settings/ComposingSettings.tsx:147`).
- 1.20.0 Accessibility, Reset brings back the organisation's defaults: already (`src/stores/settings-store.ts:1113-1118`).
- 1.20.0 Organisation proofreading policy, company calendars and free/busy group, search scope policy, contacts directory switch: left to the compose, calendar and reading inventories.
- Session limits (`organisation.session` idle and max hours) and the external sender chip: existing open file 10 rows, not repeated.
- 1.21.1 Admin "Return to my account" after impersonation (#1538): n/a, admin and plugins.
- 1.21.1 Admin Auto-configure OAuth on Stalwart 1.0.3 (#1611): n/a, admin console; the app's hand-off check reads `oauthClientId` from /api/config, whose contract didn't change.
- 1.21.1 Sign-in "Keep unticked sign-ins until the browser closes" (#1559): n/a, cookie sessions; config key additive.
- 1.21.1 Plugins entries (#1585, #1587, #1602): n/a.
- 1.21.1 Settings unified views for a single account (#1594): already in RN, the toggles always show (`src/components/settings/LayoutSettings.tsx:194-224`).
- 1.21.1 Admin pages keep scroll; Desktop blank cards and macOS rail logo: n/a.
- 1.21.0 Desktop app beta section (lines 93-108): n/a, except the app lock, wipe and copy code rows.
- 1.21.0 Security: standalone build guard: n/a (deploy). Lite refresh token revoke: row "Signing in again leaves the old Stalwart grant open".
- 1.21.0 Admin plugin defaults, user features under Users: n/a.
- 1.21.0 App lock: row. Organisation offline caps and wipe: rows.
- 1.21.0 Login page background and layout, DOMAIN_BRANDING palette: n/a, the app has its own sign-in screen.
- 1.21.0 `OAUTH_PASSWORD_FALLBACK_ENABLED`: n/a, web sign-in page.
- 1.21.0 Admin policy list defaults (#1564): no row, hover actions are desktop-only; contract note in the routes section.
- 1.21.0 Admin sidebar apps with image icons (#1544, #1545): covered by the open file 10 row "Settings extras: ... sidebar apps never rendered".
- 1.21.0 Marketplace quick install, Docker any uid (#1569), plugin entries, i18n el/nn: n/a (translation and plugins).
- 1.21.0 Performance (sign-in 0.45 s, startup, Lite compile hints): n/a, web first paint.
- 1.21.0 Fixes Admin (#1532, #1557, #1561, #1531, #1510), Lite policy reload (#1563), plugins framed (#1533), sidebar apps frame (#1526): n/a.
- 1.20.0 Server `X-Powered-By`, admin theme upload switch removal: n/a.
- 1.20.0 Loading skeleton: n/a, boot skeleton.
- 1.20.0 Several instances, Kubernetes, `/api/ready`, metrics, OpenTelemetry, error reporting, usage stats errors, logging: n/a, deploy. QR pairing and hand-off across instances need no app change.
- 1.20.0 `OAUTH_RESOURCE` (#1461): n/a for the app, which signs in to Stalwart itself; resource indicators belong to the auth inventory if anywhere.
- 1.20.0 Marketplace screenshots, all Plugins entries: n/a.
- 1.20.0 Mobile app: one-time hand-off code and policy for the access token: already in RN (`src/lib/oauth.ts:297`, `src/stores/policy-store.ts:140-170`).
- 1.20.0 Organisation device policies: row (P2).
- 1.20.0 Fixes Admin (#1436, #1249, read-only config, policy conflict), Branding `?v=` logos, Plugins, Marketplace, Server base path (#1455, #1487), Lite subscribe: n/a.
- 7f50113b9 desktop app lock without PIN: n/a desktop; app lock row.
- 1c201b077 Docker build guard: n/a deploy.
- ce3e3b9db wipe through the desktop main process: n/a desktop; remote wipe row.
- ff0e16c75 desktop Alt menu bar: n/a desktop.
- 674845df4 desktop menus language: n/a desktop.
- ad970b35e Move to from a message window: n/a popout windows.
- 1f4b0669c desktop file open asks message or Files: n/a desktop.
- 1cf03ff0e desktop developer tools switch and policy: n/a desktop.
- 6d3d7707a desktop forced server policy: n/a desktop.
- 8bcf5248a translate Lock now: n/a translation.
- 0823a531f desktop right-click search: n/a desktop.
- 364fc516d hide browser link handlers in desktop: n/a desktop.
- a9064dd97 Move to in a message window: n/a popout windows.
- 0729f05ae tray unread list account name: n/a desktop.
- 074667947 Outlook keyboard shortcuts: n/a keyboard.
- 5fbc9b1f4 mailto in its own compose window: n/a desktop; `ParsedMailto.fromOs` is desktop-only.
- a5ae7ce14 popout signed-out line: n/a popout windows.
- 0ba96ae79 admin plugin callback rename: n/a admin.
- dfed23e38 desktop devtools policy unreadable: n/a desktop.
- c2d7addbd Alt menu RTL arrows: n/a desktop.
- a2559713e test plugin kit text area: test-only.
- a9c2b4b19 sidebar app image icon: n/a, sidebar apps not rendered in RN (open file 10 row).
- cd667e252 test plugin API probe: test-only.
- b5a7cfdac desktop dialog shadow: n/a desktop.
- 889935133 demo in desktop: n/a demo.
- 90f305338 demo accounts out of offline mode: n/a demo.
- 43fc01fbc keep app running when a background host fails: n/a web providers.
- 6e04381af test desktop settings: test-only.
- d3afd7562 test os-store and lite scope: test-only.
- 3f346cfe2 sign-in page tab title: n/a web.
- 126a13b97 demo deploy networks: n/a deploy.
- c7b67e2ad desktop Save as: n/a desktop (RN exports .eml its own way).
- e4cdaa118 policy route regex inline: no contract change (routes section).
- 24eaeacb3 plugin/theme package reader lazy load: n/a web performance.
- 06fac4f96 plugin assistant out of first screen: n/a web performance.
- 7570dc4de folded sidebar column transition: n/a desktop layout.
- a5c67982e desktop print preview: n/a print.
- 2569eca5f perf guard budget: n/a CI.
- b8bc7d3b5 Lite reloads policy.json and config.json (#1563): n/a Lite.
- b5f141a2d test plugin result date: test-only.
- d990d9c57 policy presets hover actions, logs skipped defaults (#1564): no row, hover actions are desktop; list defaults dropped safely by RN (routes section).
- f661a24c5 test desktop menu: test-only.
- 4291430a8 translate desktop print preview: n/a translation.
- 9716ef624 app still behind desktop print preview: n/a print.
- e495aa058 sign-in page without app code: n/a first paint.
- 65629d292 Lite compile hints: n/a Lite.
- d9b33695f test sign-in redirect: test-only.
- 20c7dc1e5 sign-in notices on first screen: n/a boot skeleton.
- 8917b7284 policy asked for at page start: n/a web first paint, no contract change.
- 3b53148a7 reuse start's policy on local store takeover: n/a web offline window handling.
- a3f9e8f9d policy after config again: n/a web first paint.
- 66d46d23a Lite revokes replaced refresh token (#1571): row "Signing in again leaves the old Stalwart grant open".
- 4deb27da5 Docker any uid (#1569): n/a deploy.
- 97c39360e login page background and layout: n/a web sign-in page; hand-off still read the same (routes section).
- c7555ff9b perf guard budgets: n/a CI.
- b6f014af8 perf guard render passes: n/a CI.
- 16dcdb0c9 desktop lock on screen lock or sign-out: n/a desktop; app lock row.
- 677903094 Copy code in desktop notifications: row "No Copy code action".
- 6138f1f89 changelog docs: n/a docs.
- 5cd05c8c6 browser-session sign-in (#1559): n/a cookie sessions; /api/config key additive.
- 396a83806 admin scroll position: n/a admin.
- 5c74816d2 plugins draw impersonation return (#1538): n/a admin and plugins.
- ca135601f impersonation without remembered admin sign-in (#1538): n/a admin.
- d55d3ec28 Lite build with impersonation endpoint: n/a Lite.
- c1be09aed plugins tasks keywords (#1585): n/a plugins.
- 261413a29 plugin sign-in in desktop window: n/a plugins and desktop.
- b9a5f5820 desktop dialog colours: n/a desktop.
- 0ecdf3640 plugin callback under base path: n/a plugins.
- eb18833f3 no scrollbars in plugin slot: n/a plugins.
- 82becb847 unified views section for single account (#1594): already in RN, toggles always shown (`src/components/settings/LayoutSettings.tsx:194-224`).
- 4a16020d6 plugin slot docs: n/a docs.
- 7d2f374e9 showAttachmentChips restriction key: row "Policy can't turn off the attachment chips".
- d712d029d test plugin slot scrollbars: test-only.
- 2ce07c9a2 CalDAV component lookup timeout, skipped in Lite (#1605): n/a, RN has no CalDAV PROPFIND for calendar components (tasks-only detection is JMAP-based, `src/lib/calendar-component-detection.ts`); the #1605 feature itself belongs to the PIM inventory.
- 8b68526fd OAuth setup admin sign-in (#1611): n/a admin.
- 5f31075d2 OAuth setup failure limit (#1611): n/a admin.
- f84a9a9d2 OAuth setup control characters (#1611): n/a admin.
- b4f3dcc58 OAuth setup API key format (#1611): n/a admin.
- 82e39dcd1 OAuth setup server URL from config (#1611): n/a admin.
- d666aa262 settings page window scroll: n/a web layout.
- 69a67cb49 focus outline in Windows contrast themes: n/a (Windows forced colours; the focus outline settings belong to the a11y inventory).
- 982938d8f rail logo clear of macOS buttons: n/a desktop.
- b94d773eb desktop always compose in new window: n/a desktop.
- 73d82dfff desktop reopen after restart: n/a desktop.
- 58978b9cc plugins tasks.list named calendars: n/a plugins.
- 676070e23 plugin search.clear and toggles: n/a plugins.
- 6046adb66 admin accounts into the dashboard: n/a admin (only `normalizeUrl` exported from jmap-servers; policy route untouched).
- ae2dd969a admin picks default tags: row "Admin's default tags don't reach new phone users".
- 7a575327c directory lookups matched by address: row "Admin's directory limit".
- 42b40229c Docker locale prefix (#1626): n/a deploy; hand-off URL unaffected (routes section).
- 9a8cb297b OAuth setup issuer pre-fill (#1611): n/a admin.
- 8ed85983a OAuth setup app password hint (#1611): n/a admin.
- d6a891397 OAuth setup "everyone signs in again" (#1611): n/a admin.
- 78cd73ad2 admin check logging (#1611): n/a admin.
- 5beb208ba OAuth setup registers SSO sign-out return (#1611): n/a admin; the app ends provider sessions with its own redirect (`src/lib/oauth-native.ts:311`).
- a75828ff5 desktop "Use my organisation's Bulwark instead": n/a desktop.
- eb9f3dcca plugin tasks skip birthday calendar (#1625): n/a plugins.
- 90cb6b88c plugin search clear keeps user filters (#1619): n/a plugins.
- 4f767069c plugin toggle ticked in phone header menu (#1619): n/a plugins.
- 751647cec admin policy hidden accounts field on a phone (#1635): n/a admin; directory row.
- 8e75fee32 admin accounts ASCII case fold (#1627): n/a admin.
- 477c4fa32 seven colour tags kept unless admin sets defaults (#1630): row "Admin's default tags"; RN already starts with the seven (`src/stores/keywords-store.ts:35`).
- 652c0c1ba admin search finds directory and admin accounts (#1635): n/a admin.
