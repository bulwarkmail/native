# Webmail 1.10.0 to 1.18.0 (and Unreleased)

## Summary
The last parity pass was against webmail 1.9.2. This file walks every changelog entry from 1.10.0 to 1.18.0, the Unreleased section and the commits after the 1.18.0 release (b0d1a97bb..main, 2026-10-29), checked against native `feat/stalwart-1.0` with main merged in (f1db6b48). Web paths are relative to the webmail root, native paths to this repo.

What stands out:
- Several webmail security fixes never reached the app: the HTML sanitizer lets `<img src=x/onerror=…>` through, a sender can fake a DMARC pass in the auth chips, mailto unsubscribe sends to every address, a crafted winmail.dat freezes the JS thread, and the webmail hand-off still puts the password in the `bulwarkmobile://` fragment.
- Sieve interop broke in both directions: the app reads webmail 1.13+ scripts (metadata v2) as raw Sieve and its "Reset to visual builder" wipes them, and a save on the phone broadens "is the address" rules into substring matches.
- Account switches still leak: the composer follows a switch with an open draft (and its autosave can destroy another account's message), calendar, task and contact loads from the previous account land after a switch, Undo/Send now of a delayed send goes through the active login, and push renewal only reaches the active account.
- Everything the organisation policy drives (locked settings, session length, external recipient confirm and label, org signature and disclaimer) has no source on the phone: the policy is served by the webmail at `/api/admin/policy` behind its session cookie (`lib/auth/instance-details.ts:23`), and the app forgets which webmail it was paired with (`src/lib/oauth.ts:292`). These need a webmail change first (see "Needs a decision").
- Features that live on the JMAP server and only need porting: shared tags and team templates (JMAP Metadata `org.bulwarkmail/*`), recover deleted items (`x:ArchivedItem`), delegates (`shareWith`), Files trash, save attachment to Files, scheduled message view.

Classification: `bug` = fixed in the webmail, still live in the app; `missing`; `partial`. Not applicable on mobile and left out: admin panel, plugins and marketplace, command palette, keyboard shortcuts, print, Bulwark Lite, CSP/third-party switch, Mountain View, desktop-only layout (drag and drop, hover, multi-pane), server routes the app doesn't use, Docker, docs and translation-only entries.

Stalwart 1.0.0 items found in the same pass (1.0 SSO scopes, Files on 1.0, #1385) are tracked with the Stalwart 1.0 work and not repeated here.

## Findings

### Security

- [x] **HTML sanitizer lets `on*` handlers through after a slash** — `P1` — `bug` — fixed in f5e997ba, 07679cbf, 47a1d249, 440a2e7a
  - What WEB does: DOMPurify for mail and drafts (`lib/email-sanitization.ts`, GHSA-g35q-3gpc-x2rr).
  - What RN does: the handler regex needs whitespace before `on*` (`src/lib/email-html.ts:142-145`), so `<img src=x/onerror=…>` survives. The viewer WebView (`src/components/EmailBodyView.tsx:793`) and the editor (`src/lib/editor-html.ts:37`, seeded at `src/screens/ComposeScreen.tsx:557`) allow inline script; a received mail can navigate without a tap (`EmailBodyView.tsx:841-843`).
  - Fix hint: drop every `on*` attribute whatever precedes it (or parse), and stop allowing inline handlers.

- [x] **A sender can fake a DMARC/DKIM pass in the auth chips** — `P1` — `bug` — fixed in ef9561f1, 8adef1e1
  - What WEB does: splits Authentication-Results on `;` outside quotes and comments, reads the method at the start of each part, takes DKIM/DMARC from the topmost header only (`lib/email-headers.ts:231`, 8f7124c87).
  - What RN does: matches `dkim=`/`dmarc=` anywhere in all headers joined (`src/lib/email-headers.ts:143`, `:152`, `:265`); this also feeds invitation trust.
  - Fix hint: port the web parser.

- [x] **mailto unsubscribe sends to every address and the confirm hides it** — `P1` — `bug` — fixed in 942f4517, 918571c3
  - What WEB does: one address, ignores `to=`/`cc=`, caps subject and body, shows them in the confirm (`lib/validation.ts:180`, `components/email/unsubscribe-banner.tsx:42`, f0aa0eeda).
  - What RN does: sends to every to/cc and `to=` address with the sender's subject and body (`src/lib/unsubscribe.ts:95-113`); the confirm only says an email will be sent (`src/components/email/UnsubscribeBanner.tsx:139-147`).
  - Fix hint: port parseUnsubscribeMailto and the confirm text.

- [x] **A crafted winmail.dat freezes the JS thread** — `P1` — `bug` — fixed in 855d304b
  - What WEB does: clamps the MAPI value count and stops on a read that doesn't advance (`lib/tnef.ts:173`, 012fe6eda).
  - What RN does: trusts the count (up to 2^32) and loops on non-advancing reads (`src/lib/tnef.ts:201`, `:211`).
  - Fix hint: clamp to remaining/4, break on a null or non-advancing read.

- [ ] **Webmail hand-off returns the password in the `bulwarkmobile://` fragment** — `P2` — `bug` (cross-repo)
  - What WEB does: `app/(main)/[locale]/login/page.tsx:426`, `lib/auth/mobile-handoff.ts:31` put the password in the redirect.
  - What RN does: reads it from the fragment (`src/lib/oauth.ts:247`); any app can claim a custom scheme.
  - Fix hint: hand back a one-time code and redeem it like QR pairing (`src/lib/oauth.ts:435`, `/api/auth/pair/redeem`). Needs the webmail side first.

- [ ] **Sender favicons are fetched from icons.duckduckgo.com on the device** — `P3` — `partial` (privacy)
  - What WEB does: proxies favicons on the server (`app/api/favicon/route.ts:484`).
  - What RN does: fetches directly, on by default (`src/lib/avatar-utils.ts:149`, `src/stores/settings-store.ts:312`), leaking sender domains and the device IP.
  - Fix hint: default off, or use the paired webmail's proxy.

### Accounts and sign-in

- [ ] **Org user policy and "Set by your organisation"** — `P2` — `missing` (blocked)
  - What WEB does: locks or hides settings per domain or group (`stores/policy-store.ts:110`, `hooks/use-restriction.ts:22`, `components/settings/org-locked-note.tsx:14`), incl. colour mode #1280, archiving off #1257, tags above shared mailboxes #1334, share rights, hiding delegates or recovery.
  - What RN does: nothing (`src/stores/settings-store.ts:453`); the paired webmail is forgotten (`src/lib/oauth.ts:292`).
  - Fix hint: keep the webmail URL at hand-off/pairing and fetch the policy with a bearer token. Needs a webmail route that accepts a JMAP bearer token. See "Needs a decision".

- [ ] **Admin-set idle sign-out and maximum session length** — `P2` — `missing` (blocked)
  - What WEB does: `components/session/session-timeout-guard.tsx:94`, `lib/session-policy/limits.ts:36`, refuses to restore over-age sessions (6e5d8faec), saves drafts first (79c697a93).
  - What RN does: stays signed in for good (`src/stores/auth-store.ts:929`, `App.tsx:818`).
  - Fix hint: needs the policy; then an AppState idle timer and a max-age check in restoreSession, drafts flushed first.

- [x] **With TOTP on, changing the password and turning TOTP off fail** — `P2` — `bug` — fixed in 99a42128
  - What WEB does: asks for the current code and sends it (`components/settings/account-security-settings.tsx:52`).
  - What RN does: sends neither (`src/api/account-security.ts:346-353`, `:387-395`; `src/components/settings/AccountSecuritySettings.tsx:292`); Stalwart answers "Current OTP code is required".
  - Fix hint: ask for the code and patch `otpAuth/otpCode` (not the whole object).

- [x] **A full sign-out keeps the search history** — `P2` — `bug` — fixed in 986216f4, 639aa4aa
  - What WEB does: `stores/auth-store.ts:1301`, `lib/sign-out-cleanup.ts:22`.
  - What RN does: clearAllFeatureStores (`src/stores/auth-store.ts:126-134`) never clears `src/stores/search-history-store.ts:44`.
  - Fix hint: clear it, and check the other persisted stores in the same pass.

- [x] **Internationalized domains** — `P3` — `missing` — fixed in f5875f87 (sign-in, discovery, account rows; the composer's recipient check goes with the compose branch)
  - What WEB does: `lib/idn.ts:25` (#1100). What RN does: ASCII-only checks (`src/lib/recipients.ts:31`, `src/lib/server-discovery.ts:78`).
  - Fix hint: toASCII on the wire, Unicode on screen.

- [ ] **Sign-out doesn't end the identity provider session** — `P3` — `missing` — not done: needs a decision; the app keeps the shared browser session for a first sign-in on purpose, an ephemeral session helps on iOS only, and end_session needs the id_token the app does not keep plus a registered post-logout redirect
  - What WEB does: `app/api/auth/token/route.ts:90` (#905). What RN does: `src/lib/oauth.ts:219`, `src/lib/oauth-native.ts:158`.
  - Fix hint: open end_session_endpoint, or use an ephemeral browser session.

- [x] **Explain a refused token exchange on TOTP sign-in** — `P3` — `partial` — fixed in 37e72c12
  - What WEB does: `stores/auth-store.ts:153`, `:1432`. What RN does: `src/lib/totp-login.ts:148`, `:156` throw token_exchange_failed; `src/lib/login-errors.ts:129` has no copy.

- [ ] **Shared account settings scope for calendar and contacts** — `P3` — `missing` (old 01 item)
  - What WEB does: `components/settings/account-settings.tsx:32`. What RN does: `src/lib/capabilities.ts:86` covers filters and vacation only.

### Mail list and folders

- [x] **The list stops loading older mail when the server sends no total (#1364)** — `P2` — `bug` — fixed in 58bc4aca
  - What WEB does: keeps paging while full pages come back (`stores/email-store.ts:6508-6515`).
  - What RN does: a missing total becomes 0 (`src/api/email.ts:529`, `:757`) and paging stops (`src/stores/email-store.ts:1113`).

- [x] **View scheduled messages; Cancel send puts them back in Drafts (native #84)** — `P2` — `partial` — fixed in 14d009de, 51b3208b, c817f978
  - What WEB does: opens scheduled mail with a banner (Send now, Reschedule, Cancel) (`components/mail/mail-app.tsx:2523`, `components/email/email-viewer.tsx:773`, f7adbf1ef, 780b64461, 831a3e6b8).
  - What RN does: a row tap only opens the action sheet (`src/screens/ScheduledScreen.tsx:278`); Cancel leaves the copy in Sent (`:129-132`, `src/api/email.ts:2079`).
  - Fix hint: open the row in the thread screen with a scheduled banner; make Cancel do the cancel-to-Drafts that Edit already does.

- [x] **Shared tags in group mailboxes (#1310, #470)** — `P2` — `missing` — fixed in b7b9c7e0, ba672050 (read-only; editing stays in the webmail)
  - What WEB does: reads and writes `org.bulwarkmail/tags` via JMAP Metadata on the group account (`lib/shared-tags.ts:185`, `components/settings/shared-tag-settings.tsx`, `lib/jmap/bulwark-metadata.ts`).
  - What RN does: local tag names only (`src/stores/keywords-store.ts:5`, `src/components/settings/KeywordSettings.tsx`).
  - Fix hint: read the group's tags through Metadata (Stalwart 1.0 implements it; the 0.16 guard from 42751a6b stays). Locking needs the policy.

- [x] **Search leaves out Spam and Trash by default** — `P2` — `missing` — fixed in a412b516, 2b5257bf
  - What WEB does: `inMailboxOtherThan` trash/junk unless "All folders" is picked (`lib/unified-mailbox.ts:98`, 763732fdc, 3904af2cb).
  - What RN does: no mailbox filter (`src/stores/email-store.ts:268-271`, `:492`).

- [x] **Unified "All mail" search leaves out Sent, Archive and Drafts** — `P2` — `bug` — fixed in 484cac58
  - What WEB does: with a query, excludes only trash and junk (`lib/unified-mailbox.ts:510`).
  - What RN does: applies the view exclusions also with a query (`src/api/unified-inbox.ts:353`, `:35`).

- [ ] **Undo after a move to another account and in the unified inbox** — `P3` — `partial`
  - What WEB does: `stores/email-store.ts:5177` (ed9fa2de4), `lib/email-action-toast.ts` (6c5aead20).
  - What RN does: Undo exists within an account and in spanning lists, not after crossAccountMove (`src/stores/email-store.ts:1540-1550`, `:1786-1796`) or for `src/screens/UnifiedInboxScreen.tsx:246-270`.

- [ ] **Archive without an Archive folder; unified archive modes (#1176, #1178)** — `P3` — `missing`
  - What WEB does: creates Archive and reuses year/month folders (`stores/email-store.ts:1332`, `:2561`).
  - What RN does: returns silently (`src/stores/email-store.ts:1594`, `:1729`) or throws (`src/api/unified-inbox.ts:546`).

- [ ] **A server's own "all" mailbox is included in All mail/Unread (#1241)** — `P3` — `bug`
  - What WEB does: role `all` excluded (`lib/jmap/types.ts:1158`). What RN does: `src/api/unified-inbox.ts:34`, `:354`.

- [ ] **Tag views and counts include Trash and Spam (#1156)** — `P3` — `bug`
  - What WEB does: `lib/unified-mailbox.ts:104`, `:577`. What RN does: `src/api/tag-counts.ts:37-48`, `src/stores/email-store.ts:455`.

- [x] **User folders named like system folders get system icons (#1235, native #80)** — `P3` — `bug` — fixed in 96c7c045
  - What WEB does: icons by role only (`components/layout/sidebar.tsx:168`). What RN does: name matching fallback (`src/components/SidebarDrawer.tsx:92`).

- [ ] **Sort by "Date sent" falls back to received date in merged lists (#1219)** — `P3` — `bug`
  - What WEB does: lists fetch sentAt (`lib/jmap/client.ts:443`). What RN does: EMAIL_LIST_PROPERTIES lacks it (`src/api/email.ts:22`; comparator `src/lib/message-list-order.ts:225`).

- [ ] **Previews start with a style sheet (#1136)** — `P3` — `bug`
  - What WEB does: cleanPreview (`lib/utils.ts:320`, `:363`). What RN does: `src/screens/EmailListScreen.tsx:270`, `src/lib/push-background-task.ts:513`.

- [ ] **Paperclip on messages with only inline images** — `P3` — `bug`
  - What WEB does: `components/email/attachment-chips.tsx:165`. What RN does: `src/screens/EmailListScreen.tsx:237`, `src/screens/UnifiedInboxScreen.tsx:358` use hasAttachment.

- [ ] **List row grows when its attachment chips arrive** — `P3` — `bug`
  - What WEB does: reserves the row (7b25d3a95). What RN does: `src/components/email/ListAttachmentChips.tsx:89`.

- [ ] **Cold start reopens the last folder or search instead of the inbox** — `P3` — `bug`
  - What WEB does: 64b39c504. What RN does: `src/stores/email-store.ts:2195`, `:829`.

- [ ] **List keeps its scroll position on folder, tag or search switch (#1138)** — `P3` — `bug` (from the code, not seen on a device)
  - What RN does: `src/screens/EmailListScreen.tsx:1590`.

- [ ] **Unified inbox live updates for other logins (#1350)** — `P3` — `partial`
  - What RN does: `src/screens/UnifiedInboxScreen.tsx:154-167` listens to the active login only.

- [ ] **Copy to another account (#1150); move several folders (#1173); move menu order in a shared mailbox (#1149)** — `P3` — `missing`
  - What WEB does: `hooks/use-message-file-actions.ts:94`, `components/settings/folder-settings.tsx:202`. What RN does: `src/components/MoveSheet.tsx:31`, `src/components/settings/FolderSettings.tsx:137-173`, `src/lib/mailbox-tree.ts:162-205`.

- [ ] **Hide shared mail accounts (#1228); remove from this folder (#615); folder name on all-folder results (#1172); own folders section (#1205); per-folder counter (#982); hide account dot (#912)** — `P3` — `missing`
  - What WEB does: `lib/shared-mail-visibility.ts:19`, `hooks/use-remove-from-folder.ts:15`, `stores/settings-store.ts:695`. What RN does: `src/components/SidebarDrawer.tsx:124-150`, `:672`; `src/screens/EmailListScreen.tsx:103`.

- [ ] **Search folder picker is flat and capped at 12** — `P3` — `partial`
  - What WEB does: `lib/search-scope-folders.ts`. What RN does: `src/screens/EmailListScreen.tsx:1729-1740` (`slice(0, 12)`).

- [ ] **Tags without a definition are grey; no account tint (#1052); tag visibility, nesting, order** — `P3` — `partial`
  - What WEB does: `hooks/use-keyword-format.ts`, `stores/settings-store.ts:391`. What RN does: `src/screens/EmailListScreen.tsx:164`, `src/stores/keywords-store.ts:9`.

- [ ] **Today/yesterday follow the time zone setting (#1259); .eml import and cross-account moves keep the date (#891)** — `P3` — `partial`
  - What RN does: `src/lib/date-format.ts:111-115` (device zone); `src/api/email.ts:1059-1072` sends no receivedAt.

- [ ] **Reorder folders; custom folder icons** — `P3` — `missing` (old 02 items)
  - What WEB does: `stores/email-store.ts:7502`, `components/settings/folder-settings.tsx:261`, `:701`. What RN does: `src/components/settings/FolderSettings.tsx:350`, `:32` (`src/api/email.ts:297` already takes sortOrder).

- [ ] **RTL swipe sides** — `P3` — `partial` (old 08 item; web doesn't swap either)
  - What RN does: `src/components/SwipeableRow.tsx:353`.

- [ ] **`/mail/folder/<ref>` deep link opens only the tab** — `P3` — `bug`
  - What RN does: `src/navigation/linking.ts:134` parses it, `:285-287` drops it.

### Reading mail

- [x] **Unverified-sender warning, badge, no "Always trust" for forged mail** — `P2` — `partial` — fixed in cc21317b
  - What WEB does: getSenderVerification (`lib/email-headers.ts:112`), banner and badge (`components/email/email-viewer.tsx:4037`).
  - What RN does: a spoof line in the collapsed details only, first DKIM signature only, trust still offered (`src/components/email/MessageHeader.tsx:108`, `:273`; `src/lib/email-headers.ts:99`; `src/components/EmailBodyView.tsx:771`).

- [ ] **External sender chip** — `P2` — `missing` (blocked on the policy)
  - What WEB does: `lib/external-mail.ts:119`, `components/email/external-sender-chip.tsx`, `components/email/email-viewer.tsx:903`.
  - What RN does: `src/components/email/MessageHeader.tsx:159`, nothing.
  - Fix hint: internal and partner domains come from the policy; identity domains would only be a fallback.

- [x] **Invitation trust uses unaligned SPF/DKIM and flags colleagues (#1374)** — `P2` — `bug` — fixed in 7a95d43f, 1bce37bb, 6133bcd9
  - What WEB does: alignment check and own-domain exemption, REPLY/COUNTER checked against the answering attendee (`lib/calendar-invitation.ts:210-216`, `:400-422`).
  - What RN does: `src/lib/calendar-invitation.ts:325-328`, `:375-376`.

- [x] **Copy chip for sign-in and verification codes** — `P2` — `missing` — fixed in b1550f14
  - What WEB does: `lib/verification-code.ts:275`, `components/email/email-viewer.tsx:1378`, setting at `stores/settings-store.ts:540`.
  - What RN does: nothing (`src/components/email/MessageHeader.tsx`, `src/screens/EmailListScreen.tsx`).

- [ ] **A mail full of blockquotes freezes the reader** — `P3` — `bug`
  - What WEB does: single walk (`lib/quote-collapse.ts:92`). What RN does: quadratic walk (`src/lib/quote-collapse.ts:95-112`).

- [ ] **Attachment names keep direction-override characters** — `P3` — `bug`
  - What WEB does: `lib/bidi.ts:10`. What RN does: `src/lib/attachment-display.ts:34`, `src/lib/email-export.ts:56`.

- [x] **Part names that are paths (#1371, #1373)** — `P3` — `bug` — fixed in 4d545f8f
  - What WEB does: `lib/jmap/download-name.ts:11`. What RN does: `src/api/jmap-client.ts:1350` puts `%2F` into the download URL.

- [ ] **Dark mode recolours instead of inverting** — `P3` — `missing`
  - What WEB does: `lib/email-dark-mode.ts:48`, `:71`. What RN does: `filter: invert(1) hue-rotate(180deg)` (`src/lib/email-html.ts:500`); mail's own dark styles follow the system scheme (`:640`).

- [ ] **"via" badge repeats the sender's address** — `P3` — `bug`
  - What WEB does: `components/email/email-identity-badge.tsx:69`. What RN does: `src/components/email/MessageHeader.tsx:116-117`, `:223`.

- [ ] **Fixed-width tables don't reflow (#1020)** — `P3` — `partial`
  - What WEB does: `lib/email-fit-width.ts:111`. What RN does: shrinks the whole mail (`src/components/EmailBodyView.tsx:277-290`).

- [ ] **Invitation banner: View in calendar, collapse, counter-proposal review** — `P3` — `missing` (old 03 item)
  - What WEB does: `components/email/calendar-invitation-banner.tsx:727`, `:463`, `:245`. What RN does: `src/components/email/CalendarInvitationBanner.tsx:153`.

- [ ] **Quick reply can be turned off (#1370)** — `P3` — `missing`
  - What WEB does: `stores/settings-store.ts:560`. What RN does: always rendered (`src/screens/EmailThreadScreen.tsx:1233`).

### Composer and sending

- [x] **An open draft follows an account switch; its autosave can destroy another account's message** — `P1` — `bug` — fixed in 9daa3441, 388f46b5, 4e57b191
  - What WEB does: pins the account when the composer opens (`components/email/email-composer.tsx:506`, d58344329).
  - What RN does: reads Drafts/Sent, identities and `jmapClient.accountId` live (`src/screens/ComposeScreen.tsx:443-455`, `:778`, `:1355`; `src/api/email.ts:1899`, `:1928-1930`). A notification tap or deep link switches with the composer open (`App.tsx:117-120`); the next autosave creates the draft in the other account and destroys `previousDraftId` there.
  - Fix hint: pin account, identities and mailboxes at open; pass the account to saveDraftVersion, sendEmail and uploads.

- [x] **Undo or Send now of a delayed send goes through the active login** — `P1` — `bug` — fixed in e81f0071, 893f40a2
  - What WEB does: GHSA-8x23 (`components/mail/mail-app.tsx:2549`).
  - What RN does: the pending send has no login (`src/stores/send-undo-store.ts:89`, `:109-118`; `src/screens/ComposeScreen.tsx:2202`); after a switch the cancel hits the same submission id on another server.
  - Fix hint: store the login with the pending send; refuse or clear on a switch.

- [x] **Reschedule and Send now create the replacement before cancelling (#1308)** — `P2` — `bug` — fixed in 22f2ac5b, fdf8eece
  - What WEB does: cancels first, restores on failure (`lib/jmap/client.ts:11532-11664`).
  - What RN does: creates first (`src/api/email.ts:2189`).

- [x] **A send the server doesn't confirm is reported as sent (#1019)** — `P2` — `bug` — fixed in 3eac700a
  - What WEB does: `lib/jmap/client.ts:994`, `:5115`.
  - What RN does: returns success without a submission id (`src/api/email.ts:1857`), drops the draft and closes (`src/screens/ComposeScreen.tsx:2158`).

- [x] **Send and save drafts as a group or shared identity (#1090)** — `P2` — `missing` (old 04 item too) — fixed in 31d8e4a4, 6414b0d6, 893f40a2
  - What WEB does: resolveSendAccountId (`lib/jmap/client.ts:6257`), identities of every account (`components/email/email-composer.tsx:214`, `:271`).
  - What RN does: primary account's identities only (`src/api/identity.ts:17`, `src/screens/ComposeScreen.tsx:778`); sendEmail has no account (`:2151`).

- [x] **Team templates, personal templates in the account, org template library** — `P2` — `missing` — fixed in fac318dc (personal + team read-only; org library needs the policy)
  - What WEB does: templates in JMAP Metadata with tombstones (`lib/templates/personal-templates.ts:141`, `lib/templates/team-templates.ts:57`, `lib/templates/org-library.ts:13`); on 1.0 the webmail moves them into the account.
  - What RN does: local only (`src/stores/templates-store.ts:30`, `src/components/TemplateSheet.tsx`).
  - Fix hint: read and write `org.bulwarkmail` templates via Metadata. The org library and locks need the policy.

- [x] **Attach from Files (#1179)** — `P2` — `missing` — fixed in 8e07b7d8
  - What WEB does: `components/email/email-composer.tsx:4574`. What RN does: device picker only (`src/screens/ComposeScreen.tsx:1686-1711`).

- [ ] **External recipient confirm (composer, quick reply, invitations)** — `P2` — `missing` (blocked on the policy)
  - What WEB does: `lib/outgoing/external-recipients.ts:53`, `:107`, `components/email/external-recipient-confirm.tsx`.
  - What RN does: nothing (`src/screens/ComposeScreen.tsx:2151`, `src/components/email/QuickReplyBox.tsx`, `src/components/calendar/EventModal.tsx`).

- [ ] **Org signature with user details; legal disclaimer on every sent message** — `P2` — `missing` (blocked on the policy)
  - What WEB does: added in the client before sending (`lib/org/outgoing.ts:73`, `:99`, `lib/org-signature.ts:311`, 0154e24ff).
  - What RN does: mail from the phone goes out without the disclaimer (`src/screens/ComposeScreen.tsx:2151`, `src/lib/signature-utils.ts`).

- [x] **Unfilled placeholder warning** — `P3` — `missing` — fixed in a8e7a3f4, 7594e459
  - What WEB does: findUnfilledPlaceholders with per-locale words and a confirm (`lib/placeholder-check.ts:115`, `components/email/email-composer.tsx:3261`), setting placeholderWarningEnabled.
  - What RN does: nothing (`src/screens/ComposeScreen.tsx:2151`).

- [ ] **Signature swap when changing From** — `P3` — `bug`
  - What WEB does: `components/email/email-composer.tsx:1148`, `components/email/compose-format.ts:71`.
  - What RN does: an identity without a signature keeps the primary's (`src/lib/signature-utils.ts:83-91`, `src/screens/ComposeScreen.tsx:975`); typing under the signature breaks the swap (`src/lib/signature-utils.ts:245`).

- [ ] **Plain-text part of sent mail** — `P3` — `bug`
  - What WEB does: `lib/html-to-text.ts:73`, `:169`. What RN does: "-- " trimmed to "--", "> " dropped, ordered lists bulleted (`src/lib/compose-html.ts:109`, `:112`, `:125`).

- [ ] **Composer prompts: missing-subject asks again, autosaved draft says "unsaved", no Discard for a reopened draft** — `P3` — `bug`
  - What WEB does: `components/email/email-composer.tsx:3251`, `:3770`, `:3758`. What RN does: `src/screens/ComposeScreen.tsx:1983`, `:2135`, `:1501`, `:1454-1471`.

- [ ] **Offline send shows a raw network error; no offline send queue** — `P3` — `partial` (old 04/09 item)
  - What WEB does: says offline and keeps the message (`components/email/email-composer.tsx:3661`). What RN does: `src/screens/ComposeScreen.tsx:2236`, `src/lib/send-failure-message.ts:57`, `src/stores/outbox-store.ts:53`.

- [ ] **Scheduled time shows a minute early; presets (tomorrow 13:00, next Monday 08:00)** — `P3` — `bug`/`partial`
  - What WEB does: `lib/scheduled-send-label.ts:11`, `lib/schedule-presets.ts:20`. What RN does: `src/screens/ScheduledScreen.tsx:53`, `:222`; `src/screens/ComposeScreen.tsx:2046`.

- [ ] **Reply puts no cursor in the body; autofill offered in address fields** — `P3` — `missing`
  - What WEB does: `components/email/email-composer.tsx:2885`. What RN does: `src/screens/ComposeScreen.tsx:2466`, `:2316`, `:2946`, `src/components/calendar/ParticipantInput.tsx:119`.

- [ ] **Composer extras: priority (#970), numeric date placeholders (#1284), @mentions (#1134), directory lookup (#1253), font size, pasted lists, DSN/REQUIRETLS** — `P3` — `missing`
  - What WEB does: `lib/recipient-mentions.ts`, `components/email/plain-text-paste.ts`, `components/email/rich-text-editor.tsx:445`, `lib/jmap/client.ts:1392-1413`. What RN does: `src/lib/template-utils.ts:9-15`, `src/components/RichTextEditor.tsx:26`, `src/lib/editor-html.ts`.

- [ ] **The recipient splitter treats an escaped quote as closing** — `P3` — `bug`
  - What WEB does: `lib/email-composer-utils.ts:276`. What RN does: `src/lib/recipients.ts:57-90` (reached only from IdentitySettings).

### Calendar

- [x] **Calendar and task data from the previous account lands after a switch** — `P1` — `bug` — fixed in 1f190c94, e993540a, 41e8f005, 98dc13fe
  - What WEB does: epoch check (`stores/calendar-store.ts:956`).
  - What RN does: in-flight fetchEvents and `tasksInFlight` survive reset (`src/stores/calendar-store.ts:742`, `:750`, `:786`; reset at `src/stores/auth-store.ts:830`); a tick or delete then writes to the new account by the old one's id.

- [x] **Task reminders relative to the start use the due date (native #83, webmail #1328)** — `P2` — `bug` — fixed in 6f475c0c
  - What WEB does: `lib/calendar-alerts.ts:343`. What RN does: `src/lib/calendar-alert-scheduler.ts:86`.

- [x] **Daily series stop at a DST gap** — `P2` — `bug` — fixed in 4de85692
  - What WEB does: candidates from the start's wall clock (`lib/recurrence-expansion.ts:420`, 34fb9d247).
  - What RN does: `src/lib/recurrence-expansion.ts:526-531`, `:396-398`, `:709`.

- [x] **Subscribed feed changes never reach imported events** — `P2` — `bug` — fixed in 8a71495e, 47f29718
  - What WEB does: calendar-feed-diff (`stores/calendar-store.ts:2012`). What RN does: known UIDs skipped (`src/stores/calendar-subscriptions-store.ts:222`, `src/stores/calendar-store.ts:1158`).

- [x] **Invitation time in the wrong zone (#1252)** — `P2` — `bug` — fixed in 0fb7c8cd
  - What WEB does: `lib/calendar-invitation.ts:701`. What RN does: `src/components/email/CalendarInvitationBanner.tsx:175`.

- [x] **Default reminders per calendar and email reminders (#1209)** — `P2` — `partial` — fixed in 9b87100a, b767df9f
  - What WEB does: `components/settings/calendar-management-settings.tsx:184`, `components/calendar/event-modal.tsx:448`, `lib/calendar-alerts.ts:175`.
  - What RN does: fires a calendar's defaults (`src/lib/calendar-alert-scheduler.ts:96`) but can't set them and new events don't start with them (`src/components/calendar/EventModal.tsx:266`).

- [x] **Search events** — `P2` — `missing` — fixed in b50270d8
  - What WEB does: `components/calendar/calendar-search.tsx:82`. What RN does: `src/screens/CalendarScreen.tsx`.

- [x] **Zero-length events run to 23:59 (#837)** — `P3` — `bug` — fixed in acbd085a
  - What RN does: `src/stores/calendar-store.ts:144`, `src/lib/calendar-utils.ts:116`. Fix: `duration || 'PT0S'`.

- [x] **.ics export breaks emoji and colon names** — `P3` — `bug` — fixed in f83284d7
  - What RN does: `src/lib/calendar-ics-export.ts:9`, `:160`, `:167`. Fix: port foldLine and parameter quoting.

- [x] **Blank participant names are written (#748)** — `P3` — `bug` — fixed in 59c32782
  - What WEB does: `lib/calendar-participants.ts:368`. What RN does: `src/lib/calendar-participants.ts:360`, `:385`, `:484`.

- [ ] **Offer to save without invitations when the server refuses them** — `P3` — `partial`
  - What WEB does: `lib/jmap/scheduling-error.ts:7`. What RN does: `src/components/calendar/EventModal.tsx:385-390`.

- [ ] **Moving a task into or within a shared calendar (#1204)** — `P3` — `partial`
  - What WEB does: `lib/jmap/client.ts:9473`. What RN does: updateTask sends unmapped calendarIds (`src/stores/calendar-store.ts:1311-1315`).

- [ ] **Working hours (#1164); week all-day area (#1122); light tinted colours; Jalali; birthday colour; copy title/append note; component set on new calendars (#760); date deep links; background reminder refresh without device sync** — `P3` — `missing`/`partial`
  - What RN does: `src/components/calendar/WeekView.tsx`, `src/components/calendar/TimeGridScrollView.tsx:177-185`, `src/lib/birthday-calendar.ts:6`, `src/components/calendar/EventDetailSheet.tsx:422`, `src/api/calendar.ts:1150`, `src/navigation/linking.ts:151`, `:288-299`, `src/lib/push-notifications.ts:243`.

- [ ] **Free/busy, CalendarEventNotification, organizer from ParticipantIdentity (1.10.0)** — `P3` — `missing`
  - What WEB does: `lib/jmap/client.ts:1198`.

### Contacts

- [x] **Contacts from the previous account land after a switch** — `P1` — `bug` — fixed in 6b9552fc
  - What WEB does: epoch guard (`stores/contact-store.ts:597`). What RN does: `src/stores/contacts-store.ts:357`, `:373`; reset (`:873`) keeps contactsPromise.

- [x] **Contacts with a calendar, scheduling or free/busy link don't save** — `P2` — `bug` — fixed in 32f70c10
  - What WEB does: maps them to `calendars`/`schedulingAddresses` (`lib/jmap/contact-wire.ts:63-87`).
  - What RN does: writes `calendarUri`, `schedulingUri`, `freeBusyUri` as card properties (`src/lib/contact-form.ts:412-414`, `src/api/contacts.ts:97`); Stalwart refuses the card.

- [x] **vCard import sends fields Stalwart rejects** — `P2` — `bug` — fixed in 32f70c10, 3c156673
  - What WEB does: `lib/jmap/contact-wire.ts`. What RN does: flat ADR and `source` (`src/lib/vcard.ts:652-672`, `:989-990`).

- [x] **Company directory in Contacts and the composer (#1253)** — `P2` — `missing` — fixed in 0fd14a83 (Contacts; the composer lookup is exported, not wired)
  - What WEB does: `components/contacts/directory-browser.tsx:61`, `stores/contact-store.ts:924`. What RN does: `src/screens/ContactsScreen.tsx`, `src/stores/contacts-store.ts:728`; listPrincipals exists (`src/api/files.ts:593`).

- [x] **Deleting an address book that still holds contacts fails** — `P3` — `bug` — fixed in 32f70c10
  - What WEB does: `onDestroyRemoveContents` (`lib/jmap/client.ts:6937`). What RN does: `src/api/contacts.ts:404`.

- [x] **vCard 4.0 export (#1407)** — `P3` — `bug` — fixed in 07fd03e2
  - What RN does: dashes in dates, MOBILE instead of CELL (`src/lib/vcard.ts:21`, `:24`, `:1264`).

- [ ] **Delete contact categories; address book sharing; list filters; deep links new/edit** — `P3` — `missing`/`partial`
  - What WEB does: `components/settings/address-book-management-settings.tsx:84`, `:435`, `components/contacts/contact-list.tsx:30`, `lib/deep-links.ts:394`. What RN does: `src/components/contacts/ContactsSidebarDrawer.tsx:144`, `src/components/settings/ContactsSettings.tsx:33`, `src/screens/ContactsScreen.tsx:163`, `src/navigation/linking.ts:155`.

### Files

- [x] **Files trash** — `P2` — `missing` — fixed in 7c914183 and be04fcb1..946304ab
  - What WEB does: `lib/files-trash.ts:20`, `components/files/files-app.tsx:419`.
  - What RN does: deletes for good (`src/api/files.ts:316`, `src/screens/FilesScreen.tsx:673`) and lists the webmail's `/.Trash` as an ordinary folder.

- [x] **Save an attachment to Files (incl. shared and group mail)** — `P2` — `missing` — fixed in 8e07b7d8, 39e82f99
  - What WEB does: `components/email/save-to-files-dialog.tsx:43`, `lib/jmap/client.ts:9981`. What RN does: `src/components/email/AttachmentChips.tsx:183`; `src/api/files.ts:411` has createFileNodeFromBlob.

- [ ] **Copy folders, numbered new folder names, next/previous in preview, starred and recent, deep links** — `P3` — `partial`/`missing`
  - What WEB does: `lib/jmap/client.ts:10155`, `stores/file-store.ts:640`, `lib/deep-links.ts:444`. What RN does: `src/api/files.ts:511-519`, `:328-345`, `src/components/files/FilePreviewModal.tsx`, `src/navigation/linking.ts:158`, `:307`.

- [ ] **Sharing fails on Stalwart before 0.16.6** — `P3` — `bug`
  - What WEB does: LegacyFileNodeRights (`lib/jmap/client.ts:66-70`). What RN does: `src/components/files/ShareSheet.tsx:33-41`.

### Filters and vacation

- [x] **Filter scripts saved by webmail 1.13+ open as raw Sieve; reset wipes them (#1152)** — `P1` — `bug` — fixed in 2167a9d7, fc9c164d
  - What WEB does: accepts metadata v1 and v2 (`lib/sieve/parser.ts:855`); writes v2 for rule periods, vacation forwarding or audience (`lib/jmap/sieve-types.ts:146`).
  - What RN does: `if (metadata.version !== 1) return OPAQUE` (`src/lib/sieve/parser.ts:804`); "Reset to visual builder" (`src/components/settings/FilterSettings.tsx:290-318`) wipes the rules and forwarding.
  - Fix hint: accept v2 and carry activeFrom/activeUntil, vacationForward, vacationAudience through parse and save.

- [x] **Webmail "is the address" / "has the domain" rules are broadened on a phone save** — `P1` — `bug` — fixed in 2167a9d7
  - What WEB does: `address :is` / `address :domain :is` (`lib/sieve/generator.ts:106`, `lib/sieve/parser.ts:485`).
  - What RN does: no such comparators (`src/lib/sieve/types.ts:27`); the generator's default branch writes `header :contains` (`src/lib/sieve/generator.ts:130-131`).

- [x] **"All messages" condition (#1154)** — `P2` — `missing` — fixed in 2167a9d7, df1a5ab4
  - What WEB does: `lib/sieve/generator.ts:61`. What RN does: throws on save (`src/lib/sieve/generator.ts:113`), so every save fails once a web rule uses it.

- [x] **"Stop processing" after Delete silently or Reject (#1153)** — `P2` — `bug` — fixed in 2167a9d7
  - What WEB does: `lib/sieve/generator.ts:487`. What RN does: skips `stop;` (`src/lib/sieve/generator.ts:396`).

- [x] **Rule names with double spaces get a duplicate (#1153)** — `P2` — `bug` — fixed in 2167a9d7
  - What WEB does: collapses whitespace (`lib/sieve/generator.ts:455`, `lib/sieve/parser.ts:904`). What RN does: `src/lib/sieve/parser.ts:841`, `src/lib/sieve/generator.ts:39`.

- [x] **Out of Office forwarding, reply audience and rule periods (#1152)** — `P2` — `missing` — fixed in df1a5ab4
  - What WEB does: `components/settings/vacation-settings.tsx:135`, `components/filters/filter-rule-modal.tsx:188`, `:299`, `lib/sieve/period.ts`. What RN does: `src/components/settings/VacationSettings.tsx:209`, `src/lib/sieve/types.ts:66-108`.

- [x] **Create rules from a message** — `P2` — `missing` — fixed in d546d509, 7b7236f0
  - What WEB does: `components/email/rules-menu.tsx`, `lib/filters/quick-rules.ts:187`. What RN does: `src/components/email/ActionSheet.tsx`, `src/components/filters/FilterRuleModal.tsx`.

- [ ] **Forward limit (#1155, #1208); vacation length warning; run a rule on a folder (#1166); Sieve editor loses typed text (#1162); size value raw into Sieve; undo after deleting tags/rules/trusted senders** — `P3` — `missing`/`bug`
  - What WEB does: `lib/filters/forward-limit.ts:16`, `components/settings/vacation-settings.tsx:253`, `lib/filters/quick-rule-flow.ts:221`, `lib/sieve/generator.ts:63`. What RN does: `src/components/filters/FilterRuleModal.tsx:63`, `:413`, `src/components/settings/VacationSettings.tsx:106`, `src/components/filters/SieveEditorSheet.tsx:35-41`, `src/lib/sieve/generator.ts:69-74`, `src/components/settings/KeywordSettings.tsx:50-56`.

### Push, settings and core

- [x] **Push is renewed for the active account only; settings show only that account (#1054)** — `P2` — `bug` — fixed in d92a2ca8
  - What WEB does: `components/push-notification-prompt.tsx:173`, `:219`, `components/settings/multi-account-push.tsx:33`.
  - What RN does: resyncPushNotifications works on the active client (`App.tsx:671`, `:723`; `src/lib/push-notifications.ts:1592-1602`), so other accounts' subscriptions expire.

- [x] **Push with two logins that share a JMAP account id** — `P2` — `bug` — fixed in 9ccb6228, b352e470
  - What WEB does: 07e6ecce1.
  - What RN does: the iOS extension's credentials are keyed by JMAP id (`src/lib/ios-push-shared.ts:54`); a tap opens the first match (`src/lib/push-notifications.ts:1873`); the background task checks every login with that id (`src/lib/push-background-task.ts:201`).

- [x] **Writes other than sends are replayed after a dropped connection** — `P2` — `partial` — fixed in d57bdfaa
  - What WEB does: retries read-only batches only (`lib/jmap/client.ts:245`).
  - What RN does: blocks the retry only for EmailSubmission/set, Email/import, Blob/upload (`src/api/jmap-client.ts:102-109`, `:853-857`).

- [ ] **Recover deleted items (#1319)** — `P3` — `missing`
  - What WEB does: `x:ArchivedItem/query` (`lib/recovery/archived-items.ts:139`, `lib/jmap/client.ts:12119`, `components/settings/recover-deleted-settings.tsx`).
  - What RN does: nothing (`src/screens/SettingsScreen.tsx:112`). The day limit and hiding need the policy.

- [ ] **Delegates** — `P3` — `missing`
  - What WEB does: Mailbox/AddressBook/Calendar shareWith in one batch (`lib/delegation/delegation.ts:96`).
  - What RN does: no mailbox sharing (`src/components/settings/FolderSettings.tsx`).

- [x] **Shared accounts treated as capable when their capabilities say otherwise (#1239)** — `P3` — `bug` — fixed in 67732348 (filters and auto-reply; contacts and files go with the calendar branch)
  - What WEB does: `lib/jmap/client.ts:6431`. What RN does: `src/api/contacts.ts:76`, `src/api/files.ts:98`, `src/api/sieve.ts:43`, `src/api/vacation.ts:77`.

- [x] **Storage quota ignores softLimit (#1242)** — `P3` — `bug` — fixed in af86339b
  - What WEB does: `lib/quota.ts:32`. What RN does: `src/api/quota.ts:50`.

- [ ] **Push extras: Inbox-only switch (#983), one ring per message (#1141), generic notification when the lookup fails (#1041), re-check on return (#1148)** — `P3` — `missing`/`partial` — Inbox-only done in 1821fda7, generic notification in f6e6f8f5, re-check on return in 327b2cae; not done: one ring per message (#1141) needs a change in the Android notification builder (BulwarkFcmModule.kt) and a device
  - What RN does: `src/lib/notification-mutes.ts`, `src/lib/push-background-task.ts:468-488`, `:518`, `src/components/settings/NotificationSettings.tsx:115-134`.

- [ ] **Settings extras: language search, date locale override, font size everywhere, nav-bar icon style, sidebar apps never rendered, screenshot protection, Flat fields theme** — `P3` — `missing`/`partial` (old 08/09 items) — screenshot protection not done: needs a new native module (expo-screen-capture); text size widened in c9b3bdfe
  - What RN does: `src/components/settings/LanguageSettings.tsx:87`, `src/theme/dynamic.ts:48`, `src/lib/sidebar-apps.ts:10`, `src/theme/builtin-themes.ts:18`.

- [ ] **Search snippets, size filter, mail folder sharing, global search (1.10.0)** — `P3` — `missing`

## Old open items (docs/parity 01-09, audit-2026-09)
Of 42 open boxes and "Missing vs webmail" items, 8 are done (84fef142 calendar UI strings, f62849d1 iOS push, 75299244 Tabler icons, 26a34d59 autocomplete groups, 5802cae contact deep link, status bar theming, birthday time zone, folder colours 548b647), 9 are no longer relevant (identity and template sync, settings sync, S/MIME is a plugin, #379 migration, stability banner, admin relay list, Android badge is iOS-only by design), and 25 are still open; those are folded into the rows above.

## Needs a decision
- Organisation policy on the phone: the app needs the webmail it was paired with and a webmail route that accepts a JMAP bearer token. Until then locked settings, session limits, external recipient confirm and label, the org signature and disclaimer, template locks and recovery limits can't be enforced on the phone.
- Webmail hand-off: replacing the password in the redirect with a one-time code needs the webmail side first.
