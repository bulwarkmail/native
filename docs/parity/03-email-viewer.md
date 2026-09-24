# Email viewer / thread view / message rendering / attachments

## Summary
RN has a solid single-message reader (WebView body with CSP, shrink-to-fit + pinch zoom, external-content gate with trusted senders, cid inlining, attachment open/share/save with templated filenames, view source, .eml export, calendar-invitation banner, shared-folder routing for body/attachments/source) but it is a *single-message* viewer, not a thread view, and it never fetches `headers`/`messageId`/`inReplyTo`/`references`, so everything the WEB viewer derives from headers (SPF/DKIM/DMARC, List-Unsubscribe, read receipts, Reply-To, identity badge, correct `In-Reply-To`) is absent or wrong. The biggest gaps: (1) older messages of a thread are unreachable and the pager shows the wrong message when opened from the unified inbox / contact activity; (2) replies write the JMAP id into `In-Reply-To`, ignore `Reply-To`, do not strip the user's own address on reply-all, and forwards drop every attachment; (3) HTML-only messages (same part in `textBody` and `htmlBody`) are rendered and quoted as raw HTML source, and `<style>` blocks are stripped wholesale, which is the most likely root of native issues #46 ("email preview shows css") and #49 ("Unreadable text in dark-mode emails"); (4) external-content blocking only recognises `<img src=http…>`, `background=` and inline `url()`, so srcset/`<source>`/poster/whitespace-obfuscated pixels still load.

## Findings

### Thread view / navigation

- [x] **Thread messages other than the newest are unreachable — fixed in d2ed27f** — `P1` — `missing`
  - What WEB does: opening a thread renders every message of the thread as expandable cards (newest + all unread auto-expanded), each with its own body, attachments, reply/forward and mark-read-on-expand (`components/email/thread-conversation-view.tsx:98-115`, `171-200`, store `fetchThreadEmails` via `Thread/get` + `Email/get` in `stores/email-store.ts:3574-3640`, `lib/jmap/client.ts:2763-2800`).
  - What RN does: the list collapses same-thread rows to the newest message with a count badge (`src/screens/EmailListScreen.tsx:224-238`, default `disableThreading: false` at `src/stores/settings-store.ts:266`), the row opens `EmailThreadScreen` with a single `emailId` (`App.tsx:145-151`), and the screen only ever shows that one message (`src/screens/EmailThreadScreen.tsx:113-120`, `685-840`). `getThread` exists in `src/api/email.ts:448` but is only used by a test. Older messages of a thread cannot be opened at all unless the user turns on "Disable Thread Grouping".
  - Fix hint: on open, call `getThread(threadId, ownerAccountId)` + `getFullEmails(ids)` and render a vertical list of collapsible message cards inside the pane (newest + unread expanded), reusing `EmailBodyView` per card; keep the horizontal pager for thread-to-thread navigation.

- [x] **Pager shows the wrong message (or nothing) when the opened email is not in the store list — fixed in c8be383** — `P1` — `rn-only-bug` — the body was right after c8be383, but delete, archive, move and spam hit the open folder's account, and new mail moved the page, until 5c7301b and 9c31de2 (audit B3, B5)
  - What WEB does: the viewer renders `selectedEmail` directly; prev/next are derived from the current list (`components/email/email-viewer.tsx:5220-5279`).
  - What RN does: the pager is a `FlatList` over `useEmailStore(s => s.emails)` and the initial index is `Math.max(0, emails.findIndex(id))` (`src/screens/EmailThreadScreen.tsx:128-133`, `535-572`). `UnifiedInboxScreen` keeps its own local list and never writes the store (`src/screens/UnifiedInboxScreen.tsx:35-50`, `61-84`), `ContactActivity` navigates with ids from a contact search (`src/components/contacts/ContactActivity.tsx:170-177`). In both cases the opened id is absent from `emails`, so the visible pane is `emails[0]` (a different mailbox's first message, or blank when the list is empty) while the toolbar/mark-read/delete act on `activeEmailId`.
  - Fix hint: when `route.params.emailId` is not in `emails`, render a single-item pager (`data=[{id: emailId}]`) and disable prev/next; or have the unified inbox / contact activity pass their own id list through route params.

- [x] **Mark-as-read "Never" (-1) marks the message read instantly — fixed in d2ed27f** — `P2` — `rn-only-bug`
  - What WEB does: `-1` means never auto-mark, `0` instant, `>0` delayed (`components/email/email-viewer.tsx:1218-1238`).
  - What RN does: `ReadingSettings` offers `Never = -1` (`src/components/settings/ReadingSettings.tsx:167-173`) but the viewer does `if (markAsReadDelay > 0) {timer} else { markRead() }` (`src/screens/EmailThreadScreen.tsx:237-245`), so `-1` behaves like instant.
  - Fix hint: add `if (markAsReadDelay === -1) return;` before the branch.

- [x] **Skeleton / loading parity — verified, no action** — `P3` — `verified` (see "Verified at parity"); no action.

### Body rendering & sanitisation

- [x] **HTML-only messages are rendered (and quoted) as raw HTML source — native issue #46 "email preview shows css" — fixed in 06742ef** — `P1` — `bug`
  - What WEB does: per RFC 8621 §4.1.4 an HTML-only message exposes the same part in `textBody` and `htmlBody`; WEB checks `hasDistinctTextBody` (different partIds) before preferring the text alternative, and routes by the part's `type` (`components/email/email-viewer.tsx:1727-1747`, `components/email/thread-conversation-view.tsx:332-346`; changelog 1.6.3 "Render HTML-only emails", "Render plain-text-only emails as text, not HTML").
  - What RN does: `extractTextBody` returns the html part's value for HTML-only mail, then `rawHtml = html && (!text || hasMeaningfulHtmlBody(html)) ? html : null` (`src/components/EmailBodyView.tsx:43-57`, `504-511`). For any HTML-only message whose markup fails `MEANINGFUL_HTML_RE` (`src/lib/email-html.ts:353-362`, e.g. a `<div>`/`<p>` body without `style=`), `rawHtml` is null and the raw source — tags, `<head>`, CSS — is shown as plain text. The same value feeds the reply quote: `plainTextBody()` (`src/screens/EmailThreadScreen.tsx:59-65`, `377`) so replies to HTML-only mail quote escaped HTML source.
  - Fix hint: compare `textBody[0].partId !== htmlBody[0].partId` (and `part.type === 'text/html'`) before treating `text` as an alternative; in `navigateCompose` pass `htmlBody` (and let `buildInitialHtml` use it) or convert with `htmlToPlainText` (`src/lib/compose-html.ts:108`) when the only body is HTML.

- [x] **`<style>` blocks are stripped from every HTML email — layout/colour loss, likely native issue #49 "Unreadable text in dark-mode emails" — fixed in 06742ef** — `P2` — `bugfix-parity`
  - What WEB does: iframe sanitiser keeps `<style>` (`lib/email-sanitization.ts:60-78`), and when external content is blocked it neutralises `url()`/`@import`/`@font-face` inside the sheet (`stripExternalStyleSheetCss`, `lib/email-sanitization.ts:474-509`, changelog 1.7.8 #457) while the strict iframe CSP is the network backstop (`components/email/email-viewer.tsx:2265-2267`).
  - What RN does: `FORBID_TAGS` includes `'style'` (and `svg`) so every stylesheet is removed before render (`src/lib/email-html.ts:16-28`, `50-68`). Class-based colours vanish: a newsletter with white text via `.hero { color:#fff }` on a `bgcolor` cell renders white-on-white (light) or, after the invert filter, black-on-black. Also `hasNativeDarkMode` is evaluated on the *stripped* HTML inside `wrapEmailHtml` (`src/lib/email-html.ts:226-229`) but on the raw HTML in the component (`src/components/EmailBodyView.tsx:612-613`), so for emails with `@media (prefers-color-scheme: dark)` the CSS inversion is applied but the DOM re-invert pass is skipped.
  - Fix hint: keep `<style>` (the WebView is an isolated document; CSP already has `style-src 'unsafe-inline'`), port `stripExternalStyleSheetCss` + `decodeCssEscapes` for the blocked case, and evaluate `hasNativeDarkMode` once on the same input.

- [x] **Dark-mode inversion CSS is an older revision of WEB's — fixed in d2ed27f** — `P2` — `bugfix-parity`
  - What WEB does (1.7.4 "Correct dark-mode background-image inversion and height clipping", 1.6.3 emoji/nested bgcolor, 1.7.7 `height:100%` wrappers): background-*image* containers are re-inverted unconditionally and their media get `filter:none`; only bgcolor/`background:` containers use the `:not(:has(media))` guard; nested guard is limited to colour containers; `[style*="height:100%"]` is neutralised; Word/Outlook HTML gets `line-height:1.15` + `MsoNormal` margins and a fallback gutter; `messageSpacing` auto/edge gutter (`components/email/email-viewer.tsx:2200-2253`, `2287-2305`, `2438-2461`).
  - What RN does: `DARK_INVERSION` applies the `:not(:has(...))` guard to background-image containers too and includes them in the nested `filter:none` rule (`src/lib/email-html.ts:167-185`), the DOM pass only re-inverts containers without media children (`src/components/EmailBodyView.tsx:72-88`); no Word/Outlook padding, no per-message light/dark toggle (WEB toolbar Sun/Moon, `email-viewer.tsx:3199-3212`, changelog 1.6.0), no `messageSpacing`.
  - Fix hint: copy the current `darkModeCSS` block and the DOM re-invert loop verbatim into `email-html.ts` / `DARK_REINVERT_SCRIPT`; add a "View in light/dark mode" entry to the More sheet that overrides `renderAsDark` for the current message.

- [x] **External-content detection misses most tracking vectors (privacy leak) — fixed in 06742ef** — `P2` — `bugfix-parity`
  - What WEB does: `isExternalResourceUrl` strips C0/space so `"\nhttps://x"` and `h\ttps://` count; blocks `<img srcset>`, `<picture><source>`, `<video poster>`, media `src`, `background=`, inline `url()` incl. CSS escapes, `<style>` url()/@import, and forbids `<link>` in blocking mode; the banner is driven by "something was actually blocked" (`lib/email-sanitization.ts:399-406`, `511-615`, `108-150`; changelog 1.7.8).
  - What RN does: `hasRemoteContent` only matches `<img src="http…">`, `background="http…"` and `style="...url(http…)"` (`src/lib/email-html.ts:364-369`); when it returns false `shouldBlock` is false and the CSP becomes `img-src data: cid: https: http:` (`src/lib/email-html.ts:235`), so a pixel expressed as `srcset=`, `<source>`, `poster=`, `src=" https://…"` (leading whitespace/newline), or a CSS-escaped `\68ttps://` loads unconditionally under policy `ask`/`block`. `blockRemoteImageSrcs` (`316-347`) is likewise src/srcset/background/style only, and has no `data-blocked-*` restore.
  - Fix hint: make the gate policy-driven rather than detection-driven (block = strict CSP `img-src data: cid:` + `media-src`/`font-src` none whenever policy is `block`/`ask`-not-allowed and sender untrusted, like WEB's `externalBlocked`), port `isExternalResourceUrl` normalisation, add `source/video/audio/poster/link` handling, and show the banner when the strict CSP is in effect and the HTML contains any `http(s)://` resource reference.

- [x] **Blocked images leave broken-image icons / alt text; empty containers not collapsed — fixed in 06742ef** — `P3` — `bugfix-parity`
  - What WEB does: swaps `src` for a transparent 1x1 GIF, empties `alt`, `display:none`, and collapses empty `<td>/<div>` wrappers (`lib/email-sanitization.ts:319-320`, `537-546`, `678-704`); hides images that fail to load (`components/email/email-viewer.tsx:2393-2411`, changelog 1.7.7).
  - What RN does: sets `src=""` and `alt="[remote image blocked]"` (`src/lib/email-html.ts:319-323`), so blocked newsletters show rows of broken-image glyphs with English alt text; no failed-image hiding.
  - Fix hint: use the same transparent-GIF + `display:none` swap and port `collapseBlockedImageContainers` as a regex/DOM pass in the injected script; add an `img` `error` listener that hides the element.

- [x] **mailto: links inside the body open the OS mail handler instead of the app composer — fixed in 06742ef** — `P2` — `missing`
  - What WEB does: `mailto:` opens the built-in composer with parsed to/subject/body (changelog 1.8.1 "Open mailto: links in the built-in composer"; iframe click handler leaves `mailto:` to the app's protocol handling, `components/email/email-viewer.tsx:2420-2436`).
  - What RN does: `onShouldStartLoadWithRequest` hands `mailto:` to `Linking.openURL` (`src/components/EmailBodyView.tsx:715-724`), so tapping an address in an email opens Gmail/Apple Mail instead of Bulwark.
  - Fix hint: parse `mailto:` (address, `subject`, `body`, `cc`) and `navigation.navigate('Compose', { prefillTo, ... })`; the `prefillTo` param already exists (`src/screens/ComposeScreen.tsx:292-298`).

- [x] **`data:` URL navigations replace the email body — fixed in 06742ef** — `P3` — `rn-only-bug`
  - What RN does: `onShouldStartLoadWithRequest` returns `true` for any `data:` URL (`src/components/EmailBodyView.tsx:717-719`), and `safeUri` keeps `href="data:image/…"` (`src/lib/email-html.ts:109-113`); tapping such a link navigates the WebView to the image with no way back. Only the initial `about:blank` load should be allowed.
  - Fix hint: allow `data:` only when `request.navigationType === 'other' && !request.isTopFrame`-style initial loads, otherwise return false (optionally open images externally).

- [x] **Regex sanitiser + `script-src 'unsafe-inline'`: keep the data-URI/SVG allowlist in sync with WEB — fixed in 06742ef** — `P3` — `partial`
  - What WEB does: allows only raster `data:image/(png|jpe?g|gif|webp|bmp|avif|x-icon|vnd.microsoft.icon)` on media tags, re-checks `srcset` candidates individually, forbids SVG data URIs and `<svg>` (`lib/email-sanitization.ts:24`, `330-388`), and the iframe has no scripting at all.
  - What RN does: `safeUri` allows any `data:image/*` including `image/svg+xml` (`src/lib/email-html.ts:109-113`), `srcset` values are never scheme-checked except when blocking (`326-329`), and the page CSP must allow `'unsafe-inline'` scripts for the injected bridge (`236-245`), so a parser-differential bypass of the regex stripper would execute script in the WebView (limited blast radius: the bridge only accepts height/swipe/zoom strings).
  - Fix hint: restrict `data:` to the raster list, scheme-check every `srcset` candidate, and consider parsing with a real HTML parser (e.g. `htmlparser2`/`parse5` on the JS side) instead of regexes; document the residual risk.

- [x] **Quoted reply text is not collapsed (#480) — fixed in 06742ef** — `P3` — `missing`
  - What WEB does: hides the trailing quote (Gmail/Outlook/Apple/Thunderbird/Bulwark markers, attributed `<blockquote>`, `>`-lines in plain text) behind a "•••" toggle (`lib/quote-collapse.ts:143-197`, `219-259`; changelog 1.7.8).
  - What RN does: nothing; long threads show every quoted original inline.
  - Fix hint: port `setupQuoteCollapse` into the injected WebView script (runs on the parsed DOM, uses inline styles only) and `collapsePlainTextQuotes` into `wrapPlainTextEmail`.

- [x] **Plain-text bodies are always monospace (#830) — fixed in 06742ef** — `P3` — `bugfix-parity`
  - What WEB does: renders text/plain in the app font by default with a `plainTextFont: 'sans' | 'mono'` setting (`stores/settings-store.ts:329`, `565`; `components/email/email-viewer.tsx:5050-5060`; changelog 1.9.0).
  - What RN does: `wrapPlainTextEmail` hard-codes `ui-monospace, Menlo, …` (`src/lib/email-html.ts:290`); no setting (`src/stores/settings-store.ts` has no `plainTextFont`).
  - Fix hint: add the setting (Reading settings) and switch the font-family in `wrapPlainTextEmail`.

- [x] **Plain-text linkifier only catches http(s) — verified, no action** — `P3` — `verified` (same as WEB `plainTextToSafeHtml`); no action.

- [x] **cid images larger than 2 MB and non-image cid parts silently show a 1x1 placeholder; octet-stream cid parts (#543) unverified — fixed in 06742ef** — `P3` — `partial`
  - What WEB does: fetches every cid part as an authenticated `blob:` URL regardless of size/type; the browser sniffs `application/octet-stream` image bytes (`components/email/email-viewer.tsx:1509-1575`; changelog 1.8.1 #543).
  - What RN does: skips parts over `MAX_INLINE_IMAGE_BYTES` (`src/components/EmailBodyView.tsx:15`, `556-559`) and builds `data:${att.type || 'application/octet-stream'};base64,…` (`573`), which Chromium/WebKit may refuse to decode as an image for `application/octet-stream`.
  - Fix hint: sniff magic bytes (PNG/JPEG/GIF/WebP) to pick the MIME for the data URI; for >2 MB parts encode off the JS thread (e.g. `File.base64()` from expo-file-system after `downloadInto`) instead of dropping them.

### Header / meta

- [x] **`headers`, `messageId`, `inReplyTo`, `references` are never fetched — fixed in ccbe67c** — `P2` — `missing` (root cause for the next five items)
  - What WEB does: `Email/get` requests `messageId, inReplyTo, references, headers, bodyStructure` and parses `Authentication-Results`, `X-Spam-*`, `X-Spam-LLM` into `email.authenticationResults/spamScore/spamLLM` (`lib/jmap/client.ts:1775-1870`).
  - What RN does: `EMAIL_FULL_PROPERTIES` stops at `bodyStructure, textBody, htmlBody, bodyValues, attachments, blobId, bcc, replyTo, sentAt` (`src/api/email.ts:11-15`); the `Email` type has no `headers`/`messageId` (`src/api/types.ts:65-87`).
  - Fix hint: add the four properties to `EMAIL_FULL_PROPERTIES`, extend the type, and port `parseAuthenticationResults`/`parseSpamScore`/`extractListHeaders` (`lib/email-headers.ts`) to `src/lib/email-headers.ts`.

- [x] **No "Show details" panel: CC/BCC/Reply-To/sent vs received/size/MIME/Message-ID/thread id — fixed in d2ed27f** — `P2` — `missing`
  - What WEB does: header shows To/CC/BCC (first 2 + "+N", "me" substitution), a "Show details" toggle with recipients & routing, delivery delta, identifiers/threading, message properties, mailing-list section (`components/email/email-viewer.tsx:3892-3944`, `4187-4542`).
  - What RN does: one line `to <names>` (`src/screens/EmailThreadScreen.tsx:806-809`); CC/BCC/Reply-To are fetched but never shown; date/size only (`811-817`).
  - Fix hint: add CC/BCC rows and a collapsible details block under the sender row; reuse `formatSize`.

- [x] **SPF/DKIM/DMARC/spam-score chips and spoof-aware identity badge — fixed in d2ed27f** — `P3` — `missing`
  - What WEB does: auth chips with severity-ranked SPF (HELO vs MAIL FROM, #650), DMARC policy, iprev, spam score/LLM verdict (`components/email/email-viewer.tsx:4353-4438`, `lib/email-headers.ts:13-115`); "via <identity>" / sub-address tag badge hidden when spoofed (`components/email/email-identity-badge.tsx:33-68`, changelog 1.7.3).
  - What RN does: none.
  - Fix hint: after the headers finding, render chips in the details block; port `isAuthenticationSpoofed` for the badge.

- [x] **List-Unsubscribe (RFC 2369) banner — fixed in d2ed27f** — `P2` — `missing`
  - What WEB does: parses `List-Unsubscribe` (http preferred, else mailto), confirm dialog, sends the mailto unsubscribe through the account itself, remembers dismissals per Message-ID (`components/email/unsubscribe-banner.tsx:64-106`, `components/email/email-viewer.tsx:753-773`, `2672-2680`; changelog 1.7.7).
  - What RN does: none.
  - Fix hint: port `parseUnsubscribeUrls`/`isValidUnsubscribeUrl` from `lib/validation.ts`; for mailto call `sendEmail` with the parsed fields; open http via `expo-web-browser`.

- [x] **Read receipts (MDN, RFC 8098): request banner, send, "always/ask/never", `$mdnsent` — fixed in d2ed27f** — `P2` — `missing` — the receipt headers were not sanitized (GHSA-w38p) and "Always send" answered the unseen neighbour pages until cb6ddd6 and 5f3f584 (audit S1, B7)
  - What WEB does: detects `Disposition-Notification-To`, offers Send/Ignore (or auto-sends in "always" mode) only in received folders, builds the multipart/report with `lib/mdn.ts`, uploads → `Email/import` into Sent → `EmailSubmission/set` with explicit envelope, then sets `$mdnsent` (`components/email/email-viewer.tsx:2686-2784`, `lib/jmap/client.ts:4080-4130`, `components/email/read-receipt-banner.tsx`).
  - What RN does: none; no `readReceiptResponse` setting.
  - Fix hint: port `lib/mdn.ts` verbatim (pure string builder), reuse `uploadBytes` (`src/api/blob.ts:67`) + `importEmailBlob` (`src/api/email.ts:423`) + an `EmailSubmission/set` helper; add the setting.

- [x] **Reply-To shown / used — fixed in 7f956d6** — folded into the reply-recipients finding below.

- [x] **Sender / recipient tap actions (popover, view/add contact, copy address) — fixed in d2ed27f** — `P3` — `missing`
  - What WEB does: every address is a `RecipientPopover` (contact lookup, extra emails/phones, copy, email, view/add contact); tapping the avatar opens the contact sidebar or, on mobile, the contact page (`components/email/recipient-popover.tsx`, `components/email/email-viewer.tsx:1140-1170`, `3841-3866`).
  - What RN does: names are static `Text` (`src/screens/EmailThreadScreen.tsx:794-810`).
  - Fix hint: wrap sender/recipients in `Pressable` opening a small action sheet (copy, compose to, open `ContactDetail`/`ContactForm` prefilled).

- [x] **Displayed date uses `receivedAt` and device locale, ignoring the app's time-format setting — fixed in d2ed27f** — `P3` — `bugfix-parity`
  - What WEB does: `emailDisplayDate` prefers `sentAt` (falls back when missing or >24 h in the future, #891) and formats with the user's `timeFormat`/locale (`lib/email-date.ts:33-45`, `components/email/email-viewer.tsx:3811`).
  - What RN does: `formatHeaderDate(email.receivedAt)` with `toLocaleDateString(undefined, …)` (`src/screens/EmailThreadScreen.tsx:39-50`, `812-816`), so imported/migrated mail shows the import date and 12/24 h ignores the setting.
  - Fix hint: port `emailDisplayDate` (already in `src/lib/date-format.ts`?—if not, 15 lines) and use `useSettingsStore(s => s.timeFormat)` + locale from `useLocaleStore`.

- [x] **Tags, `$important` badge and answered/forwarded state in the header — fixed in d2ed27f** — `P3` — `missing`
  - What WEB does: tag badges (removable) under the subject, "Important" pill (`components/email/email-viewer.tsx:3789-3806`); `$answered`/`$forwarded` set after send (`components/mail/mail-app.tsx:1663-1667`).
  - What RN does: Tag sheet exists but no badges are rendered in the pane; `$answered`/`$forwarded` are never set after a reply/forward (no hit for `$answered` in `src/`).
  - Fix hint: render `keywordDefs` matches from `email.keywords` under the subject; after a successful send in `ComposeScreen` call `setEmailKeywords(originalId, {...keywords, $answered|$forwarded: true}, accountId)`.

### Calendar invitation banner

- [x] **Invitation parsing is not routed to the owning account (#847, #867) — fixed in 8206893** — `P2` — `bugfix-parity`
  - What WEB does: parses/fetches the ICS through the message's source client and owner account, including directly viewed shared folders (`components/email/calendar-invitation-banner.tsx:373-388`, `412-432`; changelog 1.9.0).
  - What RN does: `parseCalendarBlob(attachment.blobId)` uses `jmapClient.accountId` (`src/components/email/CalendarInvitationBanner.tsx:54`, `src/api/calendar.ts:355-360`) even though `EmailPane` knows `jmapAccountId`; Stalwart answers `CalendarEvent/parse` with an error for a blob in another account, so invitations in group/shared mailboxes show nothing (state `error` → banner hidden).
  - Fix hint: pass `jmapAccountId` from `EmailPane` into the banner and through to `parseCalendarBlob(blobId, accountId)`.

- [x] **iMIP method detection ignores the raw ICS `METHOD` and Content-Type params — fixed in 8206893** — `P2` — `partial`
  - What WEB does: reads `method=` from the part/attachment/header Content-Type, then fetches the raw ICS and reads `METHOD:` (`lib/calendar-invitation.ts:319-339`, `components/email/calendar-invitation-banner.tsx:419-447`), falling back to participant heuristics; `CANCEL`, `REPLY`, `COUNTER`, `REFRESH`, `DECLINECOUNTER`, `PUBLISH`, `ADD` each get their own title/info/actions.
  - What RN does: `extractMethodFromRawIcs` exists (`src/lib/calendar-invitation.ts:103-106`) but is never called; only `inferInvitationMethod` heuristics are used (`CalendarInvitationBanner.tsx:62`), so a cancellation whose event status is not `cancelled`, or a REPLY from a single attendee, is shown as a plain invitation with RSVP buttons.
  - Fix hint: fetch the blob text (`getDownloadUrl` + `secureFetch`, as `fetchRawEmail` does) in parallel with parse and prefer `extractMethodFromRawIcs`.

- [ ] **Banner lacks WEB's trust assessment, actor summary, existing-event / "already in calendar" state, calendar picker, "View in calendar", collapse, sequence badge, counter-proposal review** — `P3` — `partial` — deferred: trust assessment, iTIP method and calendar picker landed in 8206893 (calendar agent); existing-event state, "View in calendar", collapse, sequence badge and counter-proposal review remain open in the calendar area
  - What WEB does: `getInvitationTrustAssessment` (sender vs organizer + auth results) warning, actor line ("X accepted"), `queryCalendarEvents({uid})` to show "already in calendar" and current RSVP, picker when >1 calendar, "View in calendar" navigation, collapsible card, `sequence` "updated" pill, apply counter proposal for organizers (`components/email/calendar-invitation-banner.tsx:392-474`, `502-553`, `657-672`, `721-752`, `802-1140`).
  - What RN does: title/date/location/video/organizer rows, Yes/Maybe/No, Add to first writable calendar (`src/components/email/CalendarInvitationBanner.tsx:83-207`); no dedupe check before offering "Add", no picker, no trust warning, no navigation to the event.
  - Fix hint: port `getInvitationTrustAssessment` (needs the headers finding for auth), look up `useCalendarStore.events` by `uid` to switch to "already in calendar"/current response, add a calendar picker sheet when `calendars.length > 1`, and a "View in calendar" button that navigates to `CalendarScreen` with the start date.

- [x] **The `.ics` part stays in the attachment list while the banner is shown — fixed in d2ed27f** — `P3` — `bugfix-parity`
  - What WEB does: hides calendar MIME parts when the banner renders (`components/email/email-viewer.tsx:1591-1600`; changelog 1.4.14).
  - What RN does: `renderAttachments` filters only inline images (`src/screens/EmailThreadScreen.tsx:713-722`).
  - Fix hint: filter `isCalendarType(att.type) || name.endsWith('.ics')` when `calendarInvitationParsingEnabled && findCalendarAttachment(email)`.

### Attachments

- [x] **Forwarding drops every attachment — fixed in 7f956d6** — `P1` — `bug`
  - What WEB does: forward pre-populates the composer with the original's attachments by blobId (minus embedded cid images) (`components/email/email-composer.tsx:598-616`, #543).
  - What RN does: `navigateCompose('forward')` passes only from/to/cc/subject/plain body (`src/screens/EmailThreadScreen.tsx:366-382`); the `Compose.replyTo` param has no `attachments` field (`src/navigation/types.ts:7-19`) and `ComposeScreen` never seeds `attachments` from the original (`src/screens/ComposeScreen.tsx:354`). A forwarded invoice arrives without the PDF.
  - Fix hint: add `attachments?: Attachment[]` to the route param, and in `ComposeScreen` initialise `attachments` with `{blobId,name,type,size}` entries (blobs are account-scoped so no re-upload is needed; for shared-folder messages the blob belongs to the owner account — either re-upload via `getDownloadUrl(..., ownerAccountId)` + `uploadBytes`, or block forward there).

- [x] **message/rfc822 attachments: no inline unwrap, no `.eml` preview — fixed in d2ed27f** — `P2` — `missing`
  - What WEB does: when the outer body is empty (Outlook "forward as attachment") it parses the embedded message with postal-mime and renders its body + attachments, keeping the `.eml` chip; `.eml` attachments preview like an email (`components/email/email-viewer.tsx:1433-1507`, `1625-1636`; changelog 1.7.3, 1.8.1).
  - What RN does: the message renders "(empty message)" and the `.eml` chip can only be shared.
  - Fix hint: add `postal-mime` (pure JS, works in RN with a `TextDecoder` polyfill) and mirror the unwrap effect; render the parsed HTML through `EmailBodyView`.

- [x] **TNEF `winmail.dat` is not decoded — fixed in d2ed27f** — `P3` — `missing`
  - What WEB does: parses winmail.dat (body + embedded attachments) and hides the container (`lib/tnef.ts`, `components/email/email-viewer.tsx:1344-1431`).
  - What RN does: shows `winmail.dat` as an opaque attachment; the real files inside are unreachable.
  - Fix hint: `lib/tnef.ts` is pure `Uint8Array` code; copy it and feed `jmapClient.fetchBlobArrayBuffer`.

- [x] **Attachment chip list: no MIME-based fallback names, MDN/DSN report parts and non-inline cid images mishandled — fixed in d2ed27f** — `P3` — `partial`
  - What WEB does: unnamed parts get `Document.pdf`/`Email.eml`/`Attachment.<sub>` (`components/email/email-viewer.tsx:191-225`); `message/disposition-notification` and `message/delivery-status` parts are hidden (`1604-1606`); inline hiding requires `disposition === 'inline'` (`1601-1603`).
  - What RN does: unnamed → `'attachment'` (`src/screens/EmailThreadScreen.tsx:745`); report parts are listed; any `cid` image is hidden regardless of disposition (`719-721`), so an image attached with a Content-ID but `disposition: attachment` (common from some clients) disappears from the list even when the body does not reference it.
  - Fix hint: port `getAttachmentDisplayName`, add the two report-type filters, and check `disposition === 'inline'` (or that the body actually references the cid via `extractCidRefs`).

- [x] **No image thumbnails on chips, no "Download all" zip, no per-chip Preview vs Download choice — fixed in d2ed27f** — `P3` — `missing`
  - What WEB does: image chips show the actual image (≤10 MB), a "Download all" bundles into a zip named by template, hover reveals separate Download/Preview buttons (`components/email/email-viewer.tsx:2024-2102`, `2104-2161`, `3949-4085`; changelog 1.6.0, 1.7.5).
  - What RN does: single tap follows the global `mailAttachmentAction`; `jszip` is already a dependency (`package.json:36`) but unused for mail.
  - Fix hint: long-press sheet with "Open / Save / Share"; a "Download all" entry building the zip with `jszip` into `Paths.cache` then sharing.

- [x] **In-app attachment preview (images, PDF, text, audio/video) is absent; iOS "Preview" is just the share sheet — fixed in d2ed27f** — `P3` — `partial`
  - What WEB does: `FilePreviewModal` for images/PDF (bytes handed to pdf.js, #871)/text/markdown/audio/video/eml, script-bearing types forced to download (`components/mail/mail-app.tsx:2887-2935`, `lib/file-preview.ts:29-92`).
  - What RN does: Android hands the file to an external viewer via `ACTION_VIEW`, iOS opens the share sheet (`src/lib/email-export.ts:64-79`, `115-141`); nothing is previewed inside the app.
  - Fix hint: for images/PDF/text open a modal `WebView` on the cached `file://` (or use `expo-file-system`'s `File.uri` with a QuickLook bridge on iOS); keep the external-viewer path as fallback.

- [x] **Post-export action (archive/trash after "Export .eml") missing — fixed in d2ed27f** — `P3` — `missing`
  - What WEB does: `postExportAction` setting runs archive/trash after export (`components/email/email-viewer.tsx:2559-2571`).
  - What RN does: export only (`src/screens/EmailThreadScreen.tsx:632-640`).
  - Fix hint: add the setting and call `onArchive`/`onDelete` after `shareEmailEml` resolves.

### Actions from the viewer

- [x] **`In-Reply-To`/`References` are written with the JMAP email id (#234 bugfix-parity) — fixed in 7f956d6** — `P1` — `bug`
  - What WEB does: passes the original's RFC `messageId` and `references`, stripped of brackets, as JMAP `inReplyTo`/`references` arrays (`lib/jmap/client.ts:3124-3194`; changelog 1.5.4 #234).
  - What RN does: `navigateCompose` sets `inReplyTo: email.id` (`src/screens/EmailThreadScreen.tsx:379`), and `sendEmail` writes it verbatim into `header:In-Reply-To:asText` / `header:References:asText` (`src/api/email.ts:823-826`). The outgoing header is a bare Stalwart object id, not a msg-id, so recipients' clients cannot thread the reply and `References` is never accumulated. `messageId`/`references` are not even fetched (see headers finding).
  - Fix hint: fetch `messageId`/`references`, pass `inReplyTo: email.messageId?.[0]` and `references: [...(email.references ?? []), email.messageId[0]]`, and send them as JMAP `inReplyTo`/`references` arrays (or `<…>`-wrapped `header:…:asMessageIds`).

- [x] **Reply addressing: Reply-To ignored, own addresses kept on reply-all, self-sent thread replies (#703), external Reply-To on self-sent (1.9.0) — fixed in 7f956d6** — `P1` — `bugfix-parity`
  - What WEB does: `buildReplyRecipients` — reply goes to `Reply-To` if present else `From`; reply-all adds original To/CC minus the user's own identities (exact and `+tag`-stripped); replying to your own message continues to its original recipients; an external Reply-To on a self-sent message still wins (`lib/reply-recipients.ts:74-111`, `components/mail/mail-app.tsx:920`, `2940-2944`).
  - What RN does: `initialTo` = From (+ all original To on reply-all, including the user's own address), `initialCc` = all CC; `email.replyTo` is fetched but never passed (`src/screens/ComposeScreen.tsx:299-319`, `src/screens/EmailThreadScreen.tsx:366-382`). Replying to a newsletter with `Reply-To: support@…` mails the no-reply sender; reply-all sends the user a copy; replying to your own sent message addresses yourself.
  - Fix hint: copy `lib/reply-recipients.ts` (pure), pass `replyToAddresses: email.replyTo` in the route param and the identities' emails as `ownEmails`.

- [x] **Reply/forward quote is plain text only — HTML formatting and inline images lost (#163, #543) — fixed in 7f956d6** — `P2` — `bugfix-parity`
  - What WEB does: quotes the sanitized HTML body (with cid images re-attached inline) inside an editable quote island, localized "On … wrote:" header with `Name <email>` (`components/email/email-composer.tsx:462-500`, `lib/quote-header.ts:54-91`; changelog 1.7.1, 1.7.3, 1.8.1).
  - What RN does: `buildInitialHtml` supports `htmlBody` (`src/lib/compose-html.ts:79-83`) but the viewer only passes `body: plainTextBody(email)` (`src/screens/EmailThreadScreen.tsx:377`), and the header uses display name only (`compose-html.ts:31-35`) rather than WEB's `Name <email>` (#482).
  - Fix hint: pass `htmlBody` (sanitized via `stripDangerousTags`, cid refs rewritten to fetched data URIs or re-attached with the same `cid`) and switch `senderName` to the `Name <email>` form.

- [x] **Forward as attachment (.eml) missing — fixed in d2ed27f** — `P3` — `missing`
  - What WEB does: More menu "Forward as attachment" builds a `message/rfc822` attachment referencing the original blobId with a `{date}-{subject}.eml` name (`lib/forward-as-attachment.ts:38-58`, `components/mail/mail-app.tsx:2022-2060`; changelog 1.8.1).
  - What RN does: none.
  - Fix hint: add a More-sheet entry that opens `Compose` with `attachments: [{blobId: email.blobId, name, type: 'message/rfc822', size: email.size}]` (depends on the forward-attachments fix).

- [x] **Reply identity selection: exact match only, no `+tag` or catch-all domain override (#246) — fixed in 5b72c4d** — `P3` — `partial`
  - What WEB does: `resolveReplyFrom` — exact, then `+tag`-stripped, then same-domain catch-all with a From override (`lib/reply-identity.ts:197-256`).
  - What RN does: `identities.find(i => i.email === candidate.email)` (`src/screens/ComposeScreen.tsx:431-437`).
  - Fix hint: port `resolveReplyFrom`; the override needs a From override in `sendEmail`.

- [x] **Quick reply box under the message — fixed in d2ed27f** — `P3` — `missing`
  - What WEB does: inline textarea with Send / "More options" (opens composer prefilled), Ctrl+Enter (`components/email/email-viewer.tsx:5066-5154`).
  - What RN does: none.
  - Fix hint: optional; a bottom input that calls `sendEmail` with `buildReplyRecipients` output and the plain-text quote.

- [x] **View source: no copy-to-clipboard; whole raw message loaded into a `<Text>` — fixed in d2ed27f** — `P3` — `partial`
  - What WEB does: synthetic source from the JMAP object with a Copy button (`components/email/email-viewer.tsx:5159-5208`, `lib/email-source.ts`). RN's raw RFC 822 view is actually more faithful.
  - What RN does: fetches the full blob as text and renders it in one selectable `Text` (`src/screens/EmailSourceScreen.tsx:24-35`, `68-70`); a 30 MB message will stall the JS thread.
  - Fix hint: add `Clipboard.setStringAsync`; cap display at e.g. 1 MB with a "Share full source" fallback.

- [x] **Add sender to contacts / edit contact from the viewer — fixed in d2ed27f** — `P3` — `missing`
  - What WEB does: contact sidebar with "Add to contacts"/"Edit" (`components/email/email-viewer.tsx:552-568`, `5336-5368`; changelog 1.7.4).
  - What RN does: none (see popover finding).
  - Fix hint: sheet entry navigating to `ContactForm` with prefilled name/email.

### Trusted senders / settings

- [x] **"Trust sender" writes to the Trusted Senders address book even when the setting is off — fixed in 06742ef** — `P3` — `rn-only-bug`
  - What WEB does: writes to the book only when `trustedSendersAddressBook` is on, else to the local list (`components/email/email-viewer.tsx:4646-4655`, `components/trusted-senders-modal.tsx:136-140`).
  - What RN does: always does both (`src/components/EmailBodyView.tsx:644-653`), and `addToTrustedSendersBook` creates the book on first add (`src/stores/contacts-store.ts:308-321`), so a user who left the setting off (default `false`, `src/stores/settings-store.ts:239`) still gets a server-side "Trusted Senders" address book; the settings modal then lists only the local entries (`src/components/settings/ContentSendersSettings.tsx:19-21`, `123-144`), so book-trusted senders are invisible/unremovable there.
  - Fix hint: gate the book write on the setting (or, matching WEB 1.9.0, default the setting to on for contacts-capable accounts) and show `trustedSenderEmails` in the settings modal with remove support.

- [x] **S/MIME settings screen is a dead stub — fixed in 3d0d440** — `P3` — `rn-only-bug`
  - What WEB does: built-in S/MIME was removed from core in 1.7.6 and lives in a privileged plugin; the viewer has no S/MIME state (`components/email/email-viewer.tsx:923-937`).
  - What RN does: `SmimeSettings` renders empty mock arrays and buttons with no handlers (`src/components/settings/SmimeSettings.tsx:32-33`, `118-121`, `163-166`); there is no verification/decryption in the viewer.
  - Fix hint: hide the screen (or show a "not available in the mobile app" note) until a crypto path exists; treat viewer-side S/MIME as N/A.

## Verified at parity (brief list, so the fixer knows what NOT to redo)
- Body isolation: sandboxed WebView with `default-src 'none'` CSP, `originWhitelist` about:blank, links opened externally, no cookies/storage/file access (`src/components/EmailBodyView.tsx:675-724`, `src/lib/email-html.ts:236-256`) — matches WEB's srcDoc iframe + CSP approach (1.6.7).
- `hasMeaningfulHtmlBody` text-alternative preference (`src/lib/email-html.ts:353-362`) — same regex as WEB `lib/signature-utils.ts` (only the same-partId guard is missing, see P1 finding).
- Dark mode: invert+hue-rotate with media re-invert, native-dark-mode detection, emoji re-invert pass, "Always view emails in light mode" setting (`src/lib/email-html.ts:167-185`, `197-199`, `src/components/EmailBodyView.tsx:64-157`, `499-502`) — only the CSS revision differs (see finding).
- Plain-text path: escaped + linkified, native dark colours without inversion (`src/lib/email-html.ts:120-126`, `263-311`).
- External content policy ask/block/allow, per-message "Load external content", "Trust sender" persisting locally and to the address book, trusted list from the address book and contacts (`src/components/EmailBodyView.tsx:480-535`, `643-672`).
- cid inline images fetched with auth and injected as data URIs, transparent placeholder otherwise (`src/components/EmailBodyView.tsx:546-584`, `src/lib/email-html.ts:213-218`).
- Shrink-to-fit of fixed-width emails + in-page pinch zoom/pan with pager/scroll locking (`src/components/EmailBodyView.tsx:159-460`) — RN-only, better than WEB's horizontal scroll (#409).
- Mark read on open with delay setting (apart from the `-1` bug), optimistic star/unread/tag toggles, delete/archive/spam/not-spam/move scoped to the message's account, `no trash folder` alert (`src/screens/EmailThreadScreen.tsx:221-364`).
- Prev/next navigation with prefetched neighbour panes and swipe (`src/screens/EmailThreadScreen.tsx:122-181`, `535-572`) — RN-only pager.
- Skeleton while loading (`src/screens/EmailThreadScreen.tsx:845-886`).
- Attachments: chips with size, show-all toggle, `hideInlineImageAttachments` setting, `attachmentPosition` setting, `mailAttachmentAction` preview/download, templated filenames + transforms identical to WEB (`src/lib/download-filename.ts` diff vs `lib/download-filename.ts` is whitespace/quotes only, minus `DEFAULT_BUNDLE_TEMPLATE`/`BUNDLE_TOKENS`), Downloads settings screen with live preview (`src/components/settings/DownloadsSettings.tsx`).
- Attachment/blob/source/.eml fetches routed by owner account for shared/group messages (`src/screens/EmailThreadScreen.tsx:87-96`, `198-215`, `src/api/blob.ts:119-135`, `src/lib/email-export.ts`) — #847/#867 parity except the calendar banner.
- Client-cert-aware downloads via `secureFetch`, streaming download via `File.downloadFileAsync` (`src/lib/email-export.ts:85-113`).
- View source (raw RFC 822, shareable) and Export .eml with the email filename template (`src/screens/EmailSourceScreen.tsx`, `src/lib/email-export.ts:173-206`).
- Calendar invitation: detection by MIME/extension, parse via `CalendarEvent/parse`, RSVP via import-then-`rsvpEvent` with `replyTo`/`organizerCalendarAddress`, cancelled notice, "no writable calendar" warning, `calendarInvitationParsingEnabled` setting (`src/components/email/CalendarInvitationBanner.tsx`, `src/lib/calendar-invitation.ts`).
- Tag sheet from the viewer with keyword definitions (`src/screens/EmailThreadScreen.tsx:1033-1100`).

## N/A on mobile
- Print (WEB `handlePrint`, `components/email/email-viewer.tsx:2621-2670`) — could be done with `expo-print` later, but not a parity requirement.
- Copy permalink / deep link to a message (#733) — RN has no linking configuration; no `linking` prop in `App.tsx`.
- Fullscreen reading toggle, Pro split panes, toolbar overflow measurement, plugin slots/hooks (`email-banner`, `email-detail-sidebar`, `onRenderEmailBody`, `onBeforeExternalLink`, `ui.rerenderEmail`), keyboard shortcuts, drag attachments out to the file system (#267), drag emails out as `.eml`, import `.eml` from the viewer menu (RN imports from the list screen instead).
- Iframe-specific fixes: "Render the email body on DOM parse instead of iframe load" (#635), iframe flash/flicker fixes (1.5.4, 1.6.7), `blob:` in CSP `object-src`/`frame-src` for PDF previews (#253), pdf.js bytes vs `blob:` fetch (#871), RSC 307 loop (#919), iOS Safari viewport zoom on input focus (#838).
- Demo-mode welcome pane, tour, contact sidebar panel layout (desktop only; the actions themselves are listed above).
- S/MIME plugin UI (WEB core has none since 1.7.6); listed above only because RN ships a misleading stub.
