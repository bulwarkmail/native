# Webmail 1.19.0 and 1.19.1

## Summary
The last pass (file 10) covered webmail 1.10.0 to 1.18.0 and the commits after the 1.18.0 release up to early 2026-10-29 (b0d1a97bb..4aea0976a). This file walks the changelog sections 1.19.0 (2026-10-29) and 1.19.1 (2026-10-31) and every webmail commit since (`git log --since=2026-10-29`, 237 commits; `4aea0976a..4887ed457` gives 238, the extra one is the plugin page fix #1358). There is no Unreleased section; 1.19.1 is the latest release. Checked against native main at 7a42a15f. Web paths are relative to the webmail root, native paths to this repo.

Many 1.19.0 entries were in "Unreleased" when file 10 was written and already have rows there (organisation policy, delegates, recover deleted items, shared tags and team templates, Files trash). They are not repeated; the unticked file 10 rows they touch are listed at the end.

Counts: 42 rows, P1 0, P2 11, P3 31.

What stands out:
- A forged From still gets the real sender's favicon or contact photo. The webmail shows a warning shield in its place now.
- The 1.19.1 booking, parcel and order cards are missing. The webmail's `lib/structured-mail` is plain TypeScript and takes the HTML parser as a parameter, so it can be ported.
- The 1.19.0 accessibility work has little counterpart on the phone: form fields without names, toasts and Undo not read out on iOS, grey text at 2.56:1 in the light theme, a mail body fixed at 14 px, and a "Plain Text Only" switch that promises plain-text reading but doesn't change it.
- Calendar: a cancellation mail can't remove the meeting, and the event and task editors throw typed changes away.

Classification: `bug` = fixed in the webmail, still live in the app; `missing`; `partial`. Not applicable on mobile and left out (same list as file 10): admin panel, plugins and marketplace, command palette, keyboard shortcuts and keyboard navigation, print, Bulwark Lite, CSP/third-party switch as a server feature, Mountain View, desktop-only layout (drag and drop, hover, multi-pane), server routes the app doesn't use, Docker, docs, demo mode and translation-only entries.

## Findings

### Reading mail

- [x] **A forged From keeps the real sender's favicon and contact photo** — `P2` — `bug` — fixed in 0b0fc021
  - What WEB does: when the sender check fails or is unverified, the avatar shows a warning shield instead of a photo, logo or initials, in the reader, the conversation and the list (`components/ui/avatar.tsx:323`, `hooks/use-sender-warning.ts:13`, `components/email/email-viewer.tsx:721`). The list fetch asks for `header:Authentication-Results:all` (`lib/jmap/client.ts:461`). 605a3983b (#1439).
  - What RN does: MessageHeader works out the verdict (`src/components/email/MessageHeader.tsx:118`) but renders SenderAvatar with the claimed address (`:175`); the same in thread cards (`src/components/email/ThreadMessageCard.tsx:50`) and list rows (`src/screens/EmailListScreen.tsx:213`). SenderAvatar picks a contact photo or the domain favicon (`src/components/SenderAvatar.tsx:62-65`). List rows have no auth data (`src/api/email.ts:23-26`).
  - Fix hint: pass a sender warning from getSenderVerification into SenderAvatar and draw a shield; for list rows add `header:Authentication-Results:all` to the list properties.

- [x] **No booking, parcel or order cards from schema.org markup** — `P2` — `missing` — fixed in 5f2ef4c1, a6066a09, cd677e77, 2055df8c, 982a30ef, c90a35c4, mounted in 90e4e230
  - What WEB does: reads JSON-LD/microdata booking markup and attached Wallet passes and shows a card above the message (flight, train, bus, hotel, rental car, event, restaurant, parcel tracking, order status) with copy buttons and links that show where they lead. Bookings go into a calendar the user picks with stable UIDs, so a later mail updates the event and a cancellation removes it. Gate: the receiving server verified the From domain, not a forward, not a personal mailbox provider, not turned off by the admin (`lib/structured-mail/index.ts:36`, `trust.ts:104`, `pkpass.ts`, `calendar.ts:147`, `components/email/structured-mail/use-booking-calendar.ts:115`, `lib/structured-mail-gate.ts:7`). a529e6e57..859d368a1.
  - What RN does: nothing; the only banners above the body are unsubscribe and invitation (`src/components/email/MessageContent.tsx:104`, `:112`).
  - Fix hint: port `lib/structured-mail/` with an RN-side HTML parser passed through `parseHtml` (`lib/structured-mail/index.ts:4-5`, `:21`) and build RN cards. The admin switch needs the org policy, so default on.

- [x] **"Plain Text Only" says it also changes reading, but the reader ignores it** — `P2` — `bug` — fixed in 7dc45778
  - What WEB does: reads HTML mail as plain text by default or per message (`lib/html-to-readable-text.ts:39`, `components/email/email-viewer.tsx`; 1e929b0a9).
  - What RN does: the switch reads "Compose and read in plain text only" (`src/components/settings/ReadingSettings.tsx:208-210`), but only the composer and the placeholder check read plainTextMode (`src/lib/compose-html.ts:175`, `src/lib/placeholder-check.ts:157`); EmailBodyView never does (`src/components/EmailBodyView.tsx:529-537`).
  - Fix hint: render the text part (or the HTML turned into text) when the setting is on, and add a per-message "Show as plain text".

- [x] **Mail body ignores the app's text size and iOS Dynamic Type** — `P2` — `missing` — fixed in 7b551fc3, a3650ebf
  - What WEB does: bodies follow the chosen text size, with a separate mail text size and a minimum font size (`lib/mail-reading.ts:32`, `:42`; c07ba1a37).
  - What RN does: the body is fixed at 14 px for HTML and plain text (`src/lib/email-html.ts:695`, `:979`); the app's text size scales only the app's own UI (`src/theme/dynamic.ts:48-69`). Android's WebView may follow the system font size (no textZoom set; unverified), iOS doesn't. Pinch zoom exists (`src/components/EmailBodyView.tsx:408`).
  - Fix hint: scale the body's base font size by the app setting and `PixelRatio.getFontScale()`.

- [ ] **Reading aids: paused animated images, reduce motion in mail, reader view, read aloud, reading width** — `P3` — `missing` — reduce motion and paused animated images fixed in 6d701c4b; not done: reader view, read aloud and reading width are left to the OS
  - What WEB does: animations in mail stop with reduce motion (24a13cc1f), animated images pause behind a play button (bb7869798), plus reader view, read aloud, reading mask and width (caed2d313, af3019ea2, a982c3f23, 8cc0f8f25, dcc0d600f).
  - What RN does: none. The app reads reduce motion (`src/theme/dynamic.ts:92`) but doesn't pass it into mail.
  - Fix hint: pass reduce motion into the body CSS (animation off, GIFs paused) first; read aloud and reader view are left to the OS.

- [ ] **No BIMI sender logos or verified-mark check** — `P3` — `missing`
  - What WEB does: when DMARC passes for the exact From domain the avatar shows the domain's BIMI logo before the favicon, with a check mark when a VMC/CMC backs it; DNS and certificate checks run on the webmail server (`lib/email-headers.ts:175`, `components/ui/avatar.tsx:292`, `app/api/bimi/route.ts:49`). cf0eb03c4.
  - What RN does: contact photo, DuckDuckGo favicon, initials (`src/components/SenderAvatar.tsx:38`, `:62-65`; `src/lib/avatar-utils.ts:149`).
  - Fix hint: use the paired webmail's `/api/bimi` once the app keeps the webmail URL (same blocker as the org policy, file 10).

- [x] **A DKIM pass reported only by `header.i` doesn't count (#1420)** — `P3` — `bug` — fixed in 49d43729
  - What WEB does: takes the signer domain from `header.i` when `header.d` is missing (`lib/email-headers.ts:282`, `:346`). f8f2e93cd.
  - What RN does: reads `header.d` only (`src/lib/email-headers.ts:397`); such mail shows as unverified and its invitations lose trust.
  - Fix hint: port identityDomain.

- [x] **Reply and quick reply are offered on drafts and scheduled messages in a conversation** — `P3` — `bug` — fixed in 35297379
  - What WEB does: hides Reply and Reply all on a conversation's drafts and scheduled messages (`components/email/email-viewer.tsx:881`). 8b29254a6 (#1404).
  - What RN does: every card is replyable (`src/screens/EmailThreadScreen.tsx:1212`, `src/components/email/ThreadMessageCard.tsx:68-85`); quick reply targets the last member, which can be the user's own draft (`src/screens/EmailThreadScreen.tsx:1124`).
  - Fix hint: `replyable={false}` for `$draft` and scheduled members; point quick reply at the newest message that is neither.

- [x] **Bounce and receipt report parts show as list chips and go along on forward** — `P3` — `bug` — fixed in 7772da84 (list chips, global- types), 482e9a20 (forward, compose)
  - What WEB does: leaves `message/delivery-status`, `message/disposition-notification` and their `global-` forms out of list chips and forwards (`lib/attachment-visibility.ts:73`, `components/email/email-composer.tsx:985`). 8a09ba573.
  - What RN does: the reader hides them (`src/lib/attachment-display.ts:56`, `:130`), list chips and forwards don't (`src/lib/list-attachments.ts:21`, `src/lib/reply-compose.ts:14-19`); isReportPart misses the `global-` types.
  - Fix hint: filter isReportPart in both places and add the two global types.

- [x] **Attachment icons in the reader aren't coloured by file type** — `P3` — `partial` — fixed in 4849cf23
  - What WEB does: reader chips use the list's per-type icon and colour (`components/email/attachment-chips.tsx`). a78d03a18.
  - What RN does: list chips are typed (`src/components/email/ListAttachmentChips.tsx:96`), reader chips use a plain paperclip (`src/components/email/AttachmentChips.tsx:244`).
  - Fix hint: reuse attachmentKind in AttachmentChips.

- [x] **Avatar initials are always white, even on light colours** — `P3` — `bug` — fixed in 6f66fa06
  - What WEB does: picks black or white initials by contrast (`components/ui/avatar.tsx:174-182`; 2e13accad).
  - What RN does: always `#ffffff` (`src/components/SenderAvatar.tsx:130-133`); several palette colours give 3.1 to 3.7:1 (`src/lib/avatar-utils.ts:19-20`, `:47-48`).
  - Fix hint: port initialsColor.

### Mail list and search

- [x] **Search results can't be moved into the open folder (#1452)** — `P3` — `bug` — fixed in 9a4515f9
  - What WEB does: a search across folders keeps the open folder selected, and hits from other folders can move into it (`lib/move-targets.ts:71`). dafdda534.
  - What RN does: the move sheet greys out the current folder (`src/components/MoveSheet.tsx:110-115`) and the single-row pick returns on it (`src/screens/EmailListScreen.tsx:1904-1918`), even for rows from other folders.
  - Fix hint: in search mode mark a folder current only when the rows are already in it.

- [x] **No Undo for read/unread, star and tag changes** — `P3` — `missing` — fixed in da1da0ec
  - What WEB does: the toast offers Undo and puts back each message's previous keywords (`lib/email-action-toast.ts:86`). ee17c0dba.
  - What RN does: UndoEntry covers archive, delete, move and spam only (`src/stores/email-store.ts:322`).
  - Fix hint: a `keywords` undo kind with the original keywords per item.

- [x] **No Sort menu in the list header** — `P3` — `partial` — fixed in 1cbe28b1, beff8744
  - What WEB does: Sort menu with the order presets in the list header (`components/email/mail-list-menus.tsx`). e3f1ccce7.
  - What RN does: the header only flips the direction (`src/screens/EmailListScreen.tsx:1193`); presets live in Settings > Layout (`src/components/settings/LayoutSettings.tsx:88-104`).
  - Fix hint: a sort button that opens the presets.

- [x] **Tag counts don't use Keyword/get where the server counts keywords (#1399)** — `P3` — `missing` — fixed in eb6bf6d3
  - What WEB does: one Keyword/get when the capability has `supportsCounts`, else two Email/query per tag (`lib/jmap/client.ts:2721`, `:2737`).
  - What RN does: always two queries per tag (`src/api/tag-counts.ts:22-40`).
  - Fix hint: same check and fallback. Stalwart doesn't advertise counts, so low value.

- [x] **The folder list doesn't say which folder is open, and the unread count reads "Show unread"** — `P3` — `bug` — fixed in e3a34eb1
  - What WEB does: says which folder is open and how many are unread (7c282f1f4, 80a2a212a).
  - What RN does: folder rows have no selected state (`src/components/SidebarDrawer.tsx:170-180`); the count is a button labelled "Show unread" (`:126-133`).
  - Fix hint: `accessibilityState.selected` and a label like "Inbox, 3 unread".

### Composer and sending

- [x] **Quick reply skips the placeholder, forgotten-attachment and confirm checks** — `P3` — `bug` — fixed in db8eb731
  - What WEB does: quick reply runs the composer's checks (`lib/outgoing/quick-reply.ts:34`). 534049952.
  - What RN does: the composer has them (`src/screens/ComposeScreen.tsx:2078`, `:2137`), QuickReplyBox sends straight away (`src/components/email/QuickReplyBox.tsx:78-140`).
  - Fix hint: run unfilledPlaceholdersInMessage and the attachment keyword check before send.

- [x] **Quoted reply history isn't collapsed in the composer** — `P3` — `missing` — fixed in 9fd80993
  - What WEB does: collapses the quote behind an ellipsis button (`components/email/reply-quote-collapse.ts:13`). 9e0089604 (#1405).
  - What RN does: seeds the full quote into the editor (`src/screens/ComposeScreen.tsx:562-615`).
  - Fix hint: hide the quoted block in the editor behind a toggle, keep it in the sent body.

- [x] **Tag picker can't make a tag; template picker can't open the template manager** — `P3` — `missing` — fixed in e09cd395 (new tag), 2c1f266f (template manager, compose)
  - What WEB does: "New tag" in the tag picker (`components/email/tag-picker.tsx:214`), "Manage" in the template picker (`components/templates/template-picker.tsx:227`). 19676a14f.
  - What RN does: tag sheets list existing tags only (`src/screens/EmailThreadScreen.tsx:1489`, `src/components/TagSheet.tsx`); the template sheet shows "No templates yet" with no way on (`src/components/TemplateSheet.tsx:148-150`).
  - Fix hint: a "New tag" row and a "Manage templates" link.

- [x] **No optional confirm before sending, deleting or archiving** — `P3` — `missing` — fixed in db8eb731 (send, composer and quick reply), 9794dc03 (delete and archive)
  - What WEB does: `sendConfirmation`, `confirmDelete`, `confirmArchive` (`components/email/email-composer.tsx:501`, `lib/mail-removal-confirm.ts:24`, `lib/accessibility-settings.ts:93-94`). 4d91d9b29, 374ae9c8d.
  - What RN does: asks only before a permanent delete (`src/lib/delete-confirm.ts:27`).
  - Fix hint: three settings and an Alert in the send, delete and archive paths, swipes and quick reply included.

- [ ] **No alt-text prompt for images, no default compose font** — `P3` — `missing` — alt-text prompt fixed in 303dea01; not done: default compose font and size, which needs a font setting with switches in the settings pages
  - What WEB does: asks for alt text when an image goes in (`components/email/image-alt-dialog.tsx`; 53cb49d3c), starts new mail in a chosen font and size (1b24c1980), offers an accessible example template (420bf8f9a).
  - What RN does: alt is the file name (`src/screens/ComposeScreen.tsx:1857`, `src/lib/editor-html.ts:413-419`); the editor font is fixed (`src/lib/editor-html.ts:160`).
  - Fix hint: the alt prompt first.

### Accessibility

- [x] **No Accessibility page or presets** — `P2` — `missing` — fixed in c9b3bdfe
  - What WEB does: Settings > Accessibility with presets (screen reader, low vision, dyslexia, focus, motor, motion, hearing) and text size 87.5% to 200% (`components/settings/accessibility-settings.tsx`, `lib/accessibility-presets.ts:23`, `lib/accessibility-settings.ts:13-22`; 8008393e5, 0731d24f6).
  - What RN does: no page (`src/screens/SettingsScreen.tsx:150-174`); text size 0.92/1/1.12 (`src/theme/dynamic.ts:14-18`). Text follows the system font scale; reduce motion follows the system (`src/theme/dynamic.ts:88-120`).
  - Fix hint: a page that groups the existing switches, widens the text size range and takes the presets that make sense on a phone.

- [x] **Form fields have no name for screen readers** — `P2` — `bug` — fixed in ff5a8c91 (settings and sign-in), 98b962a8 (composer, quick reply, folder name prompt, template search), 3c3274e4 (mail search, filter panel, unified search), 7ba00be6 (contact form, event editor, calendar, contacts and files sheets, auto-reply)
  - What WEB does: every field has a label tied to it (`components/ui/field.tsx:42`; ef13556a0, 0e2a05e0e, dcc21acd0, 4e2affe40, f73643bbb).
  - What RN does: the shared Input draws its label as separate Text (`src/components/Input.tsx:40-55`); the Security password and code fields have no label at all (`src/components/settings/AccountSecuritySettings.tsx:181`, `:191`, `:198`); contact fields rely on placeholders (`src/screens/ContactFormScreen.tsx:823-834`); the reminder field's only name is "30" (`src/components/calendar/EventModal.tsx:772`, `:817`).
  - Fix hint: Input passes its label as accessibilityLabel; every bare TextInput gets one.

- [x] **Toasts and Undo are not read out on iOS; the Undo bar isn't read out anywhere** — `P2` — `bug` — fixed in d812caf0, 01dd7461
  - What WEB does: live regions and announcements for toasts, loads, new mail, saved drafts and offline (`lib/announce.ts:124`, `components/ui/toast.tsx:471`; 36d13b76b, e2fc2c750, 23813be9b, d713d31af, 4c1f24947).
  - What RN does: no `announceForAccessibility` call in src; ToastHost and OfflineBanner use accessibilityLiveRegion, which only Android honours (`src/components/ToastHost.tsx:194`, `src/components/OfflineBanner.tsx:33`); the Undo bar has neither (`src/components/UndoSnackbar.tsx:129-160`).
  - Fix hint: announce through AccessibilityInfo on iOS, live region on the Undo bar.

- [x] **Grey text is below 4.5:1 contrast** — `P2` — `bug` — fixed in 11522995
  - What WEB does: every built-in theme at 4.5:1 or more, with a contrast test (`lib/builtin-themes.ts:16`, `lib/__tests__/theme-contrast.test.ts`; 9f6c7b99c).
  - What RN does: textMuted is `#94a3b8` on white in the light theme (2.56:1) and `#737373` in dark (4.18:1 on the background, 3.19:1 on surfaces) (`src/theme/tokens.ts:236`, `:140`); used in 456 places, also as placeholder colour.
  - Fix hint: adjust both, add a contrast test over tokens.ts and builtin-themes.ts.

- [x] **The calendar grid reads poorly with a screen reader** — `P2` — `bug` — fixed in 294023e2
  - What WEB does: events sit inside their day cell and day cells have full date names (0026abba4, 19e0acde9).
  - What RN does: month day cells read only the number and the dots are silent (`src/components/calendar/MonthView.tsx:199-240`); event blocks have no role, label or date (`src/components/calendar/EventBlock.tsx:72-104`).
  - Fix hint: label day cells with date and event count; event blocks get a button role and a label with title, date and time.

- [ ] **No reading fonts, text spacing, more contrast or underlined links** — `P3` — `missing` — not done: own feature, not in this run
  - What WEB does: Atkinson Hyperlegible Next, Lexend, OpenDyslexic, spacing settings, more contrast, underlined links (`lib/accessibility-settings.ts:53-68`; 8008393e5, da215b8c0).
  - What RN does: none of these settings (`src/stores/settings-store.ts`).
  - Fix hint: the dyslexia font and line spacing first.

- [ ] **No colour-blind palette and no names next to colours** — `P3` — `missing` — not done: own feature, not in this run
  - What WEB does: a colour-blind-safe palette, a tag's letter in its dot, the calendar's name on events (cf4d02b49, d5d7d39ef, 396290003).
  - What RN does: colours only (`src/components/calendar/EventBlock.tsx:72-104`, `src/components/calendar/MonthView.tsx:233-240`).

- [x] **Toast and Undo times are fixed and short** — `P3` — `missing` — fixed in c9b3bdfe
  - What WEB does: one duration setting, 5 to 60 s or until closed (`lib/toast-duration.ts:7-15`; 8d2ebccf0, be5e2dbc5).
  - What RN does: 5 s, errors 10 s (`src/stores/toast-store.ts:44`), Undo 5 s (`src/components/UndoSnackbar.tsx:15`).
  - Fix hint: a duration setting and a longer default while a screen reader is on.

- [ ] **No plain language and no explanations for technical terms** — `P3` — `missing` — not done: own feature, not in this run
  - What WEB does: simpler English and German wording (`i18n/plain-language.ts`; bb739c744, 9861af6be, 5ffecf692) and term explanations (`components/ui/term.tsx`; 724c45d6e).
  - What RN does: none (`src/i18n/index.ts:79-140`).

- [ ] **Accessibility statement, help and sign-language links aren't shown** — `P3` — `missing`
  - What WEB does: shows the operator's links from the public `/api/config` (`app/api/config/route.ts:104`; 315e29270, 623c9e179).
  - What RN does: About has only the app's own links (`src/lib/about-links.ts:5-28`); the webmail URL isn't kept (`src/lib/oauth-native.ts:93-108`).
  - Fix hint: keep the paired webmail URL (also needed for the org policy) and read `/api/config`.

### Accounts and sign-in

- [x] **The two-factor prompt shows as a red error (#1422)** — `P3` — `bug` — fixed in b205c13a
  - What WEB does: an info box with role status, no shake (`app/(main)/[locale]/login/page.tsx:1393`; 141190708).
  - What RN does: TotpRequiredError sets a notice (`src/screens/LoginScreen.tsx:389-391`) shown in the error tone (`src/screens/login/PasswordStep.tsx:151`, `src/screens/login/LoginNotice.tsx:15-24`).
  - Fix hint: `tone="info"` for the TOTP step.

- [x] **Two accounts with the same name look alike in the switcher** — `P3` — `bug` — fixed in 505fbc59 (Settings > Account and the shared accountRowText) and 97173d4a (the switcher rows in SidebarDrawer); the port waits for question 9
  - What WEB does: the address becomes the title when another account shares the name (`lib/account-utils.ts:159`; 3bb9f7df8).
  - What RN does: name as title, address below (`src/components/SidebarDrawer.tsx:884-891`, `src/components/settings/AccountSettings.tsx:186`). Report question 9 (port in the label) is the same area.
  - Fix hint: port accountRowText.

- [ ] **An expired session drops the open composer without saving** — `P3` — `partial`
  - What WEB does: open composers save their drafts before the session ends and the login page says if one couldn't be saved (`stores/auth-store.ts` saveDraftsBeforeExpiry; 842c369fa).
  - What RN does: on a dead refresh the account is evicted with no draft flush (`src/stores/auth-store.ts:1138-1153`, `:1170-1180`). Read from the code, not tried on a device.
  - Fix hint: flush the open composer's autosave before eviction.

### Settings

- [x] **The density sample shows previews while "Show preview text" is off** — `P3` — `bug` — fixed in c8f417dd
  - What WEB does: c166651d1 (`components/settings/appearance-settings.tsx:14-16`).
  - What RN does: showPreview comes from the density only (`src/components/settings/AppearanceSettings.tsx:11-15`, `:24-27`).

- [x] **The identity editor closes without asking about unsaved changes** — `P3` — `bug` — fixed in 7ecac4ab
  - What WEB does: identity, rule and Sieve editors ask (`components/settings/use-discard-changes.tsx`; 9d3ae2203).
  - What RN does: Close, Cancel and Back call closeEditor (`src/components/settings/IdentitySettings.tsx:122`, `:304`, `:311`, `:389`). FilterRuleModal already asks.

### Calendar

- [x] **A cancellation mail can't remove the meeting from the calendar (#1425)** — `P2` — `missing` — fixed in a19afe9b
  - What WEB does: offers "Remove from calendar" for a trusted cancellation from the organizer, for the series or one occurrence, and says when it's outdated (`components/email/calendar-invitation-banner.tsx:627-635`, `:831`, `:1229`, `lib/calendar-cancellation.ts:49`; 357b6af3c).
  - What RN does: only "This event was cancelled" (`src/components/email/CalendarInvitationBanner.tsx:201`, `:270-272`); it already looks up the server copy (`:122`).
  - Fix hint: port planCancellationRemoval behind the banner's trust check.

- [x] **The event and task editors throw away typed changes on Close or Back** — `P2` — `bug` — fixed in 10e9f81d
  - What WEB does: asks before closing with unsaved changes (`components/calendar/event-modal.tsx:530-547`, `components/calendar/task-modal.tsx`; 13f9f27c4).
  - What RN does: close and Back call onClose (`src/components/calendar/EventModal.tsx:495`, `:500`); the task editor resets on the next open (`src/components/calendar/TasksSheet.tsx:135-146`, `:238-253`).
  - Fix hint: compare with the initial form and ask, as ContactFormScreen does (`src/screens/ContactFormScreen.tsx:639`).

- [x] **A shared calendar's server colour is replaced by a random one (#1414)** — `P3` — `bug` — fixed in 64eb97f4
  - What WEB does: auto-colours only shared calendars with neither a server colour nor an override (`lib/shared-calendar-colors.ts:79`; 2dbe5d024).
  - What RN does: colours every shared calendar without an override (`src/screens/CalendarScreen.tsx:315-333`).
  - Fix hint: skip calendars with `cal.color`.

### Notifications

- [ ] **New mail can't play the Involved sound** — `P3` — `missing`
  - What WEB does: Involved by default (`stores/settings-store.ts:949`, `lib/notification-sound.ts:11`). 5eabdd890.
  - What RN does: the OS channel owns the sound (`src/stores/settings-store.ts:266-267`).
  - Fix hint: optional; needs a new Android channel id and a bundled iOS sound.

### i18n

- [x] **No Thai or Estonian, and the vendored catalogs are stale** — `P3` — `missing` — fixed in d23af55e, e8bc54eb
  - What WEB does: 29 languages, Thai new in 1.19.0 (#1379, be52744a5; `i18n/routing.ts:15`).
  - What RN does: 27 (`src/i18n/index.ts:25-53`); `locales/et/common.json` is vendored but not registered; no `th`. German lacks 1283 of the webmail's keys (last sync 7c914183).
  - Fix hint: `node scripts/sync-locales.mjs`, register th and et, add overlays.

- [x] **Some German phone strings still say "du"** — `P3` — `bug` — fixed in 25f9b810
  - What WEB does: formal everywhere (7b720dd22).
  - What RN does: 12 overlay strings (`locales/rn/de.json`, e.g. settings.privacy.*, settings.backup.description); 18 more in the stale vendored catalog, which the sync fixes.
  - Fix hint: rewrite with "Sie".

## Already done in native
Return to the list after archive/move/spam (#1458), shared mailbox identity (#1450), Bulwark Mobile client (#1459, 7a42a15f), security settings after a TOTP sign-in (#1432), unique default alert ids (#1435), keep-alive while push is live (#1401), vCard colons and 4.0 export (#1438 9d547b9d, #1407), chip moves between To/Cc/Bcc, placeholder warning, send waits for autosave (#1394), clearing filters keeps the folder (#1430), translated folder names in search (#1429), invitation passing DMARC (#1403), attachment download errors (#1426, #1428), partly failed bulk delete (#1384), .eml preview attachments (#1395), Files move/zip/delete undo, Contacts move and long-press menus, no Edit/Delete on read-only events, reduce motion. Details with file:line are in the inventory drafts summarised in docs/native-sync-2026-11.md.

## Unticked file 10 rows touched by 1.19
Schedule presets (1.19.0 adds "This morning"/"This afternoon", #1390), undo after a cross-account move and in the unified inbox, search snippets and size filter, fixed-width tables (#1020), recover deleted items (#1319), delegates, external sender chip, external recipient confirm, org signature and disclaimer, org policy and session limits (the last five blocked on the policy route).

## Needs a decision
- BIMI and the operator's help links need the app to keep the paired webmail's URL, the same thing the org policy needs.
