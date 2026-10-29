# Android widgets: verification checklist

Every tap target of the 32 Android home-screen widgets (`src/widgets/`), how
it was tested on the emulator, and what happened. Started for the report
"widget actions sometimes don't work" (#52 follow-up).

## Rig

- Emulator `Bulwark_Pixel7_API35` (Pixel 7, Android 15, x86_64), Pixel
  launcher, release APK built with `-PreactNativeArchitectures=x86_64`.
- Servers: the standing test servers, Stalwart 0.16 (`stalwart-test`) and
  1.0 (`stalwart-test-v1`), reached through a logging reverse proxy that
  records every JMAP method, `notUpdated`/`notCreated` and errors, and can
  delay or fail chosen methods on request.
- Accounts: `usera@example.org` (password) and `userb@example.org` (OAuth
  through Stalwart's own authorization server) signed in at once. Both are
  members of the `team@` group; `usera`'s calendar is shared with `userb`.
  Extra test data: tasks for both, invitations each way through server-side
  scheduling.
- Placed: Triage, Tasks, Invitations (others in phase 3).

## States

| Code | State | How |
|---|---|---|
| FG | App on screen when the link arrives | `am start` of the link while the app is in front |
| BG | App backgrounded, JS runtime alive | Home after using the app |
| COLD | Process dead | `adb root`, `kill -9 <pid>` (not `am kill`, not `force-stop`) |
| OFF | Offline | `cmd connectivity airplane-mode enable` |
| ACC2 | Item belongs to the non-active account | the other account active in the app |
| SHARED | Item in a shared or group account | `usera`'s calendar seen by `userb` |
| DBL | Two taps in quick succession | `input tap` twice, 150 ms and 1–1.5 s apart |
| UPD | Tap while a refresh is running | proxy delays `Email/set` by 4 s, second tap meanwhile |

A widget tap cannot happen with the app in front, so FG applies to deep
links only. Links were opened with `am start -a VIEW -f 0x10000000`, which is
exactly what the widget provider does (`RNWidgetProvider.openUri`); the
widget's own Reply, card and event taps were also tapped on the launcher.

## Phase 1 results (before fixes, Stalwart 0.16)

### Background actions

| Action | Widgets | BG | COLD | OFF | ACC2 | DBL | UPD | Notes |
|---|---|---|---|---|---|---|---|---|
| archive | Triage | pass | pass | **fail** | n/a | **fail** | **fail** | see A1, A2, A3 |
| trash | Triage | pass | pass | **fail** | n/a | **fail** | **fail** | same code path as archive |
| triageNext | Triage | pass | pass | pass | n/a | pass | pass | local only |
| rsvp | Invitations | pass | pass | **fail** | **fail** | **fail** | **fail** | A1, A3, A4, A5 |
| toggleTask | Tasks, Today overview | pass | pass | **fail** | **fail** | **fail** | **fail** | A1, A3, A4, A5, A6 |
| markRead | (no button uses it) | – | – | – | – | – | – | kept for the API |
| any button | all | pass* | pass* | – | – | – | – | *on this emulator; A0 |

### Deep links (`links.*` in `src/widgets/clicks.ts`)

| Link | Used by | FG | BG | COLD | OFF | ACC2 | Notes |
|---|---|---|---|---|---|---|---|
| inbox | Inbox, Unread count, Folder counts, Tag, Attachments, Mail and next, Today overview | pass | pass | pass | pass | n/a | |
| message | Inbox/Starred/All accounts rows, Latest message, Triage card, Mail and next, Attachments | pass | pass | pass | **fail** | pass online | L4 |
| reply | Triage | **fail** | **fail** | **fail** | **fail** | **fail** | L1 |
| draft | Last draft | pass | pass | pass | **fail** | pass online | L4 |
| unified (all / starred / role) | All accounts, Starred, Folder counts, Last draft | pass | pass | pass | not run | n/a | |
| scheduled | Outbox, Folder counts | pass | pass | pass | not run | n/a | |
| search (empty / query) | Inbox, Search mail, Favourite people | pass | pass | pass | not run | n/a | empty search opens the list without focusing the field |
| compose (plain) | Inbox, Last draft | pass | pass | pass | pass | n/a | |
| compose with to + subject | Birthdays "Send wishes", Up next "Running late" | **fail** | **fail** | **fail** | **fail** | n/a | L2 |
| calendar | all calendar and plans widgets | pass | pass | pass | **crash** | n/a | L3 |
| event | Week, Month, Today, Next event, Up next, Countdown, Invitations, Mail and next | **fail** | pass | pass | **crash** | **fail** | L3, L5 |
| contacts | Shortcuts, Favourite people, Birthdays | pass | pass | pass | not run | n/a | |
| files | Shortcuts, Recent files | pass | pass | pass | not run | n/a | |
| settings/vacation, /account, /calendar | Vacation, Storage, Free time, Tasks (off) | pass | pass | pass | not run | n/a | |
| video URL | Up next "Join" | – | – | – | – | – | external https link, opens the browser |

### Refresh

| Case | Result | Notes |
|---|---|---|
| App goes to the background | **fail** (sometimes) | R1 |
| Account switched in the app | **fail** | R1: widgets kept the previous account until the next app start |
| Cold periodic update | pass for mail | R2: calendar, tasks, files, scheduled stay as last loaded by the app |
| Back online after an offline tap | **fail** | A1: nothing brings the change back until the app or a 30-minute update runs |

## Causes found

- **A0. Buttons silently dead on fast phones.** The widget library registers
  every button's `PendingIntent` with `requestCode = (int)
  System.currentTimeMillis()` and `FLAG_CANCEL_CURRENT`. All buttons of one
  widget share the same action and component, so two buttons registered in
  the same millisecond get the same identity and the second registration
  cancels the first: that button then does nothing at all. On the emulator
  each registration takes 3–10 ms (measured from the request codes in
  `dumpsys activity intents`), so every button survived; a current phone
  makes the binder call in well under a millisecond, which makes the dead
  button depend on timing — "sometimes". The cancelled-then-recreated
  records also pile up (227 for three widgets after an hour of testing).
- **A1. Offline or failed calls look like they worked.** The action edits
  the stored snapshot first and relies on the next refresh to undo a failed
  call. Offline that refresh fails too and returns the edited snapshot, so
  an archive that never reached the server shows as done; a cold refresh
  never reloads calendar or tasks, so a refused RSVP or task change is never
  undone either. Failures are only `console.warn`ed.
- **A2. A fast second tap repeats the first.** Two taps 150 ms apart both
  archived `d2aaaaa3`: the second tap hits the buttons of the old drawing,
  which still name the first message. Harmless for archive; for task ticks
  the code would flip the task back, because `toggleTask` inverts whatever
  the stored snapshot says instead of carrying the state the user saw.
- **A3. A refresh brings back a message just archived.** Each tap is its own
  headless task in the same runtime; they interleave at every await. With
  `Email/set` delayed 4 s, tap 1's refresh read the server before tap 2's
  archive landed, was stored anyway (it started after tap 2's local edit, so
  `noteLocalChange` did not catch it) and redrew the archived message
  (`baaaaaai`, log 08:44:19), until tap 2's own refresh removed it again.
  Separately, load–edit–save of the snapshot is not serialized, so two
  concurrent edits can drop one, and redraws of different snapshots can land
  out of order. In one run the second tap archived a message the card was
  not showing.
- **A4. RSVP and task ticks go to the wrong account after a switch.** They
  pick the client from `snapshot.activeAccountId` and look the item up by id
  in the current snapshot, not from the tap's own data. JMAP ids are small
  per-account sequences (`e`, `f`, `h1kbleaaaaaj`), so a tap on a drawing
  made before an account switch can match another account's task or event
  with the same id. Not reproduced on the device (the window between the
  stored refresh and the redraw is short); follows from the code.
- **A5. Nothing tells the user.** See A1.
- **A6. The task tick target is 22 dp.** A tap on the task's title or a few
  dp beside the circle does nothing.
- **Lead 2 (`target` lacks `widgetId`) is ruled out**: the logged click data
  of Archive/Delete is `{"id":…,"widgetId":3,"accountId":…}`.
- **Lead 4 (credentials in a cold runtime)**: the password account restores
  and acts from a cold start (archive, task tick). The OAuth account with an
  access token that expired while the app was dead is checked in phase 2.
- **Lead 5 (`progressUpdated`)** is ruled out: the widget's task update has
  carried no `progressUpdated` since the B12 fix, and both 0.16 and 1.0
  accept it (`updated`, no `notUpdated`).
- **R1. The refresh on going to the background often never runs.** With an
  account switched in the app and Home pressed, no refresh request reached
  the proxy and the widgets kept the old account's mail.
- **R2. Cold refreshes skip calendar and tasks.** Only mail has JMAP code of
  its own; the rest needs the app's stores, which only run with the UI.
- **L1. Widget Reply never opens the composer.** The reader opens on the
  message but the composer does not follow, in every state.
- **L2. "Send wishes" loses its subject.** `parseDeepLink` takes the
  subject from the mailto parser, which returns an empty string rather than
  nothing, so the link's own `subject` is never used.
- **L3. Calendar links crash the app offline.** On an offline cold start the
  Calendar tab mounts `CalendarShareSheet`, whose list of people to share
  with calls `ownPrincipalId()` while rendering; with no session that throws
  "Not authenticated - call connect() first" and the app closes.
- **L4. Message links for the other account fail offline.** The link
  switches accounts first, which needs the server; offline the switch fails
  and the app shows "Couldn't open this".
- **L5. Event links carry no account.** With the other account active, an
  event link opens the Calendar tab and nothing else (or, with an id that
  exists in both accounts, the wrong event). In the foreground the event
  link landed on the Inbox.

## Corrections to phase 1

- **L1 and L2 were faults of the test rig, not of the app.** `adb shell am
  start -d <url>` handed the URL to the device shell unquoted, and the shell
  cut it at the first `&`: Reply lost `&action=reply` (and `&thread=`), and
  "Send wishes" lost `&subject=`. Quoted, Reply opens the composer over the
  message and the subject arrives, cold, backgrounded and in the foreground,
  on 0.16 and 1.0.
- **L4 is two app limits, not a widget fault.** A message link offline needs
  the message on the device: with the offline mail cache off (the default)
  a message is not kept across app starts and the reader says "Failed to
  load email". A link for the other account needs the server for the account
  switch, so offline it says "Couldn't open this".
- **R1 had a second half.** Starting the background refresh directly (no
  timer) was not enough: fetch resolves every response through a zero-delay
  timer, and with the activity paused the first request went out and its
  answer was never read. The refresh now runs in a headless task of its own.

## After the fixes (phase 2)

Same rig. 1.0 was reached as `http://127.0.0.1:18191` through `adb
reverse`, so its accounts (`usera@127.0.0.1`) sit next to the 0.16 ones;
that path does not go through the emulator's network, so "offline" on 1.0
was simulated with the proxy refusing `Email/set` (503) instead of airplane
mode.

### Background actions

| Action | BG | COLD | OFF | ACC2 | DBL | UPD | 1.0 | Notes |
|---|---|---|---|---|---|---|---|---|
| archive | pass | pass | pass | n/a | pass | pass | pass | offline: the message comes back on the card with "Couldn't archive. Tap to try again."; the tap archives it once online |
| trash | pass | pass | pass | n/a | pass | pass | pass | offline: "Couldn't delete. Tap to try again."; the tap moves it to Trash once online |
| triageNext | pass | pass | pass | n/a | pass | pass | pass | local only, no server call |
| rsvp | pass | pass | pass | pass (unit test) | not run | not run | call passes, see 1.0 below | offline: the invitation stays with "Couldn't send your answer"; the retry accepts it. DBL and UPD not run on the device: they go through the same serial lane and pending overlay as archive and the tick, and `actions.test.ts` covers both |
| toggleTask | pass | pass | pass | pass (unit test) | pass | not run | call passes, see 1.0 below | two taps 150 ms apart send `completed` twice; offline the tick reverts with a notice naming the task, and tapping the notice once online sends one `CalendarEvent/set` and the task shows done. UPD not run on the device (see rsvp) |
| any button | pass | pass | – | – | – | – | – | request codes unique (107 click intents, 107 codes) |

DBL for archive: two taps 150 ms apart still both name the message the
drawing showed (the second is a harmless repeat); taps a second apart act on
consecutive messages. UPD: with `Email/set` delayed 4 s, two archives 1.5 s
apart leave the card on "5 of 5" for the whole run and nothing comes back
(before: the first archive's refresh brought the second message back). Trash
behaves the same: a double tap names the shown message twice, and two
deletes 1.5 s apart with `Email/set` delayed move two different messages
and nothing comes back.

### Deep links

| Link | FG | BG | COLD | OFF | ACC2 | 1.0 |
|---|---|---|---|---|---|---|
| inbox, unified, scheduled, search, compose | pass | pass | pass | pass | n/a | pass |
| message | pass | pass | pass | pass with the offline cache (L4) | pass | pass |
| reply | pass | pass | pass | pass with the offline cache (L4) | pass | pass |
| draft | pass | pass | pass | only if opened before (L4) | pass | not run (same route as message) |
| compose with to + subject | pass | pass | pass | not run (no server involved) | n/a | pass |
| calendar | pass | pass | pass | pass (no crash) | n/a | opens; see 1.0 below |
| event | pass | pass | pass | opens the Calendar tab; the event needs the server | pass (switches account) | see 1.0 below |
| contacts, settings | pass | pass | pass | pass (Vacation settings say the server does not support it while offline) | n/a | pass |
| files | pass | pass | pass | pass (no crash; the screen shows the raw network error) | n/a | pass |

### Refresh

| Case | Result |
|---|---|
| Account switched in the app, then Home | pass: the widgets show the new account within a second, both directions |
| App goes to the background | pass |
| Cold periodic update | pass: mail, calendar, tasks, files and scheduled (`appDataAt` set) |
| OAuth account with an expired access token, cold | pass: userb's token had expired an hour after sign-in; the cold refresh renewed it and loaded userb's inbox preview |

### Stalwart 1.0

- Mail actions and links pass: the archive race, a refused write with its
  notice and retry, trash, triage next, message and reply links cold and
  backgrounded, and the inbox, unified, scheduled, search, compose,
  calendar, contacts, files and settings links.
- The app on main does not load calendar events or tasks from 1.0: its
  `CalendarEvent/get` asks for `recurrenceOverrides` together with
  `utcStart`/`utcEnd`, which 1.0 refuses as a whole (`invalidArguments`).
  The unmerged `feat/stalwart-1.0` branch fixes that. Until it is merged the
  calendar and task widgets are empty against 1.0. The widgets' own calls
  were sent to 1.0 directly: the task update (`progress`,
  `percentComplete`) and the RSVP patch both come back `updated`.

### Causes and their fixes

| Cause | Commit |
|---|---|
| A0 dead buttons (shared request codes) | `fix: stop widget buttons from going dead when two are drawn in the same millisecond` |
| A3 refresh brings an archived message back, lost concurrent edits, out-of-order redraws | `fix: keep a widget archive when a second tap's refresh lands before it` |
| A1, A5 failures looked like success, no feedback | the commit above (a failed op is dropped) and `feat: show on the widget when an action could not reach the server` |
| A2, A4 tick flips back, item of another account | `fix: send widget RSVPs and task ticks to the item the tap was made on` |
| A6 22dp tick | `fix: make widget task ticks easy to hit` |
| R1 no refresh on leaving the app | `fix: refresh the widgets when the app goes to the background`, `fix: finish the widget refresh after leaving the app` |
| R2 cold refresh skipped calendar and tasks | `fix: load calendar and tasks into the widgets when the app is not running` |
| L3 offline crash from calendar and files widgets | `fix: keep the app from closing when a calendar widget opens it offline`, `fix: keep the app from closing when a files widget opens it offline` |
| L5 event links without account | `fix: open a widget's event in the account it belongs to` |

## Phase 3: layout review

All 32 widgets were drawn through a temporary in-app gallery
(`WidgetPreview`, removed again) at their smallest, default and largest
(4x5) size with sample data, light and dark, German, very long names and
counts (five-digit counts, 50-character names and subjects), empty data,
and the loading, signed-out, not-yet-loaded and unsupported states, and
with the tap areas highlighted. Fixed:

- The Inbox header at two cells pushed the compose button off; header
  titles now give way to the buttons, and the search icon goes at that
  width.
- A long sender pushed the triage card's time and position out.
- German labels were cut on the triage buttons ("Archivie", "Lösc"); they
  drop to icons when they do not fit.
- Five-digit counts overflowed Unread count, Tag and Mail and next, and the
  total wrapped a character per line; counts from 10,000 are shortened.
- "ungelesen" was cut in Mail and next; it moves under the number.
- Buttons under 48dp (32–36dp) get a transparent 48dp tap area.
- The Month arrows and the Vacation switch looked like controls but only
  opened the app.
- Folder counts with no folders showed a bare heading.
- A finished task past its due date read "Overdue".
- The triage card and Latest message did not use their height for the
  preview.
- A failure notice about a long task title cut off "Tap to try again".
- Widget strings were English in every language; German added.
- Avatars showed initials only, worked out differently from the webmail.
  Initials now follow the webmail everywhere in the app (first letters of
  the first and last name, leading punctuation and emoji skipped), and the
  widget avatars show the contact photo or the sender's logo first, as the
  app's list does. Logos come from the same favicon service, are fetched
  when the snapshot is built and are cached for offline drawing; a logo
  over 40 KB, or one Android cannot decode, leaves the initials.
- The corners were rounder (22dp) than the launcher's own widgets; they are
  16dp now, previews included.

Checked and left as they are:

- Dark theme: no white fallbacks; the primary is white as in the webmail.
- Large sizes of the 2x2 widgets are mostly empty space. A resize limit
  (`maxResizeWidth`) is given in dp, and on launchers with large cells it
  would pin a widget below two cells, so there is none.
- RTL is not supported: the widget library does not mirror layouts, and
  there are no right-to-left widget strings.
- Mail and next's chip for the following event is 24dp tall; the whole
  column also opens the calendar.

## Open

- A0 cannot be shown on this emulator, where each registration takes
  3–10 ms; the fix is checked by the request codes being unique.
- Calendar and task widgets against Stalwart 1.0 wait for
  `feat/stalwart-1.0` (see above).
- Offline message links need the offline cache; links for the other account
  need the server for the switch (L4).
- Widget strings exist in English and German only.
- RSVP double tap and update race, and the tick's update race, were not run
  on the device; unit tests cover them.
- The Files screen opened offline shows the raw network error instead of an
  offline message (app screen, not a widget).
