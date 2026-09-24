# Settings & settings sync, push notifications, i18n, themes, updates, plugins, misc UI

All paths below are relative to WEB root `the webmail repo` unless prefixed `RN:` (= `repos/react-native/`). Line numbers are from the tree as of 2026-08-29.

## Summary

Settings parity is roughly "half the keys, a third of the behaviour": RN persists 77 keys (`RN: src/stores/settings-store.ts:102-230`) against WEB's ~110 (`stores/settings-store.ts:540-735`), but 16 of the RN keys are stored and never read anywhere outside the settings UI (stub toggles), several defaults silently diverge from WEB, and there is no cross-device sync at all (native issue #1) because WEB sync is a webmail-server feature (`/api/settings`, cookie-bound, AES-GCM with `SESSION_SECRET`) that a direct-to-JMAP native client cannot reach. Push is the biggest functional gap: RN subscribes to `Email`/`Mailbox` state changes (WEB only `EmailDelivery`), has no `emailPush` spam filter, ignores the message ids the relay forwards and instead guesses "newest unread in Inbox" (which produces a wrong notification when the newest unread is read elsewhere), never matches the relay payload to an account (scans for a field the relay does not send), has no device list / revoke / force-recreate, and is Android/FCM-only (no iOS, no UnifiedPush; native issues #44/#45/#48). i18n in RN is a flat-lookup shim: 15 of WEB's 27 locales, no interpolation, no plurals, no RTL, vendored catalogs six weeks stale, and 84 of 94 screen/component files never call `t()` at all (every settings pane except Language and Filters is hard-coded English). Themes/plugins/S-MIME/sidebar apps are visual stubs whose controls persist state nobody reads; the update path is a working Android sideloader with no severity concept and a dismissable banner (WEB's security/deprecated notices are non-dismissable).

## Settings inventory

Legend: RN? = key exists in RN store; Honored = read by RN app code outside `stores/settings-store.ts` and `components/settings/*` (verified by grep, 2026-08-29). "Owner" names the agent that covers the behaviour when it is not this area.

| WEB key (default) | RN key (default) | RN? | Honored | Notes |
|---|---|---|---|---|
| fontSize (medium) | fontSize (medium) | yes | partial | Only `useTypography()` callers scale: EmailListScreen and its attachment chips (`RN: src/theme/dynamic.ts:47`); the other files import static `typography` from tokens |
| density (regular) | density (regular) | yes | yes | EmailListScreen via `useDensity()` |
| animationsEnabled (true) | animationsEnabled (true) | yes | partial | Only via `useAnimDuration` in 3 files; 18 files call `Animated.timing` with fixed durations (UndoSnackbar, SwipeableRow, every sheet) |
| messageListOrder / messageListOrderScope (#718) | mailSortAscending (false) | partial | yes | Single boolean; native issue #5. Owner: mail-list agent |
| dateFormat (smart) | dateFormat (smart) | yes | yes | `RN: src/lib/date-format.ts` |
| dateLocale (auto) | – | no | – | Regional numeric order (1.7.x "User-selectable regional date format") missing |
| timeFormat (24h) | timeFormat (24h) + calendarTimeFormat (24h) | yes | yes | RN has two independent time-format settings; WEB has one |
| firstDayOfWeek (1) | calendarFirstDayOfWeek (1) | yes | yes | RN type is `0 \| 1`, WEB also allows 6 (Saturday) |
| timeZone (auto, #755) | – | no | – | Missing |
| markAsReadDelay (0) | markAsReadDelay (0) | yes | yes | |
| deleteAction (trash) | deleteAction (trash) | yes | yes | email-store |
| permanentlyDeleteJunk (false) | same | yes | yes | |
| returnToListAfterAction (true) | – | no | – | Owner: mail viewer agent |
| showPreview (true) | showPreview (true) | yes | yes | |
| mailLayout (split) | mailLayout (split) | yes | **no** | ReadingSettings offers Split/Focus, nothing reads it. N/A on phone; remove the control or hide it |
| emailsPerPage (50) | emailsPerPage (25) | yes | yes | Default differs |
| externalContentPolicy (ask) | same | yes | yes | EmailBodyView |
| messageSpacing (auto), plainTextFont (sans) | – | no | – | Owner: viewer agent |
| mailAttachmentAction / attachmentPosition | same | yes | yes | |
| emailAlwaysLightMode (false) | same | yes | yes | EmailBodyView:471 |
| archiveMode (single) | same | yes | yes | |
| hoverActions* | – | no | – | N/A on touch |
| swipeRightAction (archive) / swipeLeftAction (delete) | swipeRightAction (read) / swipeLeftAction (archive) + swipeMode | yes | yes | Defaults differ (WEB right=archive,left=delete; RN right=read,left=archive). RN adds `pin`, `move`, `reveal` mode; WEB adds `spam`. Owner: mail-list agent |
| autoSaveDraftInterval, sendConfirmation, defaultReplyMode, rtlEditingSupport, subAddressDelimiter, signaturePosition, signatureSeparatorEnabled, requestReadReceiptDefault, readReceiptResponse, emptySubjectWarningEnabled | – | no | – | Owner: compose agent |
| autoSelectReplyIdentity (false) | same (**true**) | yes | yes | Default differs |
| plainTextMode (false) | same | yes | yes | |
| sendDelaySeconds (0) | same (0, any number) | yes | yes | RN does not validate to 0/10/30/60 like WEB (`stores/settings-store.ts:901`) |
| attachmentReminderEnabled / attachmentReminderKeywords (multilingual list, :670-697) | same (4 English words, :255) | yes | yes | RN default list is English-only |
| sessionTimeout (0) | – | no | – | Owner: auth agent |
| trustedSenders ([]) | same | yes | yes | RN `addTrustedSender` does not strip `Name <addr>` (WEB :1008-1016) |
| trustedSendersAddressBook (null → auto true) | same (**false**) | yes | partial | Read by EmailBodyView:470 but there is no toggle in ContentSendersSettings and no auto-enable, so it is permanently off |
| expandedFilterView | filtersExpandedView | yes | yes | Only read inside FilterSettings itself (fine) |
| showTimeInMonthView (false) | calendarShowTimeInMonth (**true**) | yes | **no** | Stored, never read. Owner: calendar agent |
| showWeekNumbers | calendarShowWeekNumbers | yes | yes | |
| calendarHoverPreview | same | yes | **no** | N/A on touch; hide the control |
| enableCalendarTasks / showTasksOnCalendar | same | yes | yes / **no** | showTasksOnCalendar stored, never read |
| showBirthdayCalendar (false) | same (**true**) | yes | yes | Default differs |
| birthdayCalendarColor | – | no | – | Owner: calendar agent |
| sharedCalendarColors | same | yes | yes | |
| groupContactsByLetter | same | yes | yes | |
| emailNotificationsEnabled (true) | same | yes | yes | App.tsx:336, push-background-task.ts:32 |
| emailNotificationSound (true) | same | yes | **no** | Stored, never read; Android channel sound is whatever the OS default is |
| notificationSoundChoice (default/cheerful/involved/swift/relax) | same (default/chime/ping/pop/none) | yes | **no** | Different option set, never read, preview button has no `onPress` (`RN: NotificationSettings.tsx:205-210`) |
| pushRelayUrl ('' = admin default) | (AsyncStorage `push:relayBaseUrl:v1`, free text) | separate | yes | See push findings |
| calendarNotificationsEnabled / calendarNotificationSound | same | yes | **no** | Stored, never read (calendar-alerts lib does not consult them). Owner: calendar agent for the alarm side |
| calendarInvitationParsingEnabled | same | yes | yes | CalendarInvitationBanner |
| protocolOpenMode | – | no | – | N/A (web protocol handlers) |
| toolbarPosition | – | no | – | N/A |
| showToolbarLabels | same | yes | yes | EmailThreadScreen |
| hideAccountSwitcher, showRailAccountList, proInterface | – | no | – | N/A |
| enableUnifiedMailbox, unifiedCrossAccount, enableCross*View, allMailFolderIds | – | no | – | RN has a UnifiedInbox screen without these switches. Owner: mail-list agent |
| includeGroupInUnified (true) | same (**false**) | yes | yes | Default differs |
| preferredIdentityIds (per account, #507) | – | no | – | Owner: identity agent |
| disableThreading | same | yes | yes | |
| senderFavicons | same | yes | yes | |
| showAvatarsInJunk, faviconUnreadBadge, colorfulSidebarIcons, tintListRowsByTag, showFolderTotalCount | – | no | – | faviconUnreadBadge N/A; others Owner: mail-list/sidebar agent |
| folderIcons, emailKeywords, nestedTags | – (keywords-store) | separate | – | Owner: mail agent |
| hideInlineImageAttachments / attachmentImagePreviewsEnabled | yes / no | | | |
| sidebarApps, keepAppsLoaded | same | yes | **no** | Never rendered anywhere (see Plugins section) |
| onboardingCompleted, tourCompleted, showOnboardingOnNewDevices | – | no | – | N/A (no tour) |
| emailDownloadTemplate, attachmentDownloadTemplate, filenameSpaceReplacement, filenameLowercase, filenameStripDiacritics | emailExportTemplate, attachmentExportTemplate, exportSpaceReplacement, exportLowercase, exportStripDiacritics | yes | yes | `RN: src/lib/email-export.ts` |
| bundleDownloadTemplate, filenameCollapseSeparators, postExportAction | – | no | – | Owner: mail viewer/export agent |
| debugMode, debugCategories | (React local state only) | no | **no** | `RN: AboutDataSettings.tsx:61-63` — toggles live in `useState`, lost on unmount, nothing reads them |
| settingsSyncDisabled | (local state) | no | **no** | `RN: AboutDataSettings.tsx:65,246-248` — a "Settings sync" switch that does nothing |
| – | theme (system) | RN-only | yes | WEB keeps this in theme-store |
| – | activeThemeId (null) | RN-only | **no** | Never read |
| – | smimeDefaultEncrypt / smimeRememberUnlocked / smimeAutoImport | RN-only | **no** | Stubs |
| – | pluginEnabled ({}) | RN-only | **no** | Stub |
| – | files* (8 keys) | RN-only | 6 of 8 | filesFolderLayout, filesShowThumbnails never read. Owner: files agent |
| – | bottomQuickActions, swipeMode, offlineCache* | RN-only | yes | |

RN toggles that are stored but never read (fix: either wire them or remove the control): `mailLayout`, `calendarShowTimeInMonth`, `calendarHoverPreview`, `showTasksOnCalendar`, `emailNotificationSound`, `notificationSoundChoice`, `calendarNotificationsEnabled`, `calendarNotificationSound`, `sidebarApps`, `keepAppsLoaded`, `activeThemeId`, `smimeDefaultEncrypt`, `smimeRememberUnlocked`, `smimeAutoImport`, `pluginEnabled`, `filesFolderLayout`, `filesShowThumbnails`.

## Findings

### Settings store and settings sync

- [ ] **No cross-device settings sync; RN cannot join the WEB sync store as-is (native #1)** — `P2` — `missing` — deferred (needs a server-side store); key-mapping table shipped as SETTINGS_KEY_MAP + DEVICE_LOCAL_KEYS in src/stores/settings-store.ts (8deff66) and used by export/import; the dead 'Settings sync' switch is gone
  - What WEB does: every settings change (plus theme, locale, templates #825) is debounced 2 s and POSTed to the webmail server's `/api/settings` (`stores/settings-store.ts:1340-1359`, `:72-96`). The server verifies the caller against its own session cookies for any account slot (`app/api/settings/route.ts:71-94`), strips admin-locked keys (`:142-167`) and writes `sha256(username:serverUrl).enc` under `SETTINGS_DATA_DIR`, AES-256-GCM with key `sha256(SESSION_SECRET)` (`lib/settings-sync.ts:12-32,34-53`). On login it GETs the blob and imports it with per-account map merging (`stores/settings-store.ts:1125-1165`, `:942-951`). `proInterface` is device-local (`:147`).
  - What RN does: persists a flat JSON under AsyncStorage key `webmail:settings:v1` (`RN: src/stores/settings-store.ts:91,393-397`) and nothing else. The AboutData "Settings sync" toggle is `useState` (`RN: AboutDataSettings.tsx:65,246-248`).
  - Fix hint: RN talks to Stalwart directly and has no webmail session cookie, so it cannot call `/api/settings` (403 identity mismatch, and the deployment's webmail URL is unknown to it). Two realistic designs: (a) store the same JSON blob on the JMAP server as a Blob (`Blob/upload` + a well-known keyword/mailbox message, or a FileNode in the user's Files root such as `/.bulwark/settings.json`) and have WEB read/write the same object so both clients converge — needs a shared key-name mapping (WEB names above) and a `updatedAt` for last-writer-wins; or (b) let the login flow optionally capture the webmail origin (the QR sign-in already comes from webmail) and proxy sync through it with a bearer token. Either way, ship a key-mapping table first (RN `mailSortAscending` ↔ WEB `messageListOrder`, `calendarFirstDayOfWeek` ↔ `firstDayOfWeek`, `emailExportTemplate` ↔ `emailDownloadTemplate`, etc.) and exclude device-local keys (`swipeMode`, `bottomQuickActions`, `offlineCache*`, `theme`?).

- [x] **Default values silently diverge from WEB** — fixed in 8deff66 — `P3` — `partial`
  - What WEB does: `emailsPerPage` 50, `autoSelectReplyIdentity` false, `showBirthdayCalendar` false, `showTimeInMonthView` false, `includeGroupInUnified` true, `trustedSendersAddressBook` null→auto-true, swipe right=archive/left=delete, multilingual attachment-reminder keyword list (`stores/settings-store.ts:540-735`).
  - What RN does: 25, true, true, true, false, false, right=read/left=archive, 4 English keywords (`RN: src/stores/settings-store.ts:232-325`).
  - Fix hint: align defaults where the behaviour is the same on both clients (attachment keywords, includeGroupInUnified, autoSelectReplyIdentity, showBirthdayCalendar) before any sync exists, otherwise the first sync flips them for existing users.

- [x] **`trustedSendersAddressBook` can never be turned on in RN** — `P3` — `partial` — done in 78114b6 (toggle in Content & Senders); since d89e331 it stays off until the user turns it on, where the webmail turns it on by itself
  - What WEB does: `null` resolves to `true` on first connect when the server has contacts; the Content & Senders tab has a toggle (`components/settings/content-senders-settings.tsx`, `updateSetting('trustedSendersAddressBook'`).
  - What RN does: default `false` (`RN: src/stores/settings-store.ts:239`), read by `EmailBodyView.tsx:470,489` but `ContentSendersSettings.tsx` has no control for it.
  - Fix hint: add the toggle; treat undefined as auto-on when `useHasContacts()`.

- [x] **`addTrustedSender` does not normalise `Name <addr>`** — fixed in 8deff66 — `P3` — `bug`
  - What WEB does: strips display-name angle form before storing/comparing (`stores/settings-store.ts:1008-1035`).
  - What RN does: lowercases and trims only (`RN: src/stores/settings-store.ts:471-489`); callers that pass a formatted address store a value that will never match.
  - Fix hint: port the angle-bracket regex into `add/remove/isSenderTrusted`.

- [x] **`sendDelaySeconds` and other enum keys not sanitised on hydrate** — fixed in 8deff66 — `P3` — `bug`
  - What WEB does: rejects/resets invalid `sendDelaySeconds`, `messageListOrder`, `messageListOrderScope`, `subAddressDelimiter` on import and in `migrate` (`stores/settings-store.ts:898-930,1207-1209`).
  - What RN does: `mergeWithDefaults` only checks `typeof` (`RN: src/stores/settings-store.ts:399-415`); a corrupt `swipeLeftAction: "foo"` or `density: "x"` flows into the UI.
  - Fix hint: add per-key validators (allowed-value sets) to `mergeWithDefaults`; `normalizeBottomQuickActions` is the pattern.

- [x] **Reset-to-defaults only resets three keys; no export/import** — fixed in 8deff66 — `P3` — `partial`
  - What WEB does: `resetToDefaults` restores every key; About & Data offers Export/Import JSON (feature-gated) and "Refresh cached data" (`components/settings/about-data-settings.tsx:77-129,171-220`, `lib/clear-cached-data.ts`).
  - What RN does: `handleReset` resets `externalContentPolicy`, `senderFavicons` and trusted senders only (`RN: AboutDataSettings.tsx:104-110`); no export/import; "Clear cache" only clears the offline body cache.
  - Fix hint: add `resetToDefaults` to the store (`set(DEFAULT_PERSISTED)` + persist), an export via `expo-sharing` and import via `expo-document-picker` using WEB's export shape so files round-trip between clients; add a "refresh cached data" that clears `email-snapshot`/contacts/calendar caches without logging out.

- [x] **Debug mode / categories are inert local state; no debug/logger abstraction** — fixed in 8deff66 — `P3` — `missing` — src/lib/debug.ts; dead Debug tab removed in 3d0d440
  - What WEB does: `debugMode`/`debugCategories` persisted and honoured by `lib/debug.ts:8-13`; `lib/logger.ts` server side (`lib/error-reporting.ts`, cited here before, has since been deleted from the webmail). Debug tab gated by admin (`settings-app.tsx:766`).
  - What RN does: `AboutDataSettings.tsx:61-66,226-244` keeps toggles in `useState` with categories (`sync`, `render`) that exist nowhere; the "Debug" tab is `implemented: false` (`SettingsScreen.tsx:111`); code uses raw `console.warn`.
  - Fix hint: persist `debugMode`/`debugCategories`, add `src/lib/debug.ts` mirroring WEB's category API, route the `[push]`, `[settings-store]`, `[updates-store]` warnings through it, and drop the dead Debug tab or implement a log viewer.

- [x] **Settings panes are hard-coded English (no i18n)** — fixed in 22697fd — `P2` — `partial` — all panes I own use t(); RN-only keys harvested into locales/rn/en.json (npm run i18n:harvest); Calendar/Contacts/ContentSenders/Filter/Vacation/Files/Folder panes belong to other agents
  - What WEB does: every settings component uses `useTranslations` with keys in `locales/*/common.json`.
  - What RN does: only `LanguageSettings.tsx` and `FilterSettings.tsx` call `t()`; the other 24 settings components plus `settings-section.tsx` have literal English strings (grep count 0 for `t(` in each). `SettingsScreen.tsx:184-187` translates group/tab labels only, and the "Experimental"/"Not implemented"/"Unavailable" badges (`:297,270-273`) are literal.
  - Fix hint: the vendored catalog already contains `settings.*` keys for almost every label (WEB keys); wrap each label/description in `t('settings.<tab>.<key>', 'fallback')`.

- [x] **Settings tabs shown regardless of server capability / admin policy** — fixed in 3ffcef2 — `P3` — `partial` — Sieve/Vacation gating via useHasSieve/useHasVacation (filters agent's commit)
  - What WEB does: hides Vacation/Filters when Sieve is absent, Templates/Keywords/Sidebar apps/Plugins/Themes/Debug behind admin feature flags, Security behind Stalwart features (`components/settings/settings-app.tsx:724-766`); settings can be `locked`/hidden per policy (`appearance-settings.tsx:89-119`).
  - What RN does: hides only calendar/contacts/files by capability and updates by platform (`RN: SettingsScreen.tsx:142-179`); Vacation and Filters render even without Sieve; `SettingItem` has a `locked` prop (`settings-section.tsx:68-86`) that nothing sets. Admin policy is N/A (no webmail server), but Sieve gating is not.
  - Fix hint: gate `vacation`/`filters` on `CAPABILITIES.SIEVE` in the session like WEB's `supportsSieve`/`supportsVacation`.

### Push notifications

- [x] **RN subscribes to `Email` and `Mailbox` state changes, not just `EmailDelivery`** — fixed in 00faceb — `P2` — `bugfix-parity` — the `emailPush` map it added was refused for ACL-shared mailboxes, which could leave push off for good, and was re-patched on every launch, until d8046a8 and ccaa24e (audit B18)
  - What WEB does: `PUSH_TYPES = ['EmailDelivery']` because `Email` fires on every mutation and produced spurious notifications (`lib/web-push.ts:39-44`; changelog 1.5.x "Scope new-mail notifications to genuine inbox deliveries").
  - What RN does: `PUSH_TYPES = ['Email', 'EmailDelivery', 'Mailbox']` (`RN: src/lib/push-notifications.ts:104`). Every read/flag/move/draft on any client wakes the device through FCM and runs the headless task.
  - Fix hint: change to `['EmailDelivery']` and bump the subscription (the refresh path only patches `expires`, `:411-429`; add a `types` mismatch check like WEB `:369-383` so existing subscriptions get corrected).

- [x] **"Newest unread in Inbox" heuristic notifies the wrong message** — fixed in 00faceb — `P2` — `rn-only-bug`
  - What WEB does: the service worker uses the `emailIds` the relay forwards (EmailPush) or, on StateChange, asks `/api/push/preview?accountId=&emailId=` (`app/api/push/preview/route.ts:88-119`).
  - What RN does: `processAccountForPush` queries `notKeyword:$seen` in Inbox, limit 1, and notifies it unless it equals `lastNotified` (`RN: src/lib/push-background-task.ts:151-164`). Because RN also subscribes to `Email` changes, reading the newest unread message on another device triggers a push, the query now returns the *next older* unread message, which was never `lastNotified`, so the user gets a notification for old mail. Two messages arriving in one push yield one notification; mail Sieve-filed outside Inbox never notifies; the relay's `emailIds` (`repos/relay/src/payload.ts`, `fcm.ts` data.emailIds) are ignored.
  - Fix hint: parse `data.emailIds` (JSON string) and `data.kind`; when present, `Email/get` those ids directly and post one notification per id (or a grouped one); fall back to the Inbox query only for legacy `jmap-state-change` payloads, and there compare against a stored set of seen ids rather than a single `lastNotified`.

- [x] **Per-account matching of the FCM payload never matches** — fixed in 00faceb — `P2` — `rn-only-bug` — local id → JMAP id map in push:jmapAccountIds:v1 (+AccountEntry.jmapAccountId), accountLabel fallback
  - What WEB does: SW reads `accountId` from the payload's `changed` map (`app/api/push/preview/route.ts:90-99`).
  - What RN does: `identifyAccountFromFcmData` scans payload values for a locally stored `deviceClientId` (`RN: src/lib/push-background-task.ts:67-87`), but the relay sends `kind, accountLabel, accountId, emailIds, changed` (`repos/relay/src/fcm.ts` message.data) - never the subscription id. Result: every push processes every logged-in account serially inside a 30 s headless budget (`BulwarkPushTaskService.kt` timeout), loading each account's JMAP session.
  - Fix hint: the relay's `accountId` is the JMAP primary account id; persist each account's JMAP account id in `AccountEntry` (`RN: src/stores/account-store.ts:7-19` has none) or in the push registry (`push:accountIds:v1` → map local id → jmap id) at setup time, and match on that. `accountLabel` (= username) is a weaker second key.

- [x] **No `emailPush` delivery filter (spam still wakes the device)** — fixed in 00faceb — `P2` — `bugfix-parity` — the map was refused for ACL-shared mailboxes and never read back until d8046a8 and ccaa24e (audit B18)
  - What WEB does: when the session advertises `urn:ietf:params:jmap:emailpush` (Stalwart ≥ 0.16.16) the subscription carries a per-account filter `notKeyword:$junk AND inMailboxOtherThan:[junk ids]` (`lib/web-push.ts:53-108,491-497`, commit 63fa2d2d) and re-syncs it in the background on every page load (`:668-688`, `components/push-notification-prompt.tsx:119-126`, 1.9.2).
  - What RN does: `createPushSubscription` has no `emailPush` parameter (`RN: src/api/push.ts:23-57`); the Inbox-only query hides junk from the notification but the wake-up and JMAP round-trip still happen for every spam delivery.
  - Fix hint: port `buildEmailPushConfig` + `serverSupportsEmailPush` (session capabilities are in `jmapClient.currentSession.capabilities`), add `emailPush` to `createPushSubscription`/`updatePushSubscription`, and extend `refreshSubscriptionExpires` to patch `types`/`emailPush` when they differ.

- [x] **No device list, per-device revoke, or force-recreate (#841)** — fixed in f6f26f7 — `P2` — `missing`
  - What WEB does: Notifications tab lists every `PushSubscription` on the account with relay liveness and "this device" marker, lets the user revoke any of them, and "Re-register" destroys and recreates the subscription so revoked shared-mailbox access stops fanning out (`lib/web-push.ts:565-639`, `:143,457-461`; `components/settings/notification-settings.tsx:169-193,251-303`; changelog 1.8.x).
  - What RN does: "Re-register" calls `setupPushNotifications` which reuses the stored subscription and only refreshes `expires` (`RN: src/lib/push-notifications.ts:345-352`); no list/revoke UI.
  - Fix hint: add `forceRecreate` to `PushSetupParams`, and a `listPushDevices`/`revokePushDevice` pair (JMAP `PushSubscription/get` + relay `/api/push/active/:id` + `DELETE /api/push/register/:id`) rendered under the relay card.

- [ ] **Relay URL is a free-text field instead of an admin-curated list; `DEFAULT_RELAY_BASE_URL` not overridable** — `P3` — `partial` — https now required (isValidRelayUrl, 00faceb); deferred: per-account relay storage / discovery
  - What WEB does: user picks from `resolvePushRelayOptions(policy)` (default + admin list + legacy), never types a URL; admin can lock it (`lib/push-relays.ts:39-80`, `notification-settings.tsx:226-241`).
  - What RN does: `TextInput` with any `https?://` accepted (`RN: NotificationSettings.tsx:174-184`), stored device-wide in AsyncStorage (`push-notifications.ts:160-175`) so two accounts on different servers share one relay.
  - Fix hint: keep free text (there is no policy source in RN) but store the relay per account alongside `push:accountIds:v1`, and let `.well-known`/login-time discovery optionally seed it. Not blocking.

- [x] **Re-register error path is opaque (native #45)** — fixed in 00faceb — `P2` — `bug` — PushSetupError{phase}, relay body in message, guarded getToken, per-account teardown keeps the FCM token; no device repro yet
  - What WEB does: surfaces `WebPushUnsupportedError` separately and reports precise relay/JMAP failures; reaps only relay-confirmed-dead leftovers (`lib/web-push.ts:466-489`).
  - What RN does: `setupPushNotificationsInner` calls `native.getToken()` directly (not the guarded `getFcmToken`) so a Firebase rejection (`fcm_token_failed`, typical on de-Googled devices or right after `deleteToken()` during Disable) bubbles up raw; `registerWithRelay` throws `Relay register failed: <status>` without the body (`RN: src/lib/push-notifications.ts:312-313,215-217`); `pollVerificationCode` times out after 75 s with the same message for every cause (`:268`). The UI shows `error.message` verbatim (`NotificationSettings.tsx:95-99`). Disable then immediately Enable also races: `teardownPushNotificationsForAccount` deletes the FCM token when it was the last account (`:477-481`) and the next `getToken()` may be rejected until Firebase re-registers.
  - Fix hint: read the relay response body into the error, distinguish "no Google Play services" (map to the UnifiedPush finding), skip `deleteToken()` unless the user disables push for all accounts, and log each phase (`token`, `relay`, `jmap create`, `verify`) so the settings pane can show which step failed. Needs a repro on the reporter's device to confirm the exact failure.

- [ ] **iOS push missing entirely** — `P2` — `missing` — deferred: needs an APNs transport in the relay + iOS token module; the settings pane now states Android-only
  - What WEB does: Web Push works on iOS 16.4+ once installed to the home screen (`lib/web-push.ts:157-164,394-398`).
  - What RN does: `getNative()` returns `null` off Android and setup throws "Push notifications require Android" (`RN: src/lib/push-notifications.ts:125-128,303-304`); the relay has only FCM and Web Push transports (`repos/relay/README.md` endpoints).
  - Fix hint: needs an APNs transport in the relay (`POST /api/push/register/apns` storing a device token, HTTP/2 to `api.push.apple.com` with a `.p8` key) plus an iOS native module (or `expo-notifications`) for the token and a Notification Service Extension to fetch sender/subject over JMAP. Content-blind payload stays the same.

- [x] **No non-FCM transport (UnifiedPush, native #44/#48)** — `P3` — `missing` — done in ee04e95 (Android: UnifiedPush connector through a distributor app such as ntfy; the relay falls back to unencrypted delivery for distributors without Web Push keys); not in a release yet
  - What WEB does: N/A (browser push).
  - What RN does: FCM only (`BulwarkMessagingService.kt`, `push-notifications.ts:120-128`).
  - Fix hint: UnifiedPush distributors expose an RFC 8030 endpoint, which is exactly what the relay's `/api/push/register/web` already accepts (`repos/relay/src/server.ts` handleRegisterWeb); VAPID/`keys` are optional in UnifiedPush so the relay must accept a record without `p256dh`/`auth` and send unencrypted (or only the id). Client side: `unifiedpush-react-native`/`org.unifiedpush.android.connector` receiving the message and calling the same headless task.

- [x] **No "+N more messages" grouping** — fixed in 00faceb — `P3` — `missing`
  - What WEB does: one notification per account with the newest message as headline and a "+N more" line, tag `bulwark-mail:<accountId>`, click opens inbox when grouped (`public/sw.js:180-216`; changelog 1.8.x).
  - What RN does: one notification per message id `mail:<emailId>` with no `setGroup`/summary (`RN: BulwarkFcmModule.kt postNotification`).
  - Fix hint: set `setGroup("bulwark-mail:"+accountId)` on each notification and post a summary notification with `setGroupSummary(true)` and an `InboxStyle` listing; Android does the "+N" rendering.

- [x] **Foreground FCM message is only logged** — fixed in 00faceb — `P3` — `partial`
  - What WEB does: SW shows the notification regardless; in-app state refresh comes from the separate SSE channel.
  - What RN does: `addMessageListener` handler just `console.log`s (`RN: App.tsx:300-305`); since the Kotlin service skips the headless task in the foreground (`BulwarkMessagingService.kt:26-31`) no notification is posted and no store refresh happens if SSE happens to be down (SSE fallback is 5 s polling, so the gap is small).
  - Fix hint: on `fcm:message`, call `useEmailStore.getState().handleStateChange(JSON.parse(payload.data.changed))` (relay sends it) and optionally post an in-app banner.

- [x] **No push onboarding prompt** — fixed in f6f26f7 — `P3` — `missing`
  - What WEB does: after the PWA install prompt, a per-account dismissable "enable notifications" card appears 1 s after login unless already enabled (`components/push-notification-prompt.tsx:128-177`; changelog 1.8.0 "Background notification onboarding").
  - What RN does: push only starts if `getStoredRelayBaseUrl()` is non-null (`RN: App.tsx:353-354`), i.e. the user must find Settings → Notifications and press Enable; nothing invites them.
  - Fix hint: on first authenticated launch, prompt once (with "don't ask again" persisted per account) and call `setupPushNotifications({ relayBaseUrl: DEFAULT_RELAY_BASE_URL })`.

- [x] **Notification sound settings are dead** — fixed in f6f26f7 — `P3` — `partial` — controls removed, channel hint shown; store keys dropped in the settings-store pass
  - What WEB does: `notificationSoundChoice` picks one of 5 sounds with preview; email/calendar sound toggles gate playback (`lib/notification-sound.ts`, `notification-settings.tsx:305-331`).
  - What RN does: `NotificationSettings.tsx:203-250` renders a sound `Select` (values `chime/ping/pop/none` that exist nowhere), a preview button without `onPress`, and email/calendar sound toggles that no code reads; the Android channel `bulwark_mail` uses the default sound and cannot change it after creation (`BulwarkMessagingService.kt:62-78`).
  - Fix hint: on Android sounds belong to channels: create one channel per sound choice (or open the system channel settings via `Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS`), and remove the toggles that cannot be honoured.

### i18n and locales

- [x] **12 of WEB's 27 locales missing in RN** — fixed in 990cd84 — `P2` — `missing`
  - What WEB does: `ar ca cs da de en es fa fr he hu it ja ko lv mn nb nl pl pt ro ru sk tr uk zh zh-TW` (`i18n/routing.ts:15`).
  - What RN does: `SUPPORTED_LOCALES` has 15 (`RN: src/i18n/index.ts:21-37`); `scripts/sync-locales.mjs` copies every WEB folder (`:32-42`) but `locales/` only contains the 15 and the index imports them statically. Missing: ar, ca, da, fa, he, hu, mn, nb, ro, sk, tr, zh-TW.
  - Fix hint: run the sync script, add the imports/labels, and handle `zh-TW` (region subtag) in `detectDeviceLocale` which only compares `languageCode` (`:45-52`).

- [x] **Vendored catalogs are stale and drift from WEB** — fixed in 990cd84 — `P2` — `partial` — RN-only keys live in locales/rn/<lang>.json (merged at runtime); sync-locales.mjs --check reports drift
  - What WEB does: `locales/en/common.json` has 2959 leaf keys (2026-08-29).
  - What RN does: `RN: locales/en/common.json` last synced 2026-07-22 has 2336 keys; 640 WEB keys are absent; RN en carries 17 keys WEB lacks (hand-added `email_composer.*`) which the 14 other RN locales do not have (de/fr/ja each miss the same 16 keys), and 19 keys RN code calls (`email_composer.schedule_*`, `email_list.no_*_folder`) exist in no catalog, so the inline fallback always shows in every language.
  - Fix hint: make `sync-locales.mjs` merge instead of overwrite (keep RN-only keys under a separate `locales/rn/<lang>.json` overlay), add a key-parity test like WEB's translation coverage test, and run it in CI.

- [x] **`translate()` has no interpolation, no plurals, no rich text** — fixed in 990cd84 — `P2` — `partial` — hand-rolled plurals replaced in OfflineBanner/AboutData/Layout/Identity/Templates (8deff66, 22697fd); rich text (tags) not needed by any RN string
  - What WEB does: next-intl ICU messages (`{count, plural, ...}`, `{name}` args).
  - What RN does: plain nested lookup returning the raw string (`RN: src/i18n/index.ts:54-71`); any WEB string with `{placeholder}` renders literally, and plurals are hand-rolled English (`OfflineBanner.tsx:22`, `AboutDataSettings.tsx:96,176,190`, `LayoutSettings.tsx:148-149`).
  - Fix hint: add `t(key, fallback, params)` with `{name}` substitution and a minimal ICU plural (`intl-messageformat` is small and works on Hermes), then replace the hand-rolled plurals.

- [ ] **No RTL support (ar/he/fa)** — `P2` — `missing` — done in 990cd84: forceRTL/allowRTL on override + restart hint, isLayoutRTL() helper in src/i18n; deferred: SwipeableRow side swap (mail-list agent's file - call isLayoutRTL() there)
  - What WEB does: `getLocaleDirection` sets `dir=rtl`, logical CSS, JS popovers flip, RTL-aware swipe (`i18n/direction.ts`; changelog 1.7.0-1.7.3 RTL entries).
  - What RN does: ar, he and fa ship since 990cd84, which also calls `I18nManager.forceRTL`/`allowRTL` when the language override changes (after a restart); mail bodies get `dir="auto"` since 910c503 (audit U4). `SwipeableRow` still maps left/right physically.
  - Fix hint: when adding ar/he/fa, call `I18nManager.forceRTL(dir==='rtl')` + `allowRTL` on override change (requires reload), audit `paddingLeft/Right` → `paddingStart/End`, and swap swipe actions when `I18nManager.isRTL`.

- [ ] **Language list not localized and no "auto" date locale** — `P3` — `partial` — deferred: language labels are native names (webmail parity); timeZone landed as calendarTimeZone (calendar agent); dateLocale needs a locale override threaded through src/lib/date-format.ts call sites in other areas
  - What WEB does: language picker sorted, flags, `dateLocale` (auto/iso/en-GB/en-US), `firstDayOfWeek`, `timeZone` on the Language tab (`components/settings/language-settings.tsx` `updateSetting('dateLocale'|'firstDayOfWeek'|'timeZone'`).
  - What RN does: `LanguageSettings.tsx` offers language, `dateFormat`, `timeFormat` only; day-of-week lives under Calendar; no time zone.
  - Fix hint: add `dateLocale` and `timeZone` keys and thread them through `src/lib/date-format.ts` (`Intl.DateTimeFormat(locale, { timeZone })`).

### Themes and appearance

- [ ] **Font size setting is honoured by the mail list only** — `P3` — `partial` — deferred: Text.defaultProps is gone on the new architecture; needs the static typography import replaced by useTypography() per screen
  - What WEB does: `--font-size-base` on `:root` scales everything (`stores/settings-store.ts:1264-1274`).
  - What RN does: `useTypography()` (`RN: src/theme/dynamic.ts:47-68`) is used by EmailListScreen and its attachment chips only; the other screens spread the static `typography` from `tokens.ts`, so Small/Large changes almost nothing (the thread reader, compose, settings, calendar, contacts all stay fixed).
  - Fix hint: either make `tokens.typography` a hook-backed getter or, cheaper, set `Text.defaultProps`/`maxFontSizeMultiplier` and scale via `allowFontScaling` + a root `PixelRatio` factor.

- [x] **`animationsEnabled` ignored by most animations; no reduce-motion respect** — fixed in 3ae9bbe — `P3` — `partial` — useShouldAnimate ORs in AccessibilityInfo.isReduceMotionEnabled; the 18 fixed-duration Animated.timing calls in other areas' files still need useAnimDuration
  - What WEB does: `--transition-duration: 0s` when off (`stores/settings-store.ts:1322-1331`) and `@media (prefers-reduced-motion: reduce)` (`app/globals.css:681`).
  - What RN does: 18 files call `Animated.timing`/`LayoutAnimation` with literal durations (e.g. `UndoSnackbar.tsx:32-42`, every sheet, `SwipeableRow.tsx`); `useAnimDuration` used in 3. `AccessibilityInfo.isReduceMotionEnabled` is never consulted.
  - Fix hint: route durations through `useAnimDuration` and OR in `AccessibilityInfo.isReduceMotionEnabled()` inside `useShouldAnimate`.

- [x] **Density preview and other hard-coded dark colours break on the light theme** — fixed in 22697fd — `P3` — `rn-only-bug` — Appearance/Themes/SidebarApps/settings-section/OfflineBanner/SettingsScreen badge use tokens; Plugins pane replaced
  - What WEB does: preview uses tokens (`components/settings/appearance-settings.tsx:21-64`).
  - What RN does: `AppearanceSettings.tsx:63` paints read subjects `rgba(250,250,250,0.8)` and `:193` preview text `rgba(161,161,170,0.7)` regardless of theme, so the preview is near-invisible on light. Similar literals: `PluginsSettings.tsx:27-30`, `ThemesSettings.tsx:108`, `SidebarAppsSettings.tsx:86,238,296`, `OfflineBanner.tsx:43` (`#a16207`), `SettingsScreen.tsx:382`.
  - Fix hint: replace with `c.textSecondary`/`c.mutedForeground`/`c.warningBg` tokens.

- [x] **`userInterfaceStyle: 'dark'` likely defeats the "System" theme on iOS** — fixed in 5802cae — `P3` — `bug` (verify) — userInterfaceStyle automatic + light/dark splash
  - What WEB does: `system` follows `prefers-color-scheme` (`stores/theme-store.ts:53-56`).
  - What RN does: `RN: app.config.js:33` sets `userInterfaceStyle: 'dark'`, which prebuild writes as `UIUserInterfaceStyle = Dark` in Info.plist, so `useColorScheme()` (`src/theme/colors.ts:16`, `App.tsx:220`) always returns `dark` and "System" behaves like "Dark". On Android without `expo-system-ui` (not in `package.json`) the key is ignored with a prebuild warning, so Android is probably fine. Splash background is also dark-only (`:38`).
  - Fix hint: set `userInterfaceStyle: 'automatic'` and give the splash a light variant (`splash.dark`).

- [x] **Themes tab is a stub with fake themes; `activeThemeId` never applied** — fixed in fe45a44 — `P3` — `missing` (record as N/A for now) — Qui/Nord/Catppuccin/Solarized token sets generated from lib/builtin-themes.ts (src/theme/builtin-themes.ts); useColors() applies activeThemeId; upload button removed; Roundcube Elastic and Aurora Glass added in 7964e64, "Flat fields" not ported
  - What WEB does: 6 built-in themes (`lib/builtin-themes.ts:879-936`), zip upload, marketplace, admin forced/default theme, compiled CSS tokens, PWA theme-color meta (`stores/theme-store.ts`).
  - What RN does: `ThemesSettings.tsx:18-22` lists `Default/Qui/Sepia` (Qui exists in WEB; Sepia does not), stores `activeThemeId` that nothing reads, "Upload .zip" has no handler (`:81-83`); the tab is marked Experimental.
  - Fix hint: minimal viable subset = map WEB's built-in theme token sets (`builtin-themes.ts` light/dark `colors`) onto `ThemePalette` and let `useColors()` pick `activeThemeId`; remove the upload button. Otherwise hide the tab.

- [ ] **Status bar / navigation bar theming partial** — `P3` — `partial` — deferred: expo-navigation-bar / expo-system-ui are not installed; add one and call setBackgroundColorAsync(c.background) on theme change
  - What WEB does: theme-color meta follows active theme (#671).
  - What RN does: `StatusBar style` is derived (`App.tsx:219-223`) but the Android navigation bar (edge-to-edge is on, `app.config.js:56`) is never themed, and the bottom tab bar/`SafeAreaView` colours come from `useColors` so they are fine.
  - Fix hint: `expo-navigation-bar`/`SystemUI.setBackgroundColorAsync(c.background)` on theme change.

### Updates

- [x] **No severity concept; security/deprecated updates are dismissable** — fixed in 431face — `P3` — `partial` — severity:/advisory: lines in the release body
  - What WEB does: server-side check against `version.telemetry.bulwarkmail.org` with `severity` (normal/security/deprecated), red non-dismissable banner for security/deprecated, stale cached status discarded after upgrade (`lib/version-check/sender.ts:86-96`, `stores/update-store.ts:86-122`, commit 39dcc6b2).
  - What RN does: GitHub Releases `latest` only (`RN: src/api/updates.ts:57-91`); banner dismissed per tag (`UpdateBanner.tsx:21`, `updates-store.ts:136-146`); no notion of a mandatory update; no advisory link.
  - Fix hint: have the version server add a `native` channel (or read a `severity:` line from the release body) and make the banner non-dismissable when `security`/`deprecated`.

- [x] **Update check hits the GitHub API unauthenticated and blocks on companion downloads** — fixed in 431face — `P3` — `rn-only-bug`
  - What RN does: `fetchLatestRelease` calls `api.github.com` (60 req/h/IP) and then downloads the `.apk.sha256` asset on every check (`RN: src/api/updates.ts:44-55,74-81`); on rate-limit the store shows `GitHub API 403` under "Last checked" with no backoff other than the 6 h interval.
  - Fix hint: treat 403/429 as "skip until next interval" without surfacing an error, fetch the checksum only when the user taps Install.

- [x] **Release notes rendered raw** — fixed in 431face — `P3` — `partial`
  - What RN does: `cachedLatest.body` shown as plain text, 20 lines (`UpdatesSettings.tsx:187-194`); markdown headings/links appear literally.
  - Fix hint: strip markdown or use a tiny renderer; link to `htmlUrl`.

### Plugins, extensions, S/MIME, sidebar apps (mostly N/A / out of scope for now)

- [x] **Plugins tab is a non-functional stub** — fixed in 3d0d440 — `P3` — `missing` (N/A for now) — tab hidden; pane is an explainer
  - What WEB does: sandboxed iframe plugin runtime, marketplace, signing, admin approval, ~40 hooks/API methods (changelog 1.5.x-1.9.x Plugins entries).
  - What RN does: `PluginsSettings.tsx:41` starts with `plugins = []`, "Upload .zip" has no handler (`:176-178`), `pluginEnabled` map persists toggles for nothing.
  - Fix hint: out of scope; hide the tab (or keep it as an "install from webmail" explainer). Minimal viable subset would be theme-only plugins (token sets) once the Themes finding lands.

- [x] **S/MIME tab is a stub** — fixed in 3d0d440 — `P3` — `missing` (N/A for now)
  - What WEB does: S/MIME moved out of core into a privileged crypto plugin (changelog 1.6.0 "Breaking"); core exposes key/cert management on the Security tab.
  - What RN does: `SmimeSettings.tsx:32-33` uses empty `MOCK_KEYS`/`MOCK_CERTS`; Import buttons have no handlers (`:118-120,163-165`); three toggles persist unused prefs; the tab is labelled implemented and lives under Privacy.
  - Fix hint: mark `implemented: false` in `SettingsScreen.tsx:97` until a native crypto path exists.

- [ ] **Sidebar apps: settings exist, apps never rendered; no admin defaults (#931)** — `P3` — `partial` — deferred: useMobileSidebarApps()/openSidebarApp() in src/lib/sidebar-apps.ts (0e63d45) ready for SidebarDrawer (mail-list agent's file); admin defaults N/A
  - What WEB does: apps render in the navigation rail (`components/layout/navigation-rail.tsx:391` filters `showOnMobile`), inline iframe or new tab, `keepAppsLoaded`, drag reorder, plus operator-pinned apps merged from policy (`lib/sidebar-apps.ts:103-112`, commit 4fe5701b).
  - What RN does: `SidebarAppsSettings.tsx` adds/edits/removes entries into `sidebarApps` (`settings-store.ts:502-523`) but `SidebarDrawer.tsx` never reads them (grep: no usage outside settings); reorder handle is decorative (`:72`).
  - Fix hint: minimal viable subset = list `sidebarApps.filter(showOnMobile)` at the bottom of `SidebarDrawer`, open with `expo-web-browser` (`openMode:'tab'`) or a `react-native-webview` screen (`inline`); admin defaults are N/A without a policy source (could be read from a webmail `/api/config` if the webmail origin becomes known).

### Misc UI

- [x] **Deep-link scheme registered but nothing handles it** — fixed in 5802cae — `P2` — `missing` — bulwarkmobile://, webmail https permalinks, mailto: (scheme + SENDTO filter) and ACTION_SEND/SEND_MULTIPLE share targets → Compose; iOS universal links still deferred; shared files never uploaded, `SENDTO` opened the inbox and `+` addresses opened nothing until cd4ce9d, 06e8942 and ee652d3 (audit B9–B11)
  - What WEB does: permalinks for mail/calendar/contacts/files/settings with build/parse helpers (`lib/deep-links.ts:196-235,272-311,322-370,379-414`), `mailto:` opens the built-in composer, protocol handler registration, `webcal:`.
  - What RN does: `scheme: 'bulwarkmobile'` (`RN: app.config.js:29`) and a `VIEW`/`BROWSABLE` intent filter (`AndroidManifest.xml:25-30`) exist, but `NavigationContainer` has no `linking` prop (`App.tsx:443`) and there is no `Linking.getInitialURL`/`addEventListener('url')` anywhere, so tapping a `bulwarkmobile://` URL merely launches the app. No `https` App Links for the webmail permalink format, no `mailto:` intent filter (tapping a mailto link in another app never offers Bulwark), no `SEND`/`SEND_MULTIPLE` share target.
  - Fix hint: add a `linking` config mapping `bulwarkmobile://mail/message/:emailId`, `/calendar/event/:id`, `/contacts/:id`, `/settings/:tab` to the existing routes (`src/navigation/types.ts`), reuse WEB's path grammar so a webmail permalink can be rewritten; add `<data android:scheme="mailto"/>` and `ACTION_SEND` (`text/*`, `image/*`) filters routed to `Compose` with `prefillTo`/attachments. iOS: `CFBundleURLTypes` via `scheme` is already emitted; add `associatedDomains` for universal links later.

- [x] **No general toast system; only the email undo snackbar** — fixed in 3ae9bbe — `P3` — `partial` — src/stores/toast-store.ts + ToastHost mounted in App.tsx; Alert.alert call sites not migrated
  - What WEB does: typed toasts with title/message, primary+secondary actions, progress bar, pause-on-hover, 10 s for errors (`stores/toast-store.ts`, `components/ui/toast.tsx`), used for every post-action acknowledgement (move toast shows full folder path, send-delay toast with "Send now").
  - What RN does: `UndoSnackbar.tsx` is bound to `useEmailStore.pendingUndo` only; 23 files use `Alert.alert` (modal, blocking) for confirmations and errors; success acknowledgements mostly absent.
  - Fix hint: generalise `UndoSnackbar` into a `toast-store` (queue, type, action) and mount one host in `App.tsx`; migrate error `Alert.alert`s that need no decision.

- [x] **No prompt dialog; Dialog is confirm-only and untranslated** — fixed in 3ae9bbe — `P3` — `partial`
  - What WEB does: `components/ui/confirm-dialog.tsx` and `prompt-dialog.tsx` (text input), `useConfirmDialog` hook.
  - What RN does: `Dialog.tsx:8-17` takes title/message/confirm/cancel with English defaults `'Confirm'`/`'Cancel'` (`:33-34`); text prompts are ad-hoc `TextInput`s.
  - Fix hint: add an `input` prop and default the labels via `t('common.confirm')`/`t('common.cancel')`.

- [x] **Offline banner not localized; no "reconnect" retry surface** — fixed in 990cd84 — `P3` — `partial`
  - What WEB does: `online` event triggers refetch (`components/mail/mail-app.tsx:269-278`, `lib/jmap/client.ts:7398`); strings come from catalogs.
  - What RN does: `OfflineBanner.tsx:22-29` hard-codes "You are offline" with an English plural; network-store logic itself is sound (`network-store.ts:16-22` treats `isInternetReachable === null` as online) and App.tsx retries the session on reconnect (`:245-252`).
  - Fix hint: `t('common.offline', ...)` and reuse plural helper once interpolation exists.

- [x] **Accessibility labels almost absent** — `P3` — `partial` — done in my files (RadioGroup/Select roles, Dialog header, Settings back button, ToastHost, UpdateBanner, AccountSettings, security key rows); the mail list, composer, Files, contacts, sign-in and settings switches followed in 9c0c35c, 771558d, aab29da, d59c571, 5801d6c, cb5c152 and c1e5cd6, and the viewer, calendar, tab bar, unified inbox and drawer in 13cba64, b3a82f1, 84fef14 and b178ee8 (audit U8)
  - What WEB does: aria-labels on icon buttons, `role="checkbox"`, screen-reader improvements (changelog 1.8.0 Navigation).
  - What RN does: `accessibilityLabel`/`Role` appear in 8 of 94 `.tsx` files (FilesScreen 4, EmailListScreen 3, login 4, EmailThreadScreen 2, ToggleSwitch 1). Icon-only `Pressable`s in settings (`SettingsScreen.tsx:217-222` back button, `SidebarAppsSettings.tsx:91-96`, `SmimeSettings.tsx:91-106`, `UpdateBanner.tsx:40`), the tab bar badge and the `RadioGroup`/`Select` in `settings-section.tsx` have none.
  - Fix hint: give every icon-only Pressable an `accessibilityLabel` + `accessibilityRole="button"`, `ToggleSwitch` `accessibilityRole="switch"` + `accessibilityState`, `RadioGroup` options `radio`.

- [x] **No haptic feedback** — fixed in 3ae9bbe — `P3` — `missing` (mobile-only nicety) — expo-haptics + src/lib/haptics.ts haptic(kind); SwipeableRow/undo wiring is the mail-list agent's (call haptic('light') at threshold, haptic('success') on undo)
  - What RN does: `VIBRATE` permission exists only for the notification channel; no `expo-haptics` in `package.json`; swipe-to-action, undo and destructive confirms give no tactile feedback.
  - Fix hint: `expo-haptics` `impactAsync(Light)` on swipe threshold cross and `notificationAsync(Success/Warning)` on undo/destructive.

- [x] **Version badge / "update available" tag missing from About** — fixed in 8deff66 — `P3` — `partial`
  - What WEB does: About card shows version, commit and an `update: x.y.z` / `security` pill (`components/settings/about-data-settings.tsx:20-49`).
  - What RN does: `AboutDataSettings.tsx:114-134` shows version+commit; update info lives only in the (Android-only) Updates tab; on iOS nothing indicates a newer build exists.
  - Fix hint: reuse `useUpdatesStore.hasUpdate()` for a pill; on iOS link to TestFlight/App Store instead of Install.

## Verified at parity (do not redo)

- Per-account push registry keys, legacy key migration, in-flight coalescing, relay register/verify/active/unregister endpoint usage, 90-day expiry with 7-day refresh, relay-confirmed-dead reaping: `RN: src/lib/push-notifications.ts:16-95,271-298,342-383,411-439` match `lib/web-push.ts:16-25,334-389,448-489` and `repos/relay/README.md` endpoints.
- Notification tap routing switches account before navigating (`RN: App.tsx:58-78`), cold-start tap via `NotificationTapStore`.
- Headless task respects `emailNotificationsEnabled` and restores the active account afterwards (`push-background-task.ts:32-41,136-144`).
- Relay treats `EmailPush` bodies and forwards only ids (`repos/relay/src/payload.ts`); RN register payload shape (`subscriptionId`, `fcmToken`, `accountLabel`) matches `handleRegister`.
- Update cache staleness after upgrade (#913 analogue): RN compares `cachedLatest.tag` to the running version at read time (`updates-store.ts:150-156`), so a cached "newer" release cannot survive an upgrade. `version-compare.ts` semantics match WEB `lib/version-compare.ts`.
- APK download: size check, optional SHA-256 from companion asset or body, `REQUEST_INSTALL_PACKAGES`, installer intent (`install-update.ts`); Updates tab hidden off Android (`platform-capabilities.ts`, `SettingsScreen.tsx:145-147`); pending-APK polling every 30 s.
- Theme light/dark/system palette hook (`src/theme/colors.ts`), density/font hooks exist (`dynamic.ts`), status bar style follows theme (`App.tsx:219-223`).
- Language picker with system default, `dateFormat` preview, `timeFormat` (`LanguageSettings.tsx`); locale override persisted (`locale-store.ts`); `t()` falls back en → fallback → key.
- Confirm dialog styling mirrors WEB confirm-dialog (`Dialog.tsx:19-27`); undo snackbar timer is `createdAt`-based so re-renders do not reset it.
- Offline detection via NetInfo with reachability fallback; outbox flush on reconnect (`App.tsx:289-295`).
- Hardware back closes a settings pane (`SettingsScreen.tsx:192-199`); settings groups/tabs mirror WEB's six groups.

## N/A on mobile

- Pro interface, toolbar position, hide account switcher / rail account list, hover actions & corners, favicon unread badge, keyboard shortcuts (`hooks/use-keyboard-shortcuts.ts`), guided tour / onboarding-on-new-devices, PWA install prompt & Apple touch icons, protocol handler page (`mailto:`/`webcal:` registration is done via intent filters instead — see deep-link finding), `protocolOpenMode`, admin policy lock/hide of settings, plugin sandbox/marketplace/signing, theme zip upload, telemetry (server-side), server-side version-check scheduler, `settingsSyncEnabled` config flag, `NEXT_PUBLIC_LOCALE_PREFIX` routing, calendar hover preview, mail layout (split/focus/horizontal), resizable columns (`stores/ui-store.ts`), `SETTINGS_DATA_DIR`/`SESSION_SECRET` encryption at rest (native has no server; use OS keystore semantics instead), spam-siege easter egg.
