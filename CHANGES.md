# Changes since 4 October 2026

The webmail parity work from 4 to 8 October 2026: 349 commits (72 features, 237 fixes, and docs, tests and chores) in eleven merged pull requests, plus phases 6e and 7 on `parity/phase-6e-settings-ui` and `parity/phase-7-final-items`, which are not merged yet. At the start, 380 of the 489 tracked webmail parity items were done and 109 were open ([roadmap](docs/superpowers/plans/2026-10-04-webmail-parity-roadmap.md)). Now 486 of 494 are done and 8 are open ([PARITY_CHECKLIST.md](PARITY_CHECKLIST.md)); five items were added during the work.

The phases are listed newest first. Short hashes are in parentheses. What each phase left open is in the roadmap's follow-up sections.

## Phase 7: the last parity items (unmerged)

Branch `parity/phase-7-final-items`, everything after a5e415e.

### Improvements
- Folders sort by their saved order first, as webmail does, and Settings has move up and move down for your own folders (67bb45a, f20f799).
- Pick an icon for each folder, and turn the coloured sidebar icons off; the icons show in Settings and the sidebar (f0e4ceb).
- Hide, reorder and nest tags, shown as a tree in the sidebar and the tag sheet (13bf1ca, 65f7700).
- Share a mail folder with other users on the server, from Settings or the sidebar, on servers that offer it (945c8b6).
- A toast when someone shares a folder, calendar or address book with you (820e817).
- An invitation shows who sent it and its update number, folds away, and opens its day in the calendar (06d81c3).
- A counter-proposal can be reviewed and applied for every attendee, after a confirmation (4e9887a).
- The Persian (Jalali) month grid, titles and stepping when the app is in Persian (9b2aa54).
- Swipe actions, drawers and switches sit on the right side in right-to-left languages (cd9c772).

### Fixes
- An invitation's sender is shown at the address the trust check used, with the From named when someone else sent it, and a warning stays in view when the banner is folded (1ec17bb, 9c0e788).
- A counter-proposal is applied only when its attendee provably sent it, and an invitation that reuses the id of an unrelated stored event never answers that event (f621e2a).
- An attendee's answer is trusted only when your own event has that attendee, and only a pass for the sender's own domain counts (6ff0e8c).
- A counter-proposal applies on Stalwart even when only its description can't be written, and a helo pass is never counted as the sender's (6ae09a3).
- An invitation is never called verified without a pass, and once it is in the calendar the card shows the stored event's place and link (6232d78).
- A helo-only or another domain's DMARC pass leaves the unverified-sender warning on, and the host is shown clean before a link opens (f2a6454).
- When only a description is held back, the counter-proposal says why it can't be applied, and that held-back changes stay as they are (c56592e).
- Folders: Settings lists every folder, scheduled included, and screen readers reach the move buttons (41ab162, 1b3a649).
- A folder shared with "Read only" on Stalwart reads back as read only, and making someone a folder manager asks first (6f59f0f).
- Share and invitation toasts stay on one line and never push out an undo or error toast (b3bb437, 1b48bcd).
- A new folder keeps its icon, tags draw as dots when coloured icons are off, icons are forgotten on sign-out even after a failed read, and tag counts show only for their own account (67fc430, 5d3238c).
- Unsaved folder edits are kept when sharing from Settings, and sharing is offered by the editor's own account (d7425fa).
- Two tags with one name get a warning, the tag editor opens on the parent the tree shows, and stored tags with a bad id, colour or name are repaired (ca7522d).
- The Jalali calendar shows the selected day in Persian, and stepping back to a month keeps a row above it (807dd56).
- A folder settings description no screen shows any more is removed from every language (825bb6c).

## Phase 6e: settings, UI and security (unmerged)

Branch `parity/phase-6e-settings-ui`, everything after 3719f21.

### Improvements
- A message whose sender could not be verified shows a warning, and offers no "Always trust this sender" (df4deac).
- Two privacy options on this device, both off by default: block screenshots, or only hide the app in recent apps. The status and navigation bars follow the theme (982fc01).
- Signing out ends the identity provider's session, but only with the last account that uses that provider (dd9b30b).
- Rename and recolour a shared account's calendars and address books from Settings (5ac7b7d).
- The font size setting scales most of the app, not just the mail list; about 60 fixed text sizes are left to convert (0041a15, d35b282).
- Each account keeps its own push relay (92aa254).
- Sidebar apps show in the app, and open only web links (3306c31).
- Settings search finds more settings, and About links the commit of the running build (28ffebf).
- A date format region and an app-wide time zone, under Language & region (7e22723).
- A folder link opens its folder (7c19093).

### Fixes
- The sender check reads the envelope host in linear time, names only the receiving server's own result, and offers trust only on a known verdict (f7e7733, 3c6b1ed).
- The sender host in the warning has directional marks stripped, so it can't be disguised (7e9e569).
- Only an SPF or DKIM pass for the sender's own domain clears the warning (cc5a680).
- A quoted envelope local part stays joined to its domain when the sender is judged (dc3bce8).
- The recents option says the app can show briefly while switching, and the bar colours survive the activity being recreated (71d5b89).
- Provider sign-out sends no post-logout redirect, keeps a refreshed id token, tells providers apart by their whole end-session endpoint, builds the end-session URL exactly as advertised, and deletes the account's credentials before its id token (b141553, 8df1af0, 2c31fda, 96a070c).
- A provider session that a hand-off account or an unreadable account may still need is kept (e56f929, f78c6f7).
- Push relays are cleaned up on every sign-out path and in settings import, re-registered on reset, migrated once, and kept under the account they were chosen for (b00c177, 13dcd2a, 4fd6131, 56ce6db).
- Sign-out leaves no relay or folder link behind (e56f929).
- A shared calendar or address book is never deleted from the settings pane, and only changed fields are written (c9e033d).
- Sidebar app URLs are judged as strings, so both URL implementations agree (9c339f3).
- Worded dates keep the language's own Gregorian pattern; file and send-later times use the app's time zone (260f124).
- The time zone setting is only under Language & region (e1ef0b1).
- A send-later time that falls in the device's own daylight-saving gap is kept as picked when the app uses another time zone (0bd733e).
- A folder link waits for both the account's own and its shared folder lists before saying the folder is gone (6ed331e).
- A bare mail link leaves the folder alone, as does a link that arrives after the user moved on (b835d31).
- Tab labels scale with the font size, the OS font scale is capped on fixed chrome, labels beside icons are spaced, and screen readers read the unread count once (d35b282, f78c6f7).

## Phase 6d: filters, vacation and files (#12)

### Improvements
- A Files link opens its folder and previews its file (219e808).
- The Files storage notice shows once, until dismissed (656c2c4).
- A warning before saving an auto-reply that Stalwart would refuse as too long (0b61ed1).
- Filter rules respect the server's forward limit (ad02c89).
- Forward mail while away, and choose who gets the auto-reply: everyone, internal or external senders (5a057d6).
- Filter rules can have an active period (4892366).

### Fixes
- Webmail's v2 filter scripts, with rule periods, vacation forwarding and reply audience, are read and kept byte for byte; native used to treat them as hand-edited (eeaa90a).
- Turning the auto-reply on no longer stops every filter: the filters keep running, forwarding and audience sync on one connection, and filters the auto-reply stopped are reported (2ca8898, eb00a2c, 94a764c).
- The auto-reply can always be turned off, even when the filters can't be rewritten or a forward can't take the new dates (588c2a9, a6a2923).
- A filters restart is offered only where a save can do it, and the filters undo is bound to one connection (54e777b).
- A filters-only vacation failure is titled by what the save rewrote; the forward limit is read for the account shown (d1e59ae).
- A save that meets a reconnect reloads the filters for the right login and says to try again (6be7941, c582a39).
- An unchanged rule period boundary is kept on Android, and the "include spam" option can be turned off again (6038b0d).
- A rule from a message that needs capabilities the server lacks is refused with a reason; the Rules sheet keeps what it read with its login (bb71c12, 81c5b25).
- A send queues when the app started offline (9b67c09).
- Composer identities are fetched with the live account id (f146888).
- A search of All mail covers every folder but Trash and Junk, Sent included (b5aba27).

## Device checks 1 (#11)

Run on an Android 17 emulator and a Galaxy S24+ against Stalwart.

### Fixes
- Move, flag, archive and delete stick after a cold start; they used to come back on the next refresh because the outbox and offline cache weren't pointed at the account (7e4b5c8).
- The folder form and move toast show the folder name and count instead of raw placeholders (1311da8).
- A composer opened offline can send from cached identities (cb09766).

## Phase 6c: composer and contacts (#9, #10)

### Improvements
- Event guest suggestions from contacts, groups, directory people and recent recipients (714cb18).
- Sender identities refresh when the app returns and every 30 minutes (cc569a7).
- Filter the contact list by organisation, title, place, domain, birthday month and details (a0dd790).
- Ask for delivery notifications (DSN) or require TLS when the server offers them (c67f2cd).
- Links that open a new contact or a contact's edit form (d979c72).
- Send as the From override, falling back to the identity's address (7673910).
- A pasted plain-text list becomes a real list (ba02d24).
- Share an address book with people on the server (3b25238).
- Mention a recipient by typing @ (c18d8fa).
- Attach files from the Files app (e03d9de).

### Fixes
- The app no longer crashes on a cold start while drawing saved rows before the client connects (80217dd, #10).
- Directory people load for event-guest suggestions (1b98d84).
- Contact filters are announced to screen readers, and malformed cards are tolerated (6bb93b4).
- An active send toggle stays visible, and hold limits come from the composer's own account (49720dc).
- The contact edit form no longer deletes the photo or overwrites newer fields, waits for the contact to load, and stays with its own account's card (d979c72, b9e05e1, 1aa4891).
- A submission reported both created and refused counts as created, so it isn't sent twice; Reply-To comes from the submitting identity (99ba2af).
- Paste and @-mention handling: the paste answer is matched by id, a mention pick after a blur is kept, a pending paste settles before a mention, and pasting doesn't take focus (0b9a693, e6596ed, 460f333).
- The share sheet lists no one while the client serves another account, and its errors are translated (c1236d7, 22e4e14).
- A picked file's preview stays in its owner's account, the Files picker opens after the Attach menu closes, and identical files are told apart (8b3af2f, 48c27ce).
- REQUIRETLS and DSN are kept through "Send now", reschedule and undo (de20fe2, 4574a24).
- A held send with a recipient without an address can't be rescheduled (29b49fc).
- The vacation section headings are translated again (a2e5a0b).

The webmail locale catalogs were re-vendored at `ccf6bf7` (3d6515f).

## Phase 6b: mail list (#8)

### Improvements
- Webmail's global search core (c7b92dd), searching mail, contacts, calendar and files from one screen (b538850, fd033bb).
- Search matches are highlighted (7d1e5a3).
- Pick any folder for a search from a folder tree (eb50397).
- The Inbox opens on start, with a setting to reopen the last folder (c893a48).
- Empty any folder; ordinary mail moves to Trash (65b2e59).

### Fixes
- Search sends the words as typed, without a wildcard, and can filter by message size (806283a).
- A load-more page for a search the user has since changed is dropped (bd0e800).
- Unknown tags get colours, previews skip style sheets, rows have screen-reader labels and actions, and rows stay still while chips load (646d8a8, 0328a9c).
- A folder opens at the top, an opened message keeps its place in unread-first order, a pull re-sorts held rows, and an account switch scrolls to the top (271cd36, ef4f634).
- Search hits in shared folders carry their own account, and group hits stay apart (741f612, 0a68cd9).
- No Files error for a listing an account switch replaced (7dee928).
- Each account opens on its Inbox the first time it's shown; this is forgotten when every account signs out (ed30428, 2e8332f).
- Empty folder finds Trash and Junk by role or exact name only (a folder named "Robin" was treated as Trash), and reports partial runs (bb828c0, b0c69bb).
- A contacts load that an account switch overtook stays out of the new account (80ea6bf).

## Phase 6a: calendar (#7)

### Improvements
- Copy an event's title and add a note to it (dd1032d).
- Open a calendar date from a link (24094ae).
- Choose the identity that organizes new invitations (cceb0b0).
- Tasks show in the month view and the all-day strip, as in webmail (bbd390f).
- Choose the birthday calendar's colour (dcd2dc0).
- See attendees' free and busy times while planning an event (647739a).

### Fixes
- Every calendar write and load stays with its own account: the event detail sheet, duplicates, invitation replies, tasks, calendar edits and renames, reminders and event links (50629b5, 4f67d2d, 07916c5, c01b08c, fcca2d7, bdeaee5).
- An invitation's import, look-up and answer go over one connection (93b959d).
- The organizing identity is recognised as the user, and participants are kept on edit (0c87eea).
- Tasks are marked in the day list and kept out of the agenda; a double tap on the task circle is ignored (e87c616, bd05bd5).
- A note is saved without mailing it to the guests (4b05d08).
- The editor says when availability is being checked or couldn't be (cabf620).
- Settings show the address new invitations are organized as; identities reload after a switch and on a push (286f3aa, 3927b84, 042243f).
- The calendar and task widgets refresh for the account they ask for (e24baf2).
- A reminder's event isn't called missing when its read was dropped (3a4744d).
- The copied-title toast uses webmail's text (c29b91d).

## Hardening 1 (#6)

### Fixes
- One account's requests can never go out on another account's connection: the client swaps its whole connection at once, pins each operation to the connection it started on, and keeps rotated tokens through a failed switch (ae1d4c6, 7f2ad66, b1b4a36).
- Actions stay with the account they started in: the shown account's mail, queued changes, folder actions, the viewer, held sends, archive reorganising, read receipts, the replied flag, folder settings, scheduled sends, widget actions and quick reply (b8c68b5, 334b4c5, 34b1526, fb8ff08, 4d8e52e, 138a137, 8f34075, d9f0893, 2314d05, 13ee47f, 438f919).
- A calendar feed sync never writes into another account (9a6f6b3, db16f70).
- A non-active account's push filter is updated at renewal, through the same narrowing as the active one (01bccfd, 9a4a24a).
- A mail server that answers counts as online even when Android's internet probe fails; only the active connection counts, and a missing session keeps retrying (522b6be, dcfd480).
- Settings load once, and only the newest filter fetch is kept (c7a47b9).
- Sign-in edge cases: TOTP code fields clear after a failure, trailing dots, Unicode domains, and account matching on trimmed usernames and case-insensitive domains (d301036, 453ff7a).
- One strict `mailto:` parser, with case-insensitive schemes and the first valid unsubscribe target (8048e95).
- Clearer Outbox refusals, honest backoff and counts, and sends held for a missing account resume (10071e8).
- The selection is kept after a failed bulk action, a failed cross-account move is reported, and a bulk move can't run twice (0dd8123, 791aebc).
- A superseded session load is ignored, and the account switched to is never signed out (7656d6f).

## Phase 4b: rules and outbox (#5)

### Improvements
- Messages sent while offline are queued and sent when the connection returns, never twice; a send whose outcome is unknown waits for the user (bb3b795, 051d433, f516e9c).
- An Outbox shows queued, failed and uncertain sends (08919dc).
- Signing out asks first when there are unsent messages (9b75238).
- Filter rules from a message's senders, domain or mailing list, from the viewer or a selection (4416c9f, 568732b).
- The rule editor can be prefilled from a message; a saved rule can be undone or applied to existing mail (2d4d9e8, 16c785b, 4f680ec, cdfac42).

### Fixes
- Each queued send has its own row, and every change is serialised and checked (70309e5, e5b0c86).
- A message is resent only when the server proves it wasn't sent; only the user's own sent copy counts as proof, and the search for it reaches further back (b3e418d, 6bf2b98, 943f729, 9b4b0bf).
- A message already in the Outbox is never queued again, and a send is refused when the Outbox can't be checked (b6716e6, 6fb3125).
- Queued sends that can't go out are held with a reason (66f83db).
- No draft is kept for a message being sent; Outbox taps and a double tap in quick reply are guarded (feaaeb8, 28c5a29).
- Unsent messages are kept at sign-out unless the user deletes them, and a send in flight is named (eeb5e2a, 3cc0fe8).
- An entry goes back as failed when its draft can't be saved; "Send again" checks for proof first, rescans back off, and the sent draft is dropped (b418aab, 1cbe67e).
- Matching existing mail never shortens rule or header values, and its cost is bounded (28cb856).
- A rule is never applied or undone after switching account, and filter writes and draft saves re-check the account (79674f2, 7256acd).

## Phase 4a: features (#4)

### Improvements
- Verification codes in sign-in and confirmation mail are detected (2d3bfd5), with a copy chip in the list and the message (d0730ab).
- Notifications for Inbox mail only (964acb1).
- Sign in with an access token (c482c21).
- Copy messages to another folder or account (7700c2b).
- Recipient suggestions from the server's directory and from sent mail (d1a44c1).
- The app shows invitations the server delivered (2f383a8).
- Meeting links and map locations open from an event (f543b96).
- Day and week views can be limited to working hours and days (e05a85b).
- A crowded all-day strip collapses (710269b).

### Fixes
- Hostile HTML mail is checked in linear time, and the code search is bounded on huge subjects and previews (ac8e512, 2a37bb5, 7a06d9f).
- An Inbox-only change made during push setup is applied (a827c5c).
- Download and upload URLs that a server hosts on another domain are kept, for token sign-ins only (b110e03, 24b3598).
- The access token stays out of password managers, the account error is named, another account's server is never pre-filled, and a pasted token is told apart from an OAuth sign-in (8da72ac, 4ba2d28, 587c08b).
- A copy from the viewer uses the message's own account and says copy, not move, across accounts (6bd6058, d892d79).
- Recipient suggestions stay scrollable and on the composer's account; directory people for another account are ignored (143c99d, 5c820e8).
- Invitation notices fetched while switching are dropped, keyed by app account, and summarised in a burst (1bc623d, a65f52d).
- The all-day strip is sized from the days on screen (e2dfc6d).

## Phase 3: reliability (#3)

### Fixes
- Push subscriptions are renewed for every account before Stalwart's 7-day expiry, once a day, without prompting (3bd1d5f, bc62362).
- A notification shows even when the new mail can't be looked up; the generic notice goes only to the account the push was for (c3b7968, 0223de6).
- A burst of mail across accounts rings once (1c9b1a3).
- A failed list action shows a message (9e8fb8f).
- A failed search shows an error instead of the previous folder's mail, and one the user already left is ignored (86ca8bf, 7c3e9f9).
- Search leaves out Spam and Trash unless all folders are picked; "This folder" scopes a search, and Trash searches stay in Trash (954d28a, 9668eef).
- Tag views and counts leave out Trash and Spam (11d65fc).
- Moving from the list offers the message's own account's folders first (56475d7, de6765c).
- Mail deleted during a refresh no longer comes back (8501746).
- Accounts with two-factor sign-in can change their password and turn it off (1f10b84).
- Sign-in and address checks work on internationalized domains (badf664).
- A refused sign-in token is explained, and non-admins see their name on the security page (e09b84d, e4b4968).
- A sent copy that isn't filed is reported, and a write is never replayed after a dropped connection (89ca029).
- A calendar feed sync stops when the account changes underneath it (6a621ab).
- Offline mail left by accounts no longer signed in is cleared (bd57589).
- A vCard keeps its SOURCE when it also lists an organization directory (792009e).

## Phase 2: data correctness (#2)

### Improvements
- Copy a folder in Files with everything in it (138b041).

### Fixes
- Contacts' calendar links and vCard addresses are saved in the form Stalwart accepts; editing, moving or copying one link keeps the others (30c440a, b61f8dc, 45d2a66, df5cf93).
- An address book that still has contacts can be deleted (4cf81ad).
- A message moved to another account keeps its date (1636f44).
- An open draft never saves or sends into another account: its account is re-checked at every write, before sending, discarding or uploading, and the user can leave a draft whose account is gone (3c8c9f3, f5dfa6b, 75bf674, f341b2a, 5fa8908).
- Filters, the auto-reply and account security reload after an account switch (6c0335c, 95a1e9f).
- A daily series keeps going past a daylight-saving change (19882c0).
- Blank participant names are left out of invitations (60bcbce).
- Calendar subscriptions belong to the login that made them, show offline, and are adopted safely after a rename (b973902, b6cf458, b852b7b, 63d2097).
- Signing out forgets the account's offline mail, outbox, subscriptions and search history, keeps unsent changes, and clears shared data only with the last account; every cleanup step runs and failures are logged (5d389bb, 516b9fc, 7e68e0c, 0384107).
- When the server refuses to send invitations, the event can be saved without them, also for "this and following" edits (fd0104d, bea14b3).
- Files: a taken name gets a number, sharing and office file types work on every Stalwart version, and names are checked against the server's rules; Files refreshes after a failed copy (227f4a2, 83b8828, 3bd15f3, 7f33353).

## Phase 1: security and send (#1)

### Improvements
- The rule editor has an all-messages condition and address and domain matching (fd2f129).

### Fixes
- DKIM and DMARC results are taken only from the receiving server's own header, also when judging an invitation's sender, so a forged header can't fake a pass (f66084f, 0c07c68).
- An escaped quote stays inside a recipient's display name instead of splitting off an extra recipient (5f9812a).
- A send the server refused for every recipient fails, and an unconfirmed send is never called sent; refused recipients are named, the warning stays up longer, and refused addresses aren't trusted (600f355, e113118, e1c8b0c).
- The filter script escapes header names, sizes and rule names, a `*/` in a rule can't end the metadata comment, and a size must be a whole number with an optional K, M or G (2996c02, f11bfbd, c565dfe).
- Rules stop after a silent delete or reject, and webmail's all-messages and address rules are read correctly (f15be2c).
- A `mailto:` unsubscribe goes to one plain listed address, shown before sending (ef341b1, 31900f5).
- A crafted `winmail.dat` can no longer freeze the app (4d85f28).
