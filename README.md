<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/bulwarkmail/webmail/refs/heads/main/public/branding/Bulwark_Logo_with_Lettering_White_and_Color.svg" />
  <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/bulwarkmail/webmail/refs/heads/main/public/branding/Bulwark_Logo_with_Lettering_Dark_Color.svg" />
  <img src="https://raw.githubusercontent.com/bulwarkmail/webmail/refs/heads/main/public/branding/Bulwark_Logo_with_Lettering_Dark_Color.svg" alt="Bulwark Webmail" width="280" />
</picture>

</div>

# BryteWark Mobile

React Native (Expo SDK 54) client for [Bulwark Webmail](https://github.com/bulwarkmail/webmail) - a JMAP-based mail, calendar, and contacts app.

## What works today

The app covers 477 of the 494 webmail features and fixes tracked in [PARITY_CHECKLIST.md](PARITY_CHECKLIST.md). What changed recently is in [CHANGES.md](CHANGES.md).

**Accounts and sign-in**
- Sign in to any JMAP server (e.g. Stalwart) with a password, with two-factor (TOTP) codes, over OAuth/OIDC, with an access token, or with a sign-in code shown by the webmail
- Internationalized domain names in server and account addresses
- Up to 10 accounts: switch, reorder, set the default and remove any of them
- Shared and group accounts: their folders in the mail list, and their filters, vacation reply, calendars and address books in Settings
- Signing out removes the account's offline mail, search history and calendar subscriptions from the device, and ends the identity provider's session when no other account uses it
- Account security on Stalwart: change the password, turn two-factor sign-in on or off, app passwords, public keys and encryption at rest

**Mail**
- Folders with create, rename, move, delete, mark as read and empty; roles and role icons
- Unified inbox and per-role views (All Sent, Drafts, Junk, Archive, Trash) across accounts, plus All mail, Unread and Starred
- Conversations: open any message of a thread
- Tags with colours, tag views and counts; pin; answered and forwarded marks
- Swipe actions, long-press menu, multi-select and batch actions, undo, spam and not-spam, copy and move to another folder or account
- Sort order presets, unread-first order, and a choice between opening the Inbox or the last folder on start
- Search with folder scope from a folder tree, size and body filters, recent searches and highlighted matches; global search across mail, contacts, calendar and files
- HTML mail with dark mode, remote content blocked until allowed, and a list of trusted senders
- SPF, DKIM and DMARC results, a warning when the sender could not be verified, and the full header details
- Unsubscribe banner, read receipts, a copy chip for verification codes in the list and the message
- Attachments: previews for images, PDF, text, audio and video, thumbnails, download all, `winmail.dat` and attached `.eml` messages
- View source, export as `.eml`, import `.eml`, and create a filter rule from a message
- App links (`bulwarkmobile://`, the same paths as webmail permalinks) open a message, folder, event, contact or file
- Calendar invitations in a message: accept, decline or tentatively accept, and import into a calendar

**Composer and send**
- Drafts save automatically and reopen in the composer
- Reply, reply all and forward keep threading headers, Reply-To, the HTML quote, inline images and attachments; forward as attachment
- Identities with HTML signatures, Reply-To and Bcc; sub-addressing and a From override on your own domain
- Recipient suggestions from contacts, groups, recent recipients, the server's directory and sent mail; @-mentions
- Rich text toolbar, plain-text mode, inline images, templates, pasted lists become real lists
- Attach from the device, the camera or the Files app, with upload progress and size checks
- Undo send, send later, and a Scheduled screen to edit, reschedule or send now
- Delivery status notifications (DSN), REQUIRETLS and read-receipt requests when the server offers them
- Recipients the server refused are named; a send that reached nobody is never shown as sent

**Calendar**
- Agenda, day, week and month views, with week numbers, working hours and a collapsible all-day row
- Create and edit events, all-day events, time zones, recurrence with "this event", "this and following" and "all events", reminders, notes, duplicate and `.ics` export
- Invitations: guests from contacts and the directory, free/busy while planning, a choice of organizing identity, RSVP, save without invitations when the server refuses to send them, and the invitations the server delivered
- Meeting links and map locations open from an event
- Tasks with descriptions, priority, due dates and times, and filters, shown in the month view and the all-day row
- Create, rename, recolour, share and delete calendars; iCal import and subscriptions; a birthday calendar
- Local reminders as notifications

**Contacts**
- Address books, including shared ones: create, share, set the default and delete
- Full contact editing, organizations, photos, groups and categories
- vCard import and export, including Apple and Android vendor fields
- List filters, bulk export, contact activity, and links that open a new or existing contact

**Filters, vacation and files**
- Sieve filter rules in a visual editor that keeps the webmail's rules intact, with active periods and the server's forward limit; rules can be built from a message and applied to existing mail with undo
- Vacation responder with HTML replies, dates, forwarding while away, and a choice of who gets the reply
- Files: upload with progress, download, preview, move, duplicate, copy folders, rename, search and sharing; the storage quota shows in Account settings

**Settings and appearance**
- Light, dark and system themes, plus six built-in colour themes from the webmail
- Font size for most of the app (a few screens still use fixed sizes), list density, and an option to turn animations off
- 27 languages, including right-to-left layouts (see below)
- Date format region, 12 or 24-hour time and an app-wide time zone
- Settings search, settings export and import
- Sidebar apps that open web links

**Push and notifications**
- Push via the Bulwark relay - FCM by default, or [UnifiedPush](https://unifiedpush.org) (e.g. ntfy) for devices without Google Play services
- One relay per account, Inbox-only notifications, and a list of the account's push devices with revoke
- One message reaching several accounts rings once; the app icon shows the unread count

**Privacy and security**
- The sender check, remote content blocking and trusted senders described under Mail
- Options to block screenshots or hide the app in recent apps (Android)
- Offline mail and the outbox stay out of Android's cloud backup
- Client TLS certificates (Android)

**Offline**
- Mail is cached for offline reading, for your own account and shared ones
- Read, flag, tag, move, archive and delete work offline and are sent when the connection returns
- Messages sent while offline wait in an Outbox and are never sent twice

**Android device integration**
- 32 home screen widgets for mail, calendar, tasks, contacts, files and storage
- Share to the app from other apps to start a message; `mailto:` links open the composer
- Contacts and calendars sync both ways with the phone's Contacts and Calendar apps (Settings → Contacts / Calendar → Sync to this device)
- In-app sideload updates from GitHub Releases

## What's missing or rough

**Platform**
- iOS builds and runs from TestFlight, but push notifications, client certificates, widgets, share to the app, sync with the phone's contacts and calendars, screen protection and in-app updates are Android-only. iOS has had little device testing so far.
- No Play Store or App Store listing yet: Android is a sideloaded APK, iOS a TestFlight beta (see [Try it](#try-it))

**Not supported**
- S/MIME: signed and encrypted messages are recognised and marked, but the app cannot verify, decrypt, sign or encrypt. The S/MIME settings tab is marked "Not implemented".
- Plugins run in the webmail only; the app has no plugin system
- Sending from shared or group accounts

**Open parity items**
- Settings, templates and tag definitions don't sync between devices or with the webmail (native #1). It needs a server-side settings store.
- Folders: no reordering, custom folder icons, or folder sharing
- Tags: no visibility, nesting, reorder or rename
- Calendar: no Jalali calendar grid; new calendars don't pin which components they hold (needs a CalDAV client); reminders are not refreshed in the background by push
- Invitation banner: no "View in calendar", collapse, sequence badge or counter-proposal review
- Right-to-left: swipe directions are not mirrored, and the drawer side is unchecked on a device
- Fixed-width tables in mail may shrink instead of wrapping on iOS (unchecked on a device)

**Waiting on other projects**
- iOS push needs an APNs transport in the push relay
- The admin's list of push relays and default sidebar apps can't be read: webmail's `/api/admin/policy` blanks both for clients without a webmail cookie. A free-text relay per account works.
- Stalwart's built-in OIDC advertises no end-session endpoint, so signing out can't end that session; it works with external providers such as Keycloak and Authentik

The roadmap lists the smaller follow-ups and the device checks still to run: [docs/superpowers/plans/2026-10-04-webmail-parity-roadmap.md](docs/superpowers/plans/2026-10-04-webmail-parity-roadmap.md).

## Run locally

```bash
npm install
npx expo start
```

Then press `a` for Android, `i` for iOS, or scan the QR with Expo Go.

For release APK builds and signing see [docs/android-release.md](docs/android-release.md).
For iOS builds and TestFlight distribution see [docs/ios-release.md](docs/ios-release.md).

## Native Android project

`android/` is committed and edited by hand. It holds code that a regenerated project would not have:
- `ShareIntentStore` and `NotificationTapStore`, which `MainActivity` calls;
- `BulwarkWindowModule` (screen protection and system bar colours), which `MainActivity.onCreate` applies before the first frame;
- `res/values/styles.xml` (`enforceNavigationBarContrast` is false).

Never run `expo prebuild --clean`: it regenerates `android/` and silently drops these changes. Make native changes in `android/` directly.

## License

AGPL-3.0-only, with an additional permission to distribute the app through app stores such as the Apple App Store and Google Play. See [LICENSE](LICENSE). Contributions are accepted under the same terms. The permission is provisional until every earlier contributor has agreed to it ([consent request](https://github.com/orgs/bulwarkmail/discussions/1113)); contributions made since 30 September 2026 are already covered.
