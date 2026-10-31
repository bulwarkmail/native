# Native catch-up with webmail 1.19.1 and Stalwart 1.0.1 (2026-11)

Branch `catch-up-2026-11` from native main 7a42a15f: 327 commits (300
without merges, 27 merges of `cu-*` topic branches). Main on GitHub was
fast-forwarded to it so CI could run (decision 17), so origin/main is the
tip, 63357420. The version is still 0.1.87; no release is cut.

The run brought webmail 1.19.1 and Stalwart 1.0.1 into the app, closed most
leftovers of the earlier parity files, built the large features that had
waited for their own project (org policy, PGP and S/MIME, offline Outbox,
iOS widget and client certificates, global search, folder sharing, dark mode
recolouring, Jalali, free/busy) and translated every app string into the 28
languages besides English. CI (full vitest suite) is green at 63357420:
https://github.com/bulwarkmail/native/actions/runs/41226998363

Left: the results of the last full iOS e2e run and of the emulator recheck
(RESULT PENDING below), some policy and accessibility pieces (see Open), and
the webmail and website commits, which are merged locally but not pushed.

The inventory from the start of the run and the decisions follow the report.
The rows the run closed are ticked there and in docs/parity.

## What landed

### Wave 1: inventory fixes

- Reader and list (merge f643df81): forged senders get a warning shield
  instead of a photo 0b0fc021, favicons off by default 8e10e73e, blockquote
  freeze 3243714d, direction-override characters in attachment names
  a930d177, plain-text reading by setting or per message 7dc45778, body
  follows the text size 7b551fc3, reduce motion and paused GIFs 6d701c4b,
  plain-text mail in the theme's colours 43973608, select by avatar tap #91
  6715df7f, undo after list actions da1da0ec, sort button 1cbe28b1, search
  folder tree e5c9433a, and the file 10 mail list rows (#1241, #1156, #1219,
  #1136, #1138, #1235, #1370, via badge, cold start, folder links).
- Composer (0e69c86c to 73a6adf2): quick reply runs the composer's checks
  db8eb731, signature swap 60d0e98f, text part 0647cbf1, missing subject and
  Discard 1cc4ccca, schedule presets #1390 8fe5798b, reply caret 8bb7b607,
  recipient splitter ae2eb46b, offline message a43b55ec, reports left out of
  forwards 482e9a20, quoted history folded 9fd80993, template manager
  2c1f266f, alt text prompt 303dea01, confirm before send 0e69c86c.
- Calendar, contacts, files and filters (merge d9a759b7): new calendar keeps
  its name and colour a2344ea0, cancelled meeting removal a19afe9b, editors
  ask before discarding 10e9f81d, DST recurrence id 6e697baa, forward limit
  and vacation length dcbfc907, Sieve editor text 6c3046c8, custom colours
  #90 d3f6d6ae, save without invitations 9b5692a8, shared task moves #1204
  b6995bb6, contact filters 18c6b03f, folder duplicate a0f586f9.
- Platform (merge 470f12d2): cancel a hung sign-in (U-133) 55d008a2,
  accessibility page with presets and text sizes up to 200% c9b3bdfe, 4.5:1
  muted text 11522995, field names ff5a8c91, announcements on iOS d812caf0,
  consentRequired 1bef4719, IDN sign-in f5875f87, quota soft limit #1242
  af86339b, push fallback notification #1041 f6e6f8f5, Inbox-only push
  1821fda7, Thai and Estonian e8bc54eb, formal German 25f9b810.

### Wave 2

- Booking, parcel and order cards with calendar add and update, and Apple
  Wallet passes (merge 30e06315, mounted in 90e4e230).
- Search snippets 1342e2a0 and size filter aac8a403, live checks 12b798c0.
- Recover deleted mail #1319 113e96bd and delegates 8a5bb728 (merge
  3048525d).
- Follow-ups (merges cec68f0d, a4e5f81f, 7139390a): directory and Sent
  recipient suggestions a7a37573, undo after deleting rules, tags and
  trusted senders 8ac19971, IDN sending 4932764a, quick reply switch
  bb45198f, trash leads to recovery 7467764e, address book sharing 96b163a1,
  starred folders and recent files cad9296a, files next and previous
  e3fc67e7, calendar, contact and files links fe455370 ecefd1cb d684b00e,
  light event colours 01578ac2, week all-day area #1122 90ce7c1b.

### Emulator walkthrough fixes

A release APK at 7139390a was walked through on a phone and a tablet
emulator. Fixes:

- Calendar and sharing (merge 47b922ca): typed participant added once
  9ec58be4, all-day events stay all-day on 0.16 75513969, hex colour input
  826d5ad2, slot marker cleared 11fa0365, share sheet looks up a typed
  address 72b41eab, no principal ids shown as addresses 236e9117, widget tap
  opens the app without a chooser fe678174.
- Sheets and settings (merge 73823292): sheet buttons and fields above the
  taskbar and keyboard 426f7403 98024346, localized folder names in the rule
  folder picker 56c8b98b, scheduled out of office shown as scheduled
  9781b304, screen reader names and selected states e9816809 e7fd665b
  d6b9b342.
- Mail (merge f606866d): undo-send countdown d1c44f52, star undo ecf814b6,
  tag undo 9763036c, sender on search hits from Sent ff878fc6, Android reply
  keyboard 461e4da0, read state kept 9bc7b4a5, mail deleted elsewhere
  f2513de0, reader header scales with the text size ce21f273, tablet pane
  width e69bfc50.
- Direct fixes: sheets above the taskbar 9b0bba7c, TalkBack busy state
  350b0e8e, moved count 58c80543, shared address book names 423e2780,
  delegate server id b803da5d, unified views across ports 268b1105, id token
  kept on refresh ce950430, unified inbox row label 172d0f63, Saturday week
  start kept after a restart 10fb7ab7.

### Decided behaviour (merge 14ec671c)

- Two accounts on one host kept apart by port 688e8bef, also next to a kept
  host-only account 7b249ab9.
- MIG-02: an account whose sign-in stops working stays and asks to sign in
  again d0060549; a password change on a 0.16 TOTP account says so 149e5bce.
- A notification or link for another account starts the stack over on that
  account's inbox f9a36b28.
- #85: the notification Delete skips the unlock when the mail goes to Trash
  2fe83669, Android side 9669e07e.
- Sign-out ends the identity provider session 5a301d62.
- No crash when switching to an account left in Trash db717dcd.

### PR #66 and ios-perf

- PR #66 (lucletoffe): unified views for a single account, merged as
  5ecf6f32 (45b4feeb).
- ios-perf: modules and screens load on first use, and the cached inbox
  shows before the session arrives; merged as 36cc49b7 (0c8b8179, d13769a9,
  3424bcf2). Fast start kept (decision 19).

### Org policy and hand-off

- The app redeems a one-time code from the webmail instead of reading the
  sign-in from the link ab2e5a60.
- The app keeps the webmail it signed in through and applies its policy
  9d977773: locked and hidden settings f27e2ceb, hidden pages 1d654bbe,
  colour mode b7b3dd4c, themes a69bc071, external content 83981e8b,
  settings export df1e2117, tasks 8ba2f27a, archiving off efb92593
  13dcbdc0, delegates and recovery bc47c6a1, presets respect locks
  c66e6209, no third-party traffic and custom From d254d7b5, and the
  operator's help links in About.
- Org signature and disclaimer on new mail, templates hidden when off
  fe3f860e.
- BIMI logos from the webmail 83ddd137, shown in the list, the unified inbox
  and the reader 6b7e752c.
- @ mentions can be turned off, with a choice of where the contact goes
  ab226b03.

### Webmail and website changes

Merged into webmail main, not pushed (decision 3):

- fb3ba0275 feat: hand the mobile app a one-time code instead of the
  sign-in in its link
- f74ff49f5 feat: give the mobile app its organisation policy for its
  access token
- 3bdbdb136 docs: move the mobile hand-off contract to the website

Website repo (repos/website), local only: 7292593 documents the hand-off
code and the policy token in docs/development/mobile-handoff.md.

### Calendar extras (merge 66b4305e)

- Free/busy of invited participants in the event editor e6a89ad0.
- Invitations, changes and cancellations from CalendarEventNotification
  d663a5e2.
- Jalali months, days and dates for Persian f1297b6b.
- Involved sound for reminders b4f10829.

### Reading and accessibility (merge 6e5980e4)

- Dark mode recolours HTML mail instead of inverting it 23b2bf97.
- Reading fonts (Atkinson Hyperlegible Next, Lexend, OpenDyslexic) for the
  app and plain-text mail 4724c28f, on iOS too cfca6b9c.
- Colour-blind-safe palette for tags c6501ec8 and calendars 21dd5a24.
- Plain language in English and German 97b71e22.

### Native iOS and Android (merge 62a6c22f)

- Involved sound for new mail 6a27c596.
- iOS push renews itself when the app isn't opened for a week c704c7e6.
- TLS client certificates on iOS #3 ba150060, described the iOS way
  48a0590a.
- iOS inbox widget fbe54576.

### Compose extras (merge 609d36b0)

- Priority, delivery notifications (DSN) and REQUIRETLS 649d3adc, kept when
  a scheduled send moves 409ada94.
- @ suggestions in the message body 8389db8f.
- Full-screen recipient picker in phone landscape (U-069) e1ad5c09.
- Outbox for mail sent offline, sent once back online 0ec809eb.

### Tags, search and sharing (merge 0865c1d6)

- Nested tags and a choice of which tags the sidebar shows 585c70a5.
- Share a mail folder from its menu 417f1843.
- Global search over mail, contacts, events and files of every account
  f15b7bb3.

### Dependencies (decisions 10, 15 and 20)

- postal-mime 4.2 against crafted .eml headers 368c90ce.
- React Navigation 7.5, which drops its vulnerable URL and id helpers
  38257f81.
- zustand, jszip and vitest patch releases b2cd83b1; SDK 54 patch line and
  lockfile f9a3b761.
- Screenshot and recent-apps protection with expo-screen-capture 0ae33f3a.
- openpgp and pkijs 051f6bf2; react-native-quick-crypto provides WebCrypto
  instead of webcrypto-liner 4c818d64.

### PGP and S/MIME #58 (merge e5027c45)

- Read PGP and S/MIME mail and manage keys under Settings, Encryption
  8aa1d8e0.
- Sign and encrypt from the composer options b0997c0a.
- Live test between two accounts be98acdc; signed mail lists its
  attachments once 7a06ab03.
- Export compliance declared 5ead7a81 (usesNonExemptEncryption true).

### Translations (merge 3c0d7ad5)

German by hand 8345be43, the other 27 locales in six commits (cef88b93 to
a5b40d5a). A test catches the informal German "passe an" 2e90f431. The key
offer and already-sent messages were translated last 63357420.

### End-to-end flows (merge d9d7a466)

11 Maestro flows now follow the app's intended changes: open and select by
row, swipe target, compose options, cancel send, default reminders,
notification prompt, files delete, settings search, sign out above the tab
bar, camera pre-prompt, Safari's Next key. The consent page step came
earlier in 3769b24b.

### Fixes after the merges

- iOS pod install: the widget and the notification extension get their own
  copy of the shared keychain code 05bc0f56 (prebuild is idempotent again).
- Android 14 and later crashed at launch, because expo-screen-capture needs
  DETECT_SCREEN_CAPTURE and the manifest removed it d2d44e0d.
- CI: test updates 77914b0a 22893d32 e4295dab, account id check threw for
  saved accounts without a server b43472dd, share sheet loading state hidden
  from screen readers 7e60d324, duplicate import 9192311d, PKCS#1 v1.5 on
  newer Node 43bf8da7.
- Review fixes (merge b188c2db): PGP key planting 93c63070, no-Drafts send
  looked sent e2d4915e, notice after three unconfirmed attempts 1c33f8da,
  old favicon default on upgrade b1a0eaf8, Reply-To with a comma 1aba571a,
  Move to Drafts after send ac875ffe, retry during a flush 75213f6a, retry
  during a cached start 2c5d9518, iOS renewal ignored notUpdated 1194bf28.

## Testing

- CI (ci.yml, full vitest suite): green at 63357420. The failures on the way
  came from tests that read source and from Node differences, plus two real
  bugs (b43472dd, 7e60d324); all are fixed and listed above.
- Live suites at 7139390a: all 9 files pass on 1.0.1, and on 0.16.27 except
  one compose case on a dirty account, which passes on a clean one. Live
  cases added later and run on both servers: end session, all-day on 0.16,
  delegation with an unknown principal and share lookup, free/busy, event
  notifications, send options and moved scheduled send, send queue (also
  without Drafts), global search, mailbox share, PGP and S/MIME both ways.
- iOS e2e (e2e-ios.yml):
  - 41206960084 at 36cc49b7: build ok, signin-tablet pass, 6 legs failed,
    all from outdated flows or flaky; flows fixed in d9d7a466.
  - 41215412383 at 22893d32: pod install failed ("no parent for object
    SharedKeychain.swift"); fixed in 05bc0f56.
  - 41216860380 at 05bc0f56: build and signin-tablet pass, the first compile
    of the new Swift (push renewal, client certificates, widget).
  - 41220976434 at 43bf8da7, all legs, after a reset and seed of stw-v016:
    RESULT PENDING.
- Android release builds (x86_64, debug-signed) at 43bf8da7 and d2d44e0d:
  success. The emulator recheck found the Android 14 launch crash
  (d2d44e0d). Emulator recheck results: RESULT PENDING.
- quick-crypto on a real Hermes runtime, through the in-app self-test on the
  emulator: RESULT PENDING.
- Emulator walkthrough of 7139390a on a phone and a tablet: its bugs are
  under "Emulator walkthrough fixes".
- Code review (code-review skill, high) of 7a42a15f..43bf8da7: 10 findings,
  9 fixed (review fixes above). Not fixed: the org signature details are
  always empty (needs settings sync).

## Webmail bugs

Carried from the last report, still open in the webmail:

- Inline images of drafts and sent mail on 1.0 only from `attachments`
  (components/email/email-viewer.tsx:2508; email-composer.tsx:953, :969,
  :1445, :2669, :2703).
- Save to Files on 0.16 stores the whole message
  (save-to-files-dialog.tsx:78-88); Blob/copy without the blob capability
  (lib/jmap/client.ts:10047).
- Reschedule after a lost answer can strand or double-send
  (client.ts:11686, :11706, :11721).
- Alerts the settings rows don't show keep their old ids
  (lib/calendar-alerts.ts:206).
- Sieve parser drops `elsif`/`else` and trailing comments
  (lib/sieve/parser.ts:251-263); the generator falls back to
  `header :contains` (lib/sieve/generator.ts:105, :126).
- Vacation with a failed filter re-include only logs
  (stores/vacation-store.ts:206-210).
- Feed sync without END:VCALENDAR check or mass-deletion guard
  (stores/calendar-store.ts:1978).
- A HELO SPF pass counts as aligned (lib/email-headers.ts:64).
- Files trash: purge without a fresh read (stores/file-store.ts:1947),
  restore with its folder lands at the root (:1914), no `.Trash` name check
  (lib/file-name-rules.ts:78).
- Push: no device client id check (lib/web-push.ts:788), the cap path
  destroys first (:853), a refused relay URL is shown raw
  (components/settings/notification-settings.tsx:180).
- Probably: decoded CSS put back into STYLE
  (lib/email-sanitization.ts:613-740); Lite refresh follows redirects
  (lib/auth/lite-tokens.ts:536, also :376, :399, :467, :504).

New in this run:

- `consentRequired` reads as a wrong password
  (lib/auth/stalwart-login-request.ts).
- isValidEmail rejects Unicode domains.
- A bare /calendar/<date> link switches to the month view.
- Recent files are shared across accounts.
- Participant input: groups have an empty email, and onBlur adds the typed
  address (harmless on the web; it caused the app's double add).
- 49 keys were dropped in the settings reorg.
- A stale comment says Stalwart takes limit 0 as "no limit".
- lib/account-utils.ts generateAccountId drops the port, so two servers on
  one host collide (fixed in the app).
- hydrateExpandedOccurrences (lib/jmap/client.ts) and
  lib/recurrence-instances.ts skip one-off synthetic ids without a
  recurrenceId; on 0.16 one-off all-day events probably show as timed.
- components/settings/delegates/delegates-settings.tsx:182 shows the
  principal id as the "Unknown person" detail line.
- components/settings/share-collection-dialog.tsx has no lookup for a typed
  exact address.
- context_menu.items_selected has no singular.
- The filter-rule-modal.tsx folder picker shows server folder names, not
  the localized role names.
- thread-list-item.tsx listMailboxRole picks sender or recipient by the
  selected folder's role, so a search from Sent shows the recipient on Inbox
  hits (also the email-list.tsx column header).
- The components/search/search-chips.tsx size chip reads "Larger than (KB):
  1 KB".
- The mail-app.tsx undo-send toast doesn't count down (maybe intended).
- Jalali: the week view keeps Gregorian day numbers
  (calendar-week-view.tsx:498), and month navigation uses Gregorian
  addMonths (calendar-app.tsx:576-592).
- On 0.16 the event notification toast always says "Untitled event" (0.16
  doesn't return `event`).
- free-busy.ts says Stalwart 1.0 sets mayGetAvailability false with
  directory queries off; on 1.0.1 it's true.
- Reschedule and Send now (lib/jmap/client.ts ~11624-11640) drop the DSN and
  REQUIRETLS envelope parameters.
- composing-settings.tsx never passes `locked` for plainTextMode,
  autoSelectReplyIdentity and replyIdentityMatch; defaultReplyMode has no
  locked UI.
- The externalContentEnabled gate only hides the setting; the user's stored
  choice keeps applying (maybe intended).
- In the standard layout, Enter in the global search palette only saves the
  recent search and closes.
- Plugins (repos/plugins): smime extractKeyUsage reads ku.digitalSignature,
  but pkijs gives a BIT STRING, so every certificate with keyUsage ends up
  canSign and canEncrypt false; smime importPkcs12 takes the first
  certificate bag as the leaf; bulwark-gpg signerEmailFor compares primary
  key ids (subkey signatures show no signer), renderInnerMime drops the first
  paragraph of non-MIME inline PGP, and detect() searches the raw body, so it
  misses armor in QP or base64 parts.
- Catalog: mn uses "Харилцах утас" for Contacts and "Тэмдэгтүүд" for
  Identities and icons; ru has "Отменить изменения" where discard is meant.

Stalwart, not the webmail: on 0.16, ContactCard/query `{text}` doesn't find
a card whose name has only `full` set (1.0 does). With directory queries
off, 1.0 can't name a sharee or share by exact address over JMAP (DAV can).
The app explains this, and it goes to Stalwart (decision 18).

## Open

- Org signature details (title, department, phone, mobile) are always
  empty: the app has no form for them and settings sync is blocked.
- Group-identity policy scopes (webmail policyForSender) aren't ported; the
  app uses the active account's policy.
- The composer still offers the custom From sheet when customFromEnabled is
  off (the webmail hides it).
- No-third-party mode counts as off until /api/config is read (the webmail
  treats it as on until then).
- The Android home-screen widget still shows Archive when the organisation
  turns archiving off (src/widgets/layouts/mail.tsx, src/widgets/actions.ts).
- Mailbox sharing: the admin's sharingRights don't hide the write presets
  yet.
- Policy pieces not built: idle sign-out and session length, the external
  sender chip, the external recipient confirm.
- PGP: Argon2-protected keys get a clear error (no WebAssembly on Hermes).
  S/MIME RC2, DES, Camellia and AES-CCM content and legacy RC2 .p12 files
  get a banner or an error. No WKD (the plugin has none). Drafts stay
  unencrypted on the server, as in the webmail.
- iOS: the Swift for client certificates, push renewal and the widget
  compiled in CI but never ran on a device; reading fonts on iOS are
  untested. The widget needs the App ID org.bulwarkmail.mobile.Widget and the
  secret IOS_WIDGET_PROVISIONING_PROFILE_BASE64 in release-ios.yml; until
  then signed releases leave it out. The iOS minimum is now 16.4
  (quick-crypto and Nitro).
- The APK is about 10 MB bigger per ABI (libQuickCrypto).
- Nested tags: renaming or moving a tag with its messages, and reordering,
  aren't ported.
- Global search: other logins' file listing is capped at about 500 items;
  the Pro search tab and saved searches aren't ported.
- Jalali: Android's native date pickers and the widgets stay Gregorian.
- Accessibility rows done only in part: no text spacing, more contrast or
  underlined links; no names next to colours; no explanations for technical
  terms; no default compose font; the text size still reaches only some
  screens.
- Composer extras not built: numeric date placeholders, font size, pasted
  lists. BIMI shows no verified-mark check.
- An expired session still drops an open composer without saving it.
- Still open from earlier: run a rule on a folder, one ring per message
  (#1141), settings sync on 0.16, background reminder refresh without device
  sync, the real APNs path, QR scan with the camera, SSO pairing, discovery
  success.

## Test rig changes (VM 106)

- servers.conf: stw-rel on stalwartlabs/stalwart:v1.0.1 (backup
  servers.conf.bak-2026-10-31), reset and seeded with rel_setup.sh: 93 ok,
  0 failed.
- seed.py (backup seed.py.bak-2026-10-31): FileNode creates retry in the
  draft-18 shape (`@type`, `mediaType`); the TOTP login registers a public
  client with the data scopes and sends `query` and consent.
- register-mobile-client.py registers the first-party bulwark-mobile OAuth
  client on a 1.0 server (run on stw-rel).
- rotate-user.py rotates one test user's password on all servers and in the
  secrets. userc was rotated on 2026-10-31 after an emulator agent exposed
  it once (it was typed into the visible username field), and the vault item
  is updated. Secrets backup: secrets-bak-2026-10-31.tgz (without the
  root-owned pushtest.json).
- stw-v016 (0.16.27) was reset and seeded twice, before each full e2e run.
  The 0.16 admin password is regenerated each time and kept in the vault
  item "Stalwart test – admin (0.16)".

## New questions

1. Dutch: the overlay mixes "je" (catalog) and "u" (older app strings).
   Sweep it to one form, and which one?
2. English source strings the translator flagged. Fix them in one pass?
   Title Case strings (files.settings_*, settings.vacation.date_range.title,
   settings.vacation.message.title, widgets.vacation.title "Vacation
   Responder" vs "Out of office"), a UK/US spelling mix, `one` branches
   without # (contacts.import.updated_count,
   files.trash_unavailable_message), "{count} days" without a plural
   (calendar.views.n_days, settings.offline.keep_days), fragments
   (settings.offline.keep_from, use_at_most), a {service} case problem
   (settings.privacy.push), a bare {count}
   (settings.keywords.discover.found), identical one/other branches
   (widgets.calendar.more_this_week, unit_minutes,
   widgets.draft.edited_minutes), misnamed keys
   (email_composer.read_receipt_off, widgets.mail.in_outbox), stale "Android
   only" push texts (settings.notifications.push.err_android_only,
   status_android_only), the licences_desc wording, desktop words ("Click",
   "the drawer"), and " - " next to "—".
3. ios-perf: re-measure the start time on the bench rig now that it's
   merged?
4. Push the webmail commits (fb3ba0275, f74ff49f5, 3bdbdb136) and the
   website commit (7292593)? The app's hand-off code and policy need the
   webmail ones on the server.
5. iOS widget: create the App ID org.bulwarkmail.mobile.Widget and add the
   IOS_WIDGET_PROVISIONING_PROFILE_BASE64 secret?
6. Export compliance: with usesNonExemptEncryption true, App Store Connect
   asks for documentation on the next upload. Who files it?

## Leftovers on disk

- Junctions the permission check wouldn't let agents remove: C:\cn
  (dangling), C:\cd, C:\cp; scratch folder C:\cn-iosfix.
- Folders Windows wouldn't delete (already unregistered from git):
  C:\Users\info\worktrees\react-native-cu-deps and react-native-cu-pgp
  ("Filename too long", each with its own partial node_modules), and the
  empty locked folders react-native-cu-calcon, -cu-calendar2, -cu-followup,
  -cu-platform and -cu-compx.
- Kept on purpose: C:\ns and C:\Users\info\worktrees\native-sync (decision
  14), C:\Users\info\worktrees\react-native-cu-build (the build worktree
  with local-only patches, removed at the end of the run) and the C:\cu
  junction to it.

## Inventory (Phase 0, 2026-10-31)

Written before the fixes; rows closed since are ticked with their commits.
Sources, all checked against native main 7a42a15f and webmail main
4887ed457:

- Webmail 1.19.0, 1.19.1 and the 237 commits since 2026-10-29:
  docs/parity/11-webmail-1.19.md (42 rows, 11 P2, 31 P3). 1.19.1 is the
  latest webmail release; the changelog has no Unreleased section.
- Stalwart 1.0.1 (2026-10-28, the latest release): below.
- Leftovers: the unticked rows of docs/parity/01-10, the "Open" and webmail
  bug lists of docs/native-sync-2026-10-29.md, the deferred items of
  docs/ux-audit-2026-10.md and docs/ios-test-2026-10.md, open issues and PRs:
  below.
- Dependencies: below.

### Stalwart 1.0.1

v1.0.0...v1.0.1 is one squashed commit. Two release-note lines read the wrong
way round: the "Fixed" JMAP lines describe the old bug. 1.0.0 answered a
Mailbox, AddressBook, ContactCard or Identity create with only `{id}`; 1.0.1
adds the server-set and defaulted properties the client left out (plus
myRights, mayDelete, isDefault). Calendar adds description, color and
timeZone as null and an empty shareWith when omitted; CalendarEvent adds
isDraft, useDefaultAlerts, mayInviteSelf, mayInviteOthers and hideAttendees.
Every native create caller reads only the id, re-reads, or merges the reply
over what it sent (createMailbox src/api/email.ts:284, createAddressBook
src/api/contacts.ts:352, createContact :263-275, createIdentity
src/api/identity.ts:39-41, createEvent src/api/calendar.ts:1080, device sync
src/device-sync/engine/item-sync.ts:1287-1312), except createCalendar.

Moving stw-rel to 1.0.1 surfaced two seed failures that looked like 1.0.1
changes. Neither is: both behave the same on 1.0.0, and the app sends what
both versions want.

- FileNode creates need `@type` (`File`/`Directory`/`SymLink`) and
  `mediaType` on the released 1.0.x; `nodeType` and `type` are refused. The
  app sends that shape whenever the account capability lists
  `supportedNodeTypes` (src/api/files.ts:67-72, :420-428, every create goes
  through createFileNodeIn :441-460). The seed script's fallback was written
  for the pre-release stw-v1 build, which still takes the old shape.
- `/api/auth` answered 400 "JSON deserialization failed" to the seed's 0.16
  body: 1.0.x requires `query`. The app's body (src/lib/totp-login.ts:296-321)
  carries `query` and `consent: true`; probed on 1.0.1 it deserializes and
  gets as far as the client check.

Findings:

- [x] **A new calendar lands in the store without its name and colour** — `P2` — `bug` (also on 1.0.0) — fixed in a2344ea0
  - What Stalwart does: the Calendar/set create answer never echoes properties the client sent (crates/jmap/src/calendar/set.rs:1307-1367).
  - What RN does: createCalendar returns `created` alone (src/api/calendar.ts:1269) and the store inserts it (src/stores/calendar-store.ts:1415-1423), so the calendar shows nameless and colourless until the next fetch.
  - Fix hint: `{ ...props, ...created }`, as createEvent does. Live test in live-stalwart-calendar.

- [x] **iOS Maestro OAuth flows have no step for the consent page** — `P2` — `test` — fixed in 3769b24b
  - What Stalwart does: on 1.0.1 the consent page comes after Sign in, once per client grant ("Allow"/"Deny", login.html:462-463), for every client that isn't a Stalwart-installed Application, `bulwark-mobile` included.
  - What RN does: .maestro/subflows/stalwart-login-page.yaml types and taps Sign in, then inbox.yaml waits for the tab bar. The app doesn't depend on the order (oauth-native.ts never sends `prompt=consent`). The iOS e2e server (`vars.E2E_SERVER`) is the 0.16 server, so CI isn't affected today.
  - Fix hint: optional `runFlow when visible "Allow"` tap at the end of the subflow.

- [x] **A `consentRequired` answer reads as a wrong password** — `P3` — `bug` — fixed in 1bef4719
  - What Stalwart does: new answer `{type:'consentRequired', token}` and request `{type:'authConsent', token, query, consent}` in 1.0.1.
  - What RN does: readStalwartLoginResponse maps it to invalid credentials (src/lib/totp-login.ts:344-380). Not reachable while `consent: true` is sent. The webmail has the same gap (lib/auth/stalwart-login-request.ts).
  - Fix hint: answer it with `authConsent` and the same query, or a clear error.

- [x] **The encrypt-on-upload copy no longer matches the server** — `P3` — `docs` — fixed in 853cb5d0 (comment; the live compose check is not written)
  - What Stalwart does: 1.0.1 stores JMAP `$draft` messages and the Sent copy unencrypted (crates/email/src/message/ingest.rs:608-611).
  - What RN does: no workaround for encrypted drafts; the comment at src/api/account-security.ts:249-254 says sent mail is encrypted too.
  - Fix hint: fix the comment; a live check in live-stalwart-compose that a draft and the Sent copy read back as text with encryption on.

No action: registry listings now return only the requested account (an admin
login no longer sees other accounts' keys, src/api/account-security.ts:299-307);
the iTIP PRIORITY fix (RSVP is a participationStatus patch); the
FORGED_RCVD_TRAIL fix lowers spam scores the app shows; `denyLocation` left
GET /api/auth/client (the app reads only `error`); telemetry, ACME, RocksDB,
WebUI and installer changes.

### Leftovers

#### Older parity files (01-10)

95 unticked rows: 77 still open, 3 done but unticked, 7 blocked, 8 not to
do. About 15 of the 24 open rows in 01-09 duplicate a file 10 row. The four
commits after file 10 close none.

- Done, to tick: templates sync on Stalwart 1.0 (04, fac318dc; 0.16 still
  needs settings sync), calendar strings (05, 84fef142), iOS push (08,
  f62849d1).
- Not to do, reasons kept from the rows: identity visibility refresh (04),
  S/MIME send stub (04, see #58), component set on new calendars #760 (05),
  push without CalendarEvent types (05), legacy flat-name migration (07),
  stability banner (07), status bar theming (08), sharing before 0.16.6 (10,
  below the app's minimum).
- Blocked on the webmail: hand-off password in the fragment, org policy,
  session limits, external sender chip, external recipient confirm, org
  signature and disclaimer (10), settings sync (08).
- Priority changes: up to P2 the DuckDuckGo favicons (leak every sender
  domain and the device IP, on by default, src/lib/avatar-utils.ts:149,
  src/stores/settings-store.ts:312), the blockquote freeze, direction-override
  characters in attachment names, and no notification when the push lookup
  fails (#1041). Down to P3 the 09 offline-send row (same item as 04 and 10).
- New: the move sheet still picks icons by folder name
  (src/components/MoveSheet.tsx:20-28), the #1235 bug 96c7c045 fixed in the
  sidebar. The recipient splitter row also covers pasting into the composer.
- Status at the end of the run: the four P2 re-ratings are fixed (8e10e73e,
  3243714d, a930d177, f6e6f8f5), the move sheet icons too (a4d38911), and
  the S/MIME send stub is replaced by real sending (b0997c0a). Of the
  webmail-blocked rows, the hand-off code and the org policy, signature and
  disclaimer are built; session limits, the external sender chip and the
  external recipient confirm are not.

The policy route doesn't take a JMAP bearer token (app/api/admin/policy/route.ts:15,
lib/auth/instance-details.ts:23). Without a session it still answers the
global restrictions, feature gates, defaults and theme policy, and strips only
organisation data, scopes, plugins and push relays (route.ts:19-37). If the
app kept the webmail URL it gets at pairing or hand-off (src/lib/oauth.ts:292
parses it, nothing stores it), the global locks need no webmail change.
Built since: the app keeps the webmail URL, and the webmail takes the app's
token for the organisation policy (f74ff49f5, not pushed).

#### Report "Open" (2026-10-29)

- [ ] **iOS: reader CSP, composer nonce, `target=_blank` taps, #81 keyboard** — `P2` — `partial` — needs an iOS run (e2e-ios.yml in testing step 4) — partly: the iOS build and the tablet sign-in leg pass at 05bc0f56 (run 41216860380); the full run 41220976434 is RESULT PENDING
- [x] **iOS push lapses after 7 days without opening the app** — `P2` — `bug` — the extension has no expiry handling (plugins/ios-push/NotificationService.swift), no BGTask; needs a device to verify — fixed in c704c7e6 (compiled in CI, not run on a device)
- [x] **Login switch from a deep link or notification keeps the old navigation stack** — `P2` — `bug` — App.tsx:118-122, :141-145, :181-186 switch and navigate on top; question 7 — fixed in f9a36b28
- [x] **Sieve editor loses typed text (#1162)** — `P3` — `bug` — src/components/filters/SieveEditorSheet.tsx:35-41 re-seeds on every content change — fixed in 6c3046c8
- [x] **No forward limit (#1155, #1208), no vacation length warning** — `P3` — `missing` — FilterRuleModal.tsx:443-459, VacationSettings.tsx:140-142 — fixed in dcbfc907
- [x] **Other-zone daily series keeps a wrong recurrenceId on the device's DST day** — `P3` — `bug` — src/lib/recurrence-expansion.ts:526-536 builds candidates from device-local fields — fixed in 6e697baa
- [x] **New strings English-only** — `P3` — `partial` — 331 overlay keys missing in 25 locales, 86 in de; question 6 — fixed in 3c0d7ad5 (German by hand in 8345be43, the other locales in six commits after it)
- [ ] **Org policy, hand-off password** — blocked on the webmail (above) — partly: hand-off code in ab2e5a60, organisation policy in 9d977773; group-identity scopes, session limits, the external sender chip and recipient confirm, and the org signature's user details are not done
- [ ] **`C:\ns` junction and the native-sync worktree still exist** — chore — C:\ns points at C:\Users\info\worktrees\native-sync (e6e5e521, on main) — kept on purpose (decision 14)

#### Webmail bugs from the 2026-10-29 report

All 19 are fixed in the app. In the webmail, 17 are still open at current
lines, one is fixed (invitation trust: failing DKIM beat dmarc=pass,
e1b43c894, dropped) and one is fixed except alerts the settings rows don't
show keep their old ids (lib/calendar-alerts.ts:206). The carried list with
current lines is in "Webmail bugs" above.

#### UX audit deferred (docs/ux-audit-2026-10.md)

- [x] **U-133 no way out of a hung "Signing in"** — `P2` — `missing` — src/screens/LoginScreen.tsx:218 swallows Back while busy, SigningInStep has no cancel; abortable sign-in, M — fixed in 55d008a2
- [x] **U-069 recipient suggestions hidden in phone landscape** — `P2` — `missing` — needs a full-screen picker, M (feature) — fixed in e1ad5c09
- [x] **U-045 German Prev/Next read "Zurück"/"Weiter"** — `P3` — `bug` — override in locales/rn/de.json — fixed in 25f9b810
- [x] **Plain-text mail dark background fixed at #0a0a0a** — `P3` — `partial` — src/lib/email-html.ts:963 ignores the theme — fixed in 43973608
- [ ] **U-017 system alert vs Dialog, U-136 empty all-day strip, U-124 language order** — product calls, kept deferred unless you say otherwise — kept (decision 12)
- U-016 scrim token: won't fix (no visible change). U-018 font scale resets navigation: React Native limitation. U-131: done (776447dd).

#### iOS test deferred (docs/ios-test-2026-10.md)

- [ ] **Sign-in and features matrices empty; the last three release runs of e2e-ios failed** — `P2` — most failures miss seeded mail, so a reset and seed of stw-v016 comes first (testing step 4) — partly: stw-v016 reset and seeded, 11 outdated flows fixed in d9d7a466, pod install fixed in 05bc0f56; the full run is RESULT PENDING
- [x] **ios-perf branch never merged** (d13769a9, measured -18% to first inbox) — not part of this run unless you want it — fixed in 36cc49b7
- Blocked on a device or setup: real APNs path through the extension, QR scan with the camera, SSO pairing (needs an external IdP), discovery success (needs DNS records), iOS widgets (WidgetKit extension, L). The iOS widget is built since (fbe54576), compiled in CI only.
- Done: the six app bugs from the test (on main), the webmail hand-off fix 310f910a6.

#### GitHub (bulwarkmail/native)

- Fixed on main, unreleased (close after 0.1.87 ships): #80, #82, #83, #84, #86, #87, #89. #81 is fixed in code (01983a38), unchecked on iOS.
- [x] **#91 multi-select without long press** — `P3` — `missing` — EmailListScreen.tsx:190-218; tap on the avatar toggles selection — fixed in 6715df7f
- [x] **#90 custom calendar colours** — `P3` — `missing` — CalendarEditSheet.tsx:222 offers the palette only — fixed in d3f6d6ae
- [x] **#85 keep the shade open on Delete** — question 1 — fixed in 2fe83669 (the Android side in 9669e07e)
- [x] **#58 PGP / S/MIME** — `P3` — L, not in this run — fixed in e5027c45 (reading 8aa1d8e0, sending b0997c0a; no Argon2 keys, WKD or legacy S/MIME ciphers)
- [x] **#3 TLS client certificates** — Android done in 0.1.83; iOS has none (L) — fixed in ba150060 (compiled in CI, not run on a device)
- [x] **PR #66 unified views for a single account** (lucletoffe) — conflicts, no review, the author's question unanswered — fixed in 5ecf6f32 (the author's 45b4feeb)

### Dependencies

Expo SDK 54 (expo 54.0.33, React Native 0.81.5, React 19.1.0). Newest stable
is SDK 58 (React Native 0.88, React 19.3), four behind; SDK 54 still gets
patch releases.

Done in this run: every "On SDK 54 now" upgrade below (368c90ce, 38257f81,
b2cd83b1, f9a3b761), plus expo-screen-capture, openpgp, pkijs and
react-native-quick-crypto. npm audit on 2026-10-31 at the tip: 30 findings
(2 high, 27 moderate, 1 low, no critical), down from 53. The two highs are
postcss and image-size, both pulled in by Expo's build packages; the
postal-mime and React Navigation chains are gone.

npm audit: 53 findings (2 critical, 17 high, 32 moderate, 2 low). Three chains
ship in the app:

- postal-mime 3.0.0, high, reachable: quadratic CPU on RFC 2047 headers; the
  app parses .eml attachments and embedded messages with it
  (src/components/email/use-body-override.ts). Fixed in 4.0.8+; the webmail
  moved to postal-mime 4 on 2026-10-29 (4aea0976a). The local patch
  (Blob from typed arrays) has to be redone for 4.2.0.
- query-string/decode-uri-component and nanoid via React Navigation, high,
  not reachable (no `linking` prop; default nanoid size). React Navigation
  native 7.5.1 drops them.

The rest (both criticals included: tar, shell-quote) sit in Expo CLI, Metro,
the dev server or vitest and run only on dev machines and CI; a lockfile
refresh within current ranges clears most.

Upgrades:

- On SDK 54 now: postal-mime 4.2.0 (redo the patch; fixes the advisory, risk:
  the RN Blob path, covered by src/lib/__tests__/postal-mime-rn.test.ts),
  @react-navigation native 7.5.1 with native-stack and bottom-tabs 7.21.0
  (drops two advisories, risk: navigation regressions, needs the emulator
  walk), zustand 5.0.16, jszip 3.10.2, vitest 4.1.12, the SDK 54 patch line
  (expo 54.0.38, expo-file-system 19.0.24, expo-image-picker 17.0.11,
  expo-localization 17.0.9), lockfile refresh.
- With an SDK bump (its own project): SDK 58 means Gradle 9 and AGP 9 hand
  edits in android/, removing newArchEnabled/edgeToEdgeEnabled, Node 22 in
  six workflow lines, iOS 16.4 minimum, Expo's fetch replacing the global
  fetch (SDK 56), async File.write (StorageSettings.tsx:105,
  use-file-preview.ts:75), foreground notifications shown by default
  (calendar-notifications.ts), react-native-webview 14 (mail body and
  composer), react-native-android-widget 0.26 (the #52 patch can probably
  go). SDK 57 first keeps AGP 9 as its own step.
- Skip: AsyncStorage 3, TypeScript 7, vitest 5.

## Decisions

Taken on 2026-10-31, before the fixes:

1. #85: Delete from the notification skips the unlock only when the account
   has a Trash; without one the unlock stays.
2. Org policy: store the webmail URL from pairing or hand-off and apply the
   global policy now.
3. Webmail changes: yes. The hand-off one-time code and a policy route that
   takes the app's token get built in the webmail repo too.
4. MIG-02: keep the account and ask to sign in again; same for an expired
   pasted token.
5. TOTP password change on 0.16: show a clear "sign in again" message.
6. Translations: German by hand, the other 25 locales by an agent.
7. Notification or deep link switching the account resets the navigation.
8. The four small behaviours stay as they are.
9. Port in the account switcher: always when it isn't the default.
10. Dependencies: the SDK 54 updates now (postal-mime 4.2, React Navigation
    7.5.1, patch updates, SDK 54 patch line, lockfile). SDK 58 is separate.
11. The large items formerly under "Not in this run": all of them, by agents,
    on this branch after the fixes.
12. U-017, U-124, U-136, U-018 stay as they are.
13. PR #66 and the ios-perf branch: take both.
14. C:\ns and the native-sync worktree stay on disk.
15. Screenshot protection: yes, with the dependency install.
16. End the identity provider session at sign-out: yes.
17. CI: push to main.

Taken during the run:

18. Stalwart 1.0 sharing with directory lookups off: explain it in the
    app and report it to Stalwart; no DAV path.
19. ios-perf fast start kept. Risk: an action in the first round trip
    after launch on a just-replaced server can go out with old ids.
20. Dependency install approved, then `npm ci` in the main checkout (twice:
    after the dependency updates and after quick-crypto).
21. PGP and S/MIME crypto through react-native-quick-crypto;
    webcrypto-liner removed (it couldn't do the job and pulled an elliptic
    fork over git+ssh with a critical audit finding).
22. iOS minimum 16.4, usesNonExemptEncryption true and the bigger APK
    accepted.
