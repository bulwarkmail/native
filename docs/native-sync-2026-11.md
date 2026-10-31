# Native catch-up with webmail 1.19.1 and Stalwart 1.0.1 (2026-11)

Branch `catch-up-2026-11` from native main 7a42a15f (local main: 0.1.87 plus
the unpushed 9d547b9d and 7a42a15f). Latest release 0.1.86. This file holds
the inventory (Phase 0), the plan and decisions (Phase 1), then what landed
and how it was tested.

Inventory sources, all checked against native main 7a42a15f and webmail main
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

## Stalwart 1.0.1

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

## Leftovers

### Older parity files (01-10)

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

The policy route doesn't take a JMAP bearer token (app/api/admin/policy/route.ts:15,
lib/auth/instance-details.ts:23). Without a session it still answers the
global restrictions, feature gates, defaults and theme policy, and strips only
organisation data, scopes, plugins and push relays (route.ts:19-37). If the
app kept the webmail URL it gets at pairing or hand-off (src/lib/oauth.ts:292
parses it, nothing stores it), the global locks need no webmail change.

### Report "Open" (2026-10-29)

- [ ] **iOS: reader CSP, composer nonce, `target=_blank` taps, #81 keyboard** — `P2` — `partial` — needs an iOS run (e2e-ios.yml in testing step 4)
- [ ] **iOS push lapses after 7 days without opening the app** — `P2` — `bug` — the extension has no expiry handling (plugins/ios-push/NotificationService.swift), no BGTask; needs a device to verify
- [ ] **Login switch from a deep link or notification keeps the old navigation stack** — `P2` — `bug` — App.tsx:118-122, :141-145, :181-186 switch and navigate on top; question 7
- [x] **Sieve editor loses typed text (#1162)** — `P3` — `bug` — src/components/filters/SieveEditorSheet.tsx:35-41 re-seeds on every content change — fixed in 6c3046c8
- [x] **No forward limit (#1155, #1208), no vacation length warning** — `P3` — `missing` — FilterRuleModal.tsx:443-459, VacationSettings.tsx:140-142 — fixed in dcbfc907
- [x] **Other-zone daily series keeps a wrong recurrenceId on the device's DST day** — `P3` — `bug` — src/lib/recurrence-expansion.ts:526-536 builds candidates from device-local fields — fixed in 6e697baa
- [ ] **New strings English-only** — `P3` — `partial` — 331 overlay keys missing in 25 locales, 86 in de; question 6
- [ ] **Org policy, hand-off password** — blocked on the webmail (above)
- [ ] **`C:\ns` junction and the native-sync worktree still exist** — chore — C:\ns points at C:\Users\info\worktrees\native-sync (e6e5e521, on main)

### Webmail bugs from the 2026-10-29 report

All 19 are fixed in the app. In the webmail, 17 are still open at current
lines, one is fixed (invitation trust: failing DKIM beat dmarc=pass,
e1b43c894, dropped) and one is fixed except alerts the settings rows don't
show keep their old ids (lib/calendar-alerts.ts:206). The carried list with
current lines is in "Webmail bugs" at the end of this file.

### UX audit deferred (docs/ux-audit-2026-10.md)

- [x] **U-133 no way out of a hung "Signing in"** — `P2` — `missing` — src/screens/LoginScreen.tsx:218 swallows Back while busy, SigningInStep has no cancel; abortable sign-in, M — fixed in 55d008a2
- [ ] **U-069 recipient suggestions hidden in phone landscape** — `P2` — `missing` — needs a full-screen picker, M (feature)
- [x] **U-045 German Prev/Next read "Zurück"/"Weiter"** — `P3` — `bug` — override in locales/rn/de.json — fixed in 25f9b810
- [x] **Plain-text mail dark background fixed at #0a0a0a** — `P3` — `partial` — src/lib/email-html.ts:963 ignores the theme — fixed in 43973608
- [ ] **U-017 system alert vs Dialog, U-136 empty all-day strip, U-124 language order** — product calls, kept deferred unless you say otherwise
- U-016 scrim token: won't fix (no visible change). U-018 font scale resets navigation: React Native limitation. U-131: done (776447dd).

### iOS test deferred (docs/ios-test-2026-10.md)

- [ ] **Sign-in and features matrices empty; the last three release runs of e2e-ios failed** — `P2` — most failures miss seeded mail, so a reset and seed of stw-v016 comes first (testing step 4)
- [ ] **ios-perf branch never merged** (d13769a9, measured -18% to first inbox) — not part of this run unless you want it
- Blocked on a device or setup: real APNs path through the extension, QR scan with the camera, SSO pairing (needs an external IdP), discovery success (needs DNS records), iOS widgets (WidgetKit extension, L).
- Done: the six app bugs from the test (on main), the webmail hand-off fix 310f910a6.

### GitHub (bulwarkmail/native)

- Fixed on main, unreleased (close after 0.1.87 ships): #80, #82, #83, #84, #86, #87, #89. #81 is fixed in code (01983a38), unchecked on iOS.
- [x] **#91 multi-select without long press** — `P3` — `missing` — EmailListScreen.tsx:190-218; tap on the avatar toggles selection — fixed in 6715df7f
- [x] **#90 custom calendar colours** — `P3` — `missing` — CalendarEditSheet.tsx:222 offers the palette only — fixed in d3f6d6ae
- [ ] **#85 keep the shade open on Delete** — question 1
- [ ] **#58 PGP / S/MIME** — `P3` — L, not in this run
- [ ] **#3 TLS client certificates** — Android done in 0.1.83; iOS has none (L)
- [ ] **PR #66 unified views for a single account** (lucletoffe) — conflicts, no review, the author's question unanswered

## Dependencies

Expo SDK 54 (expo 54.0.33, React Native 0.81.5, React 19.1.0). Newest stable
is SDK 58 (React Native 0.88, React 19.3), four behind; SDK 54 still gets
patch releases.

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

## Test rig changes (VM 106)

- stw-rel moved from Stalwart 1.0.0 to 1.0.1 (servers.conf, backup
  servers.conf.bak-2026-10-31), reset and seeded with rel_setup.sh: 93 ok,
  0 failed.
- seed.py (backup seed.py.bak-2026-10-31): FileNode creates retry in the
  draft-18 shape (`@type`, `mediaType`) when the server asks for `@type` or
  refuses `type`; the TOTP login registers a public client with the data
  scopes on 1.0 and sends `query` and `consent: true`. Checked: TOTP login
  works on stw-v016 and stw-rel, and stw-rel seeds cleanly.
- stw-v016 is on 0.16.27, the newest 0.16. Not reset yet.

## Decisions (2026-10-31)

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

The shared userc@example.org test password showed up once in an emulator
agent's output (a missed tap typed it into the visible username field). It
was rotated on stw-v016, stw-v1 and stw-rel and in the vault on 2026-10-31.

## Plan

Wave 1 runs four agents with disjoint files. Wave 2 takes the larger
features and what depends on your answers. Dependency upgrades come last in
their own worktree. Rows not listed under "Not in this run" are in a wave.

### Wave 1

**reader** (mail reading and the list; owns src/components/email/** except
CalendarInvitationBanner and QuickReplyBox, EmailListScreen, EmailThreadScreen,
SenderAvatar, MoveSheet, SidebarDrawer, TagSheet, src/lib/email-headers.ts,
email-html.ts, attachment-display.ts, list-attachments.ts, avatar-utils.ts,
src/stores/email-store.ts, src/api/email.ts list properties, tag-counts.ts)

- Security: forged From shows a shield, not the photo or favicon (11, P2);
  favicons off by default (10, P2 after re-rating); blockquote freeze (10,
  P2); direction-override characters in attachment names (10, P2); DKIM
  `header.i` (11, P3).
- Mail: plain-text reading honours "Plain Text Only" plus a per-message
  switch (11, P2); body text size follows the app setting and font scale
  (11, P2); reduce motion and paused animated images in mail (11, P3); reply
  hidden on drafts and scheduled (11); report parts out of list chips (11);
  typed reader attachment icons (11); initials colour (11); search results
  into the open folder (11); MoveSheet icons by role (new); keyword undo
  (11); sort button (11); folder list selected state and unread label (11);
  #91 select by avatar tap; file 10 mail-list P3s (#1241, #1156, #1219,
  #1136, paperclip on inline-only, row growth, cold start folder, scroll
  position, folder deep link, "via" badge, quick reply off #1370); plain-text
  mail follows the theme's colours (UX audit).

**compose** (owns ComposeScreen, QuickReplyBox, src/components/compose/**,
TemplateSheet, src/lib/compose-*.ts, editor-html.ts, reply-compose.ts,
recipients.ts, placeholder-check.ts, identity/signature code)

- Quick reply runs the composer's checks (11); quoted history collapsed (11);
  new tag from the tag picker and Manage from the template picker (11); confirm
  before send (11, setting shared with reader's delete/archive confirms); alt
  text prompt (11); report parts not forwarded (11); file 10 composer P3s
  (signature swap on From change, plain-text part, composer prompts, schedule
  presets incl. "This morning"/"This afternoon" #1390, reply cursor, address
  autofill, recipient splitter, offline send message without the queue);
  04 group-account send row (verify against 31d8e4a4 first).

**calendar** (owns src/components/calendar/**, Calendar screens and stores,
src/api/calendar.ts, src/lib/calendar-*.ts, recurrence-expansion.ts,
CalendarInvitationBanner, contacts screens/stores/api, files screens/api,
src/components/filters/**, src/lib/sieve/**, VacationSettings)

- createCalendar merge (Stalwart, P2, live test); cancellation removes the
  meeting (11, P2); event and task editors ask before discarding (11, P2);
  calendar grid labels (11, P2); shared calendar server colour (11); #90
  custom colours; DST recurrenceId; file 10 calendar P3s (save without
  invitations, task moves #1204, working hours, week all-day, light colours,
  birthday colour, duplicate/export/copy, date deep links); contacts P3s
  (category delete, list filters, deep links, autocomplete groups and recent
  recipients 06 P2); files P3s (copy folders, numbered names, next/previous,
  deep links); Sieve P3s (forward limit, vacation length, editor text loss,
  size value, undo after deleting rules).

**platform** (owns src/components/Input.tsx, ToastHost, UndoSnackbar,
OfflineBanner, src/theme/**, SettingsScreen and src/components/settings/**
except VacationSettings, LoginScreen and src/screens/login/**,
src/lib/totp-login.ts, oauth*.ts, src/stores/auth-store.ts, App.tsx,
src/lib/push-*.ts, src/i18n/**, locales/**)

- Accessibility page with phone presets and a wider text size (11, P2);
  field names (11, P2); announcements on iOS and the Undo bar (11, P2);
  contrast of muted text with a test (11, P2); toast duration (11); TOTP
  prompt tone (11); same-name accounts and port (11, question 9); density
  sample (11); identity editor discard (11); U-133 cancel sign-in (P2);
  consentRequired (Stalwart); encrypt-on-upload copy (Stalwart); file 10
  account P3s (IDN, IdP end session, refused token exchange message);
  push extras (#1041 fallback notification P2, Inbox-only, one ring, re-check
  on return); quota softLimit #1242; capability check #1239; screenshot
  protection; Thai and Estonian, locale sync, German "du" strings, U-045.

### Wave 2

- **cards**: booking, parcel and order cards with calendar add/update (11, P2).
- **recovery**: recover deleted items #1319 and delegates (Stalwart 1.0).
- **search**: search snippets and size filter (10).
- Depending on your answers: nav reset (question 7), #85, MIG-02, the org
  policy with the kept webmail URL (and BIMI and help links behind it),
  translations, Stalwart live cases and the Maestro consent step (me).
- **deps**: approved upgrades, own worktree and node_modules, last.

### Not in this run (reason)

- Blocked on the webmail: hand-off one-time code, bearer-token policy route
  (session limits, org signature and disclaimer, external mail settings),
  settings sync on 0.16.
- Needs a device or setup this rig doesn't have: iOS push expiry in the
  extension, real APNs path, QR camera, SSO pairing, discovery success.
- Large features, each its own project: iOS widgets, PGP/S/MIME #58, iOS
  client certificates #3, dark mode recolour, offline send queue, free/busy
  and CalendarEventNotification, Jalali and Saturday week start, composer
  extras (priority, mentions, DSN), tag nesting and visibility, global search
  and mail folder sharing, U-069 landscape recipient picker, reading fonts,
  colour-blind palette, plain language, the Involved sound (new channel ids).
- Product calls kept as they are: U-017, U-124, U-136, U-018 (RN limitation).
- PR #66 and the ios-perf branch: outside this branch.

## Webmail bugs (carried forward, not fixed in the webmail)

Inline images of drafts and sent mail on 1.0 only from `attachments`
(components/email/email-viewer.tsx:2508; email-composer.tsx:953, :969, :1445,
:2669, :2703). Save to Files on 0.16 stores the whole message
(save-to-files-dialog.tsx:78-88). Blob/copy without the blob capability
(lib/jmap/client.ts:10047). Reschedule after a lost answer can strand or
double-send (client.ts:11686, :11706, :11721). Alerts the settings rows don't
show keep their old ids (lib/calendar-alerts.ts:206). Sieve parser drops
`elsif`/`else` and trailing comments (lib/sieve/parser.ts:251-263); generator
falls back to `header :contains` (lib/sieve/generator.ts:105, :126). Vacation
with a failed filter re-include only logs (stores/vacation-store.ts:206-210).
Feed sync without END:VCALENDAR check or mass-deletion guard
(stores/calendar-store.ts:1978). HELO SPF pass counts as aligned
(lib/email-headers.ts:64). Files trash: purge without a fresh read
(stores/file-store.ts:1947), restore with its folder lands at the root
(:1914), no `.Trash` name check (lib/file-name-rules.ts:78). Push: no device
client id check (lib/web-push.ts:788), cap path destroys first (:853),
refused relay URL shown raw (components/settings/notification-settings.tsx:180).
Probably: decoded CSS put back into STYLE (lib/email-sanitization.ts:613-740);
Lite refresh follows redirects (lib/auth/lite-tokens.ts:536, also :376, :399,
:467, :504). New in this pass: `consentRequired` reads as a wrong password
(lib/auth/stalwart-login-request.ts).
