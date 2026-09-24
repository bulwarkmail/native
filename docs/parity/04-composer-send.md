# Composer, drafts, sending, identities, signatures, templates, scheduled send

## Summary
RN has a working "compose / reply / forward / send now / send later" happy path (WebView rich editor with send-time readback, attachments + inline images, contact suggestions, identity sheet, HOLDFOR scheduling with a cancel list) but is far from parity with the 3,900-line web composer. The biggest gaps are structural: RN has **no drafts at all** (no autosave, no save-on-close, no opening/editing an existing draft), **no signatures** (identities carry `textSignature`/`htmlSignature` but the composer never uses them), **no Bcc**, **no template insertion in the composer**, **no Reply-To handling**, and **broken threading headers** (`In-Reply-To` is set to the JMAP email id instead of the RFC Message-ID). The send path also files the message into Sent *before* submission, so a failed `EmailSubmission/set` leaves a never-sent copy in Sent. Several web bugfixes (reply-all self-dedupe / #703, #570 attachment reminder on quoted text, #702 request timeout, unclosed angle brackets, subject-prefix dedupe) are not present in RN.

Legend for refs: WEB paths are relative to `the webmail repo`, RN paths to `the native repo`.

## Findings

### Drafts

- [x] **No draft autosave / save-on-close — closing a compose loses everything** — fixed in 5b72c4d — `P1` — `missing` — offline or without a Drafts folder the close dialog still dropped the text, and the iOS swipe skipped the dialog, until 92b42e4 (audit B16)
  - What WEB does: debounced 2 s autosave to the server Drafts folder with `$draft`+`$seen` keywords (`components/email/email-composer.tsx:1648-1815` saveDraftOnce, `:1842-1883` timer; `lib/jmap/client.ts:2998-3060` createDraft), serialized against send (#303, `:1821-1837`), `beforeunload` best-effort save (`:1082-1091`), "Save / Discard / Cancel" close dialog (`:2347-2426`, `handleSaveDraftAndClose`, `handleDiscardAndClose`), toast when the save is refused so text is not dropped (`:2384-2401`, #702).
  - What RN does: the only close path is `onClose` in `src/screens/ComposeScreen.tsx:518-541`, an Alert with Cancel / **Discard** — no "Save draft" option and no server draft is ever created. The hardware back button / iOS swipe-back is not intercepted at all (no `beforeRemove` listener anywhere in `ComposeScreen.tsx` or `src/navigation/*`), so the dirty guard is bypassed entirely by the OS back gesture.
  - Fix hint: add a `createDraft(...)`-style call in `src/api/email.ts` (Email/set create into the `drafts`-role mailbox with `$draft`/`$seen`, destroy previous draft id only after the new create succeeds), call it from a debounced effect + from the close Alert ("Save draft" button), and register `navigation.addListener('beforeRemove', …)` to route back gestures through the same guard.

- [x] **Cannot open / edit an existing draft** — fixed in 5b72c4d — `P1` — `missing`
  - What WEB does: `handleEditDraft` in `components/mail/mail-app.tsx:1812` re-opens a draft with recipients, subject, HTML body, identity restored from `From` (`lib/reply-identity.ts:140-167` findDraftIdentityId), server attachments carried as blobId refs (`email-composer.tsx:577-597`, #849) and the signature embedded (`:520-535`, #848); sending destroys the old draft only after success (`lib/jmap/client.ts:3342-3360`) and clears the viewer when the sent draft was displayed (`mail-app.tsx:1645-1648`).
  - What RN does: `RootStackParamList.Compose` (`src/navigation/types.ts:7-22`) has no `draftId`/initial-body params; tapping a message in the Drafts folder opens the read-only `EmailThreadScreen` (no `role === 'drafts'` handling anywhere in `src/screens/EmailThreadScreen.tsx` or `src/screens/EmailListScreen.tsx`).
  - Fix hint: add a `draft` route param (id, to/cc/bcc, subject, htmlBody, attachments, from), an "Edit draft" action in the thread screen when the mailbox role is `drafts` or the email has `$draft`, and pass `draftId` into `sendEmail` so the old draft is destroyed after a successful submission. Depends on the previous item.

- [x] **Draft keeps In-Reply-To/References and reply-mode state** — fixed in 5b72c4d — `P2` — `missing`
  - What WEB does: drafts store the reply context in `ComposerDraftData` (`email-composer.tsx:109-132`) and threading headers are computed at send from the parent (`lib/email-threading.ts:30-51`).
  - What RN does: N/A today because drafts do not exist; when implementing drafts make sure `inReplyTo`/`references` (see the threading finding below) survive the round trip.
  - Fix hint: persist `header:In-Reply-To`/`header:References` on the draft Email/set and read them back via `inReplyTo`/`references` properties when reopening.

### Sending / EmailSubmission

- [x] **Message is filed into Sent before submission — a failed send leaves a fake "sent" copy** — fixed in ccbe67c — `P1` — `bug`
  - What WEB does: creates the email in Drafts with `$draft` and moves it to Sent via `onSuccessUpdateEmail` on the `EmailSubmission/set` (`lib/jmap/client.ts:3195-3196`, `:3234-3239`, #188); a `notCreated` on the submission throws and the draft simply stays in Drafts (`:3289-3312`).
  - What RN does: `src/api/email.ts:794-796` sets `mailboxIds: { [sentMailboxId]: true }, keywords: { $seen: true }` on the `Email/set` create, and the `EmailSubmission/set` at `:848-855` has no `onSuccessUpdateEmail`. If the submission is rejected (`notCreated` handled at `:870-872`) the user gets a "Send failed" alert but the message is already sitting in Sent looking sent; a retry duplicates it.
  - Fix hint: create into the Drafts mailbox with `$draft`, add `onSuccessUpdateEmail: { '#draft': { 'mailboxIds/<sent>': true, 'mailboxIds/<drafts>': null, 'keywords/$draft': null } }` to the submission call; RN already has `ownMailboxes(mailboxes)` to find the Drafts role.

- [x] **In-Reply-To / References carry the JMAP email id instead of the Message-ID** — fixed in 7f956d6 — `P1` — `rn-only-bug`
  - What WEB does: `computeReplyThreadingHeaders` (`lib/email-threading.ts:30-51`) builds `inReplyTo = [parent.messageId]`, `references = parent.references + parent.messageId`, brackets stripped; the client sends them as the JMAP `inReplyTo`/`references` properties (`lib/jmap/client.ts:3177-3194`) and fetches `messageId`/`inReplyTo`/`references` on the email (`:1787-1788`).
  - What RN does: `src/screens/EmailThreadScreen.tsx:379` passes `inReplyTo: email.id` (the JMAP id, e.g. `a1b2c3`), never `references`; `src/api/email.ts:823-826` writes that value verbatim into `header:In-Reply-To:asText` and `header:References:asText`. `EMAIL_FULL_PROPERTIES` (`src/api/email.ts:11-15`) does not even request `messageId`/`references`, and the RN `Email` type (`src/api/types.ts:65-87`) has no such fields. Every RN reply therefore breaks threading in recipients' clients and emits a syntactically invalid `In-Reply-To`.
  - Fix hint: add `'messageId', 'inReplyTo', 'references'` to `EMAIL_FULL_PROPERTIES` and the `Email` type, port `computeReplyThreadingHeaders`, and send `inReplyTo`/`references` as JMAP array properties (bare msg-ids) instead of raw `header:*:asText` strings. Only replies should continue the chain; forwards should not (WEB `email-composer.tsx:2142-2145`).

- [x] **No request timeout — a stalled send hangs the composer forever** — fixed in ccbe67c — `P2` — `bugfix-parity` (changelog 1.7.x "Time out stalled JMAP requests so a send can't hang forever (#702)")
  - What WEB does: `JMAPClient.REQUEST_TIMEOUT_MS = 30_000` (`lib/jmap/client.ts:629`, `:811`, `:830-843`) raising `RequestTimeoutError`; the composer shows a dedicated "may already have gone out, check Sent" message instead of "send failed" so users do not re-send duplicates (`email-composer.tsx:2315-2323`).
  - What RN does: `jmapClient.request` (`src/api/jmap-client.ts:405-445`) uses `secureFetch` with no `AbortSignal`/deadline; `performSend` (`ComposeScreen.tsx:906-982`) leaves `sending=true` until the promise settles, so the Send button spins indefinitely on a stalled connection.
  - Fix hint: wrap `secureFetch` in an `AbortController` + `setTimeout` (30 s) in `jmapClient.request` (or a `timeoutMs` option used by `sendEmail`), throw a distinguishable `RequestTimeoutError`, and show a "may already be sent - check Sent" alert in `performSend`'s catch.

- [x] **Undo-send delay has no undo toast / "send now"** — fixed in 5b72c4d — `P2` — `partial`
  - What WEB does: after a delayed send `pendingUndoSend` is set (`stores/email-store.ts:1700-1712`) and a toast offers Undo / Send now (changelog 1.7.0 "'Send now' action on the send-delay toast"; `email-store.ts:4381` cancelUndoSend).
  - What RN does: `onSend` (`ComposeScreen.tsx:825-828`) applies `sendDelaySeconds` as HOLDFOR and `performSend` deliberately stays silent for the undo window (`:961-963` comment: "invisible unless the user cancels from the Scheduled view"). There is an `UndoSnackbar` component (`src/components/UndoSnackbar.tsx`) but it is not used for send. The user has to know to open the Scheduled screen within the 5-30 s window.
  - Fix hint: after `sendEmail` returns `{ scheduled: true, emailSubmissionId }` show `UndoSnackbar` for `sendDelaySeconds` with Undo → `cancelScheduledSend(id)` and "Send now" → EmailSubmission/set update of the envelope without HOLDFOR (or cancel + resend), mirroring `rescheduleEmailSubmission` in `lib/jmap/client.ts:7985`.

- [x] **Double-submit guard relies on async state** — fixed in 7f956d6 — `P3` — `bugfix-parity` (changelog 1.6.x "Guard Send against double-submit")
  - What WEB does: synchronous `isSendingRef` re-entry guard (`email-composer.tsx:1980-1986`, `:2007`, `:2078-2079`).
  - What RN does: `performSend` checks `canSend` which includes `!sending` (`ComposeScreen.tsx:508-516`, `:883`), but `setSending(true)` only happens after two awaits (`getHtml` at `:892`, attachment reminder at `:905`), so two quick taps both pass the guard and submit twice.
  - Fix hint: add a `sendingRef = useRef(false)` set synchronously at the top of `performSend`, reset in `finally`.

- [x] **Reply / forward does not mark the original `$answered` / `$forwarded`** — fixed in 7f956d6 — `P2` — `missing`
  - What WEB does: after a successful reply/forward the original gets `$answered` or `$forwarded` (`components/mail/mail-app.tsx:1663-1673`), routed to the owning account.
  - What RN does: nothing — `grep -F '$answered'` over `src/` returns no hits; `performSend` (`ComposeScreen.tsx:941-974`) has no access to the original email id (`replyTo` params in `src/navigation/types.ts:10-19` carry no `emailId`).
  - Fix hint: add `originalEmailId`/`jmapAccountId` to the `replyTo` route param and call the existing keyword primitive (`setEmailKeywords` via `applyOrQueue` in `src/stores/outbox-store.ts`) after the send resolves. (`setEmailKeywords` is gone since 5041897; the keyword primitive is now `patchKeywordsForEmails`, and the outbox queues `keywords/<name>` patches.)

- [x] **Identity `replyTo` / `bcc` are never applied to outgoing mail** — fixed in 7f956d6 — `P2` — `missing`
  - What WEB does: `sendEmail` copies the identity's `replyTo` onto the message (`lib/jmap/client.ts:3167-3172`, `:3184`); identity form lets users edit Reply-To and Bcc (`components/identity/identity-form.tsx:39-41`, `:66-70`, `:132-133`).
  - What RN does: RN `Identity` type has `replyTo`/`bcc` (`src/api/types.ts:136-145`) but `sendEmail` (`src/api/email.ts:788-796`) never sets `replyTo`, and no composer Reply-To field exists; `IdentitySettings.tsx:209-215` edits only name/email/textSignature.
  - Fix hint: in `sendEmail` set `replyTo: identity.replyTo` and merge `identity.bcc` into `bcc`; pass the full `Identity` (not only `primaryIdentity.id`) from `performSend`.

- [x] **Read-receipt (MDN) request missing** — fixed in 5b72c4d — `P3` — `missing`
  - What WEB does: composer toggle (`email-composer.tsx:3053-3066`), `requestReadReceiptDefault` setting (`stores/settings-store.ts:351`), header `Disposition-Notification-To` set on create (`lib/jmap/client.ts:3201-3204`).
  - What RN does: no toggle, no setting, header never set.
  - Fix hint: add a toolbar toggle + `requestReadReceipt` option to `sendEmail` that writes `header:Disposition-Notification-To:asText`.

- [x] **Client-side Message-ID not generated** — fixed in ccbe67c — `P3` — `partial`
  - What WEB does: `generateMessageId(fromEmail)` with the sender's domain, guarded for insecure origins (`lib/jmap/client.ts:544-575`, `:3192`; changelog 1.9.0 fix).
  - What RN does: `sendEmail` sets no `messageId`, relying on the server; RN's `src/lib/uuid.ts:6-20` already has a guarded UUID generator (Hermes fallback) so the crash class of the web fix does not apply.
  - Fix hint: optional — set `messageId: [`${generateUUID()}@${domain}`]` in `sendEmail` so the id is known before the response (useful once drafts/threading exist).

- [ ] **Sending from shared/group accounts unsupported** — `P3` — `missing` (partly N/A) — deferred: RN is single-active-account; envelope/identity routing for shared accounts not implemented
  - What WEB does: routes the submission to the identity's owning account (#461, `email-composer.tsx:2258-2274`, `lib/jmap/client.ts:3131-3134` targetAccountId) and preselects the shared folder's identity (`lib/reply-identity.ts:114-128`).
  - What RN does: `ComposeScreen.tsx:267-272` explicitly always uses the user's own Sent ("composing on behalf of a shared account isn't supported"), `getIdentities` (`src/api/identity.ts:5-12`) only queries the primary account. Replying from a shared-folder message sends as the reaching login.
  - Fix hint: low priority; if implemented, query `Identity/get` for the shared `accountId`, submit with that `accountId`, and file into that account's Sent.

- [x] **Dead duplicate send implementation** — fixed in 42ab246 — `P3` — `rn-only-bug`
  - What RN does: `src/api/submission.ts:5-64` is an older `sendEmail` (no HOLDFOR, no result) that nothing imports (`grep "api/submission"` → no hits); `ComposeScreen.tsx:38` imports `sendEmail` from `src/api/email.ts`.
  - Fix hint: delete `src/api/submission.ts` (and its test if any) to avoid someone wiring the stale path.

### Recipients

- [x] **No Bcc field** — fixed in 5b72c4d — `P2` — `missing`
  - What WEB does: Bcc chip input toggled next to To (`email-composer.tsx:2768-2792`, `:2825-2851`), included in send/draft/dirty-check.
  - What RN does: only To and Cc (`ComposeScreen.tsx:346-349` state, `:1058-1149` UI); `sendEmail` accepts `bcc` (`src/api/email.ts:772`) but the screen never passes it.
  - Fix hint: clone the Cc block (`ccRecipients`/`ccInput`/`ccVisible`) as Bcc, include it in `alreadySelected`, `commitTyped`, `isDirty`, and the `sendEmail` call.

- [x] **Reply-To header ignored when replying** — fixed in 7f956d6 — `P2` — `bugfix-parity` (changelog 1.9.0 "Honour an external Reply-To even on a self-sent message"; 1.7.x #703)
  - What WEB does: `buildReplyRecipients` (`lib/reply-recipients.ts:74-111`) replies to `replyToAddresses` when present (RFC 5322), falls back to From, and handles self-sent messages (`isSelfSent`, `:52-54`) by addressing the original To/Cc instead of yourself.
  - What RN does: `initialTo` (`ComposeScreen.tsx:291-312`) always uses `replyTo.from`; `EmailThreadScreen.tsx:370-381` does not pass `email.replyTo` although it is fetched (`EMAIL_FULL_PROPERTIES` includes `replyTo`). Replying to a mailing-list/ticket mail with Reply-To goes to the wrong address; replying to your own sent message mails yourself.
  - Fix hint: pass `replyToAddresses: email.replyTo` in the route param and port `buildReplyRecipients` (pure TS, no DOM) into `src/lib/`.

- [x] **Reply-all does not drop the user's own identities / duplicates** — fixed in 7f956d6 — `P2` — `bugfix-parity`
  - What WEB does: reply-all filters every own identity address (exact and `+tag`-stripped) out of To/Cc (`lib/reply-recipients.ts:39-45`, `:104-110`) and `expandRecipients` dedupes case-insensitively across the whole list (`lib/email-composer-utils.ts:425-437`).
  - What RN does: `initialTo` (`ComposeScreen.tsx:304-310`) adds every original `to` except the From; `initialCc` (`:314-319`) copies `cc` unfiltered — the user's own address lands in To/Cc of every reply-all, and the same address can appear in both To and Cc (`alreadySelected` at `:371-374` only guards suggestions).
  - Fix hint: filter against the identities list (already loaded at `:406-419`, but note it loads asynchronously — compute recipients after identities arrive or filter at send time) and dedupe across To/Cc/Bcc in `commitTyped`.

- [x] **Cc addresses are not validated; `Name <addr` recovery and quoted names missing** — fixed in 5b72c4d — `P3` — `bugfix-parity` (changelog 1.9.0 "Split recipient lists whose angle brackets never close", 1.7.x #672)
  - What WEB does: `splitRecipients` is quote/angle-aware and recovers from an unclosed `<` (`lib/email-composer-utils.ts:275-321`), `splitPastedRecipients` keeps display names, unwraps `<addr>` tokens and returns leftovers to the input (`:470-521`), `splitMailbox` tolerates a missing `>` (`lib/rfc5322-mailbox.ts:49-58`), `isValidEmail` is RFC 5322 with injection guards (`lib/validation.ts:4-28`).
  - What RN does: `parseRecipients` (`ComposeScreen.tsx:69-84`) splits on `[,;\n]` regardless of quotes, requires a closed `>` (else the whole string becomes the "email"), and `hasValidRecipients` (`:504`) only checks **To** against a loose `EMAIL_RE` (`:66`) — an invalid Cc chip is sent to the server and fails there. `"Doe, John" <j@x>` becomes two chips.
  - Fix hint: port `splitRecipients`/`parseRecipient`/`splitPastedRecipients` and `isValidEmail` (all DOM-free) into `src/lib/recipients.ts`; validate Cc/Bcc in `canSend` and mark invalid chips red.

- [x] **Contact groups not offered as recipients; no server (Sent-folder) search** — fixed in 5b72c4d — `P3` — `missing`
  - What WEB does: groups appear in autocomplete as a single expandable chip (`email-composer.tsx:1214-1245`, changelog 1.7.0), plus an on-demand "search the server" row backed by Sent (`:1189-1212`, changelog 1.6.x).
  - What RN does: suggestions come only from `individuals` (`ComposeScreen.tsx:367-392`, groups filtered out); groups are reachable only via `GroupDetailScreen.tsx:83` prefill.
  - Fix hint: include groups in `suggestions` and expand members on pick (use `isGroup`/members from `contacts-store`); server search is optional.

- [x] **Recipient chips show no avatar / no "Name <addr>" tooltip; no chip editing** — fixed in 5b72c4d — `P3` — `partial` (N/A for drag-reorder)
  - What WEB does: avatars in suggestions, chip context menu (copy, add to contacts, move To/Cc/Bcc) (`email-composer.tsx:3860-3895`).
  - What RN does: `RecipientChip` (`ComposeScreen.tsx:111-124`) shows name-or-email with an X only.
  - Fix hint: long-press menu with "Move to Cc/Bcc", "Copy address", "Add to contacts".

### Identity / From

- [x] **Sub-addressing (`user+tag@`) missing** — fixed in 5b72c4d — `P3` — `missing`
  - What WEB does: `SubAddressHelper` next to From with tag suggestions (`components/identity/sub-address-helper.tsx`, `lib/sub-addressing.ts`), configurable delimiter (`stores/settings-store.ts:347`), identity matching strips `+tag` (`lib/reply-identity.ts:18-31`).
  - What RN does: none; identity matching in `ComposeScreen.tsx:424-441` is exact-address only.
  - Fix hint: port `lib/sub-addressing.ts` (pure) and add a small "+tag" affordance in the From row.

- [x] **From override / catch-all alias on an owned domain missing** — fixed in 5b72c4d — `P3` — `missing` (changelog 1.5.x #246)
  - What WEB does: `resolveReplyFrom` (`lib/reply-identity.ts:197-256`) picks an identity or, when the message arrived at an unknown address on a domain the user owns, pre-fills a From override sent through the identity's envelope (`email-composer.tsx:2598-2708` UI, `:2113-2121` envelope).
  - What RN does: From is always an identity (`ComposeScreen.tsx:908`).
  - Fix hint: port `resolveReplyFrom`; allow an override name/email pair and set `submissionCreate.envelope.mailFrom` to the identity (RN already builds envelopes for HOLDFOR at `src/api/email.ts:828-844`).

- [x] **Identity preselection does not consider Bcc or `+tag` and never uses the primary-identity setting** — fixed in c659b54 — `P3` — `partial`
  - What WEB does: exact → base (`+tag` stripped) match over to/cc/bcc (`lib/reply-identity.ts:38-68`), self-sent keeps the sending identity (`email-composer.tsx:812-822`), synced `preferredPrimaryId` default identity (#507, `stores/identity-store.ts:18,77`; `hooks/use-identity-sync.ts`).
  - What RN does: `ComposeScreen.tsx:424-441` matches exact addresses in to/cc only (no bcc, no base match), default = identity matching the active account email else `identities[0]`; no "default identity" setting exists in `IdentitySettings.tsx`.
  - Fix hint: port `findReplyIdentityId`; add a "Use as default" action in `IdentitySettings` persisted in `settings-store`.

- [x] **Identity display name not sanitized on create/update** — fixed in ccbe67c — `P3` — `bugfix-parity` (changelog 1.5.x "Sanitize identity display name to prevent invalid From headers")
  - What WEB does: `sanitizeIdentityDisplayName` before every Email/set (`lib/jmap/client.ts:3034`, `:3181`) and `sanitizeDisplayName` (`lib/rfc5322-mailbox.ts:27-30`).
  - What RN does: `IdentitySettings.tsx:253-278` sends the raw name; `performSend` uses `primaryIdentity.name` verbatim (`ComposeScreen.tsx:908`). A name like `Jane <jane@x>` or one containing a newline produces a malformed From.
  - Fix hint: port `sanitizeDisplayName` and apply it in `saveDraft` (IdentitySettings) and in `sendEmail`'s `from`.

- [x] **Identity editor lacks HTML signature, Reply-To, Bcc fields and size caps** — fixed in c659b54 — `P3` — `partial` — note: the HTML signature is edited as raw HTML in a monospace field (no rich preview); links/images are sanitized on save
  - What WEB does: `components/identity/identity-form.tsx` edits name, Reply-To list, Bcc list, text + HTML signature with a 2047-byte cap hint (`:12`, `:39-41`, `:66-70`, `:126-133`), sanitizes HTML.
  - What RN does: `IdentitySettings.tsx:209-215` DraftIdentity has name/email/textSignature only.
  - Fix hint: add multiline `htmlSignature` (or keep text-only but at least Reply-To/Bcc comma lists validated with the ported `isValidEmail`).

- [ ] **Identity sync (visibility/interval refresh) missing** — `P3` — `partial` — deferred: composer refetches on every mount; acceptable per finding
  - What WEB does: `hooks/use-identity-sync.ts` refreshes identities on tab focus and every 30 min.
  - What RN does: `ComposeScreen.tsx:406-419` refetches on every composer mount (adequate), but `settings-store.identities` (`src/stores/settings-store.ts:424-431`) only refreshes when the Identities settings pane mounts. Acceptable; listed for completeness.
  - Fix hint: optional `AppState` foreground refresh.

### Signatures

- [x] **Signatures are never inserted or sent** — fixed in 5b72c4d — `P2` — `missing`
  - What WEB does: compose embeds the signature as an editable block (`email-composer.tsx:254-275` buildEmbeddedSignatureHtml, `:437-443`), replies place it above or below the quote per `signaturePosition` (`:345-353`, `stores/settings-store.ts:349-350`), `-- ` separator toggle, plain-text fallback (`lib/signature-utils.ts:18-51`), alias without signature falls back to the primary identity's (`email-composer.tsx:688-693`), identity switch swaps the block (`:702-775`), double-click unlocks the atom for editing (`components/email/signature-block.ts:112-120`, `:240`), drafts keep it (#848).
  - What RN does: `Identity.textSignature`/`htmlSignature` exist (`src/api/types.ts:142-143`) and are editable in settings, but `buildInitialHtml` (`src/lib/compose-html.ts:64-106`) and `performSend` (`ComposeScreen.tsx:906-960`) never reference them. Users who set a signature in RN or on the web get none on mobile.
  - Fix hint: in `buildInitialHtml` append `<p>-- </p><div data-signature>…</div>` (sanitized `htmlSignature`, else escaped `textSignature`) after the empty paragraph for compose and above/below the quote for replies according to a new `signaturePosition` setting; re-splice on identity change via `editorRef.setHtml`. The WebView editor is a plain contenteditable, so no "unlock" mechanism is needed (mobile equivalent of 3d1bdf09 is simply "always editable").

- [x] **Signature settings (position, separator) absent** — fixed in c659b54 — `P3` — `missing`
  - What WEB does: `components/settings/composing-settings.tsx:84-96` (position above/below quote, `-- ` separator).
  - What RN does: `ComposingSettings.tsx:13-20` exposes auto-select identity, send delay, attachment reminder only; `settings-store.ts:131-137` has no signature keys.
  - Fix hint: add `signaturePosition` / `signatureSeparatorEnabled` to `settings-store` and the Composing pane (do this together with the signature finding).

### Editor / body

- [x] **Reply / forward quotes plain text only — HTML layout and inline images are lost** — fixed in 5b72c4d — `P2` — `missing` (changelog #163, #543, "Editable, layout-preserving quote island")
  - What WEB does: `getQuoteBodies` picks the right part by MIME (`lib/email-composer-utils.ts:36-55`, #649), quotes the sanitized HTML as an editable island (`email-composer.tsx:482-496`), rewrites `cid:` images and hydrates them as data URLs so they render and are re-attached on send (`:873-957`, `:1938-1978`).
  - What RN does: `EmailThreadScreen.tsx:59-65` `plainTextBody` returns the text part or `preview`, and `navigateCompose` passes only `body` (`:377`); `buildInitialHtml` supports `htmlBody` (`compose-html.ts:76-80`) but is never given one. Replies to HTML-only mail quote whatever `textBody[0]` holds (for HTML-only messages RFC 8621 exposes the HTML source there — raw tags in the quote, the #649 bug) and inline images vanish.
  - Fix hint: pass `htmlBody` (sanitized via `stripDangerousTags`/`email-html.ts`) from the thread screen, port `getQuoteBodies`' MIME routing, and for `cid:` images fetch the blob (`getDownloadUrl` in `src/api/blob.ts:119`) as base64, insert with `data-cid`, and add the part as `disposition: 'inline'` on send (RN's `rewriteInlineImages` at `compose-html.ts:143-161` already handles `data-cid`).

- [x] **Forward drops the original attachments** — fixed in 7f956d6 — `P1` — `missing`
  - What WEB does: forward seeds the composer with the original's attachments as blobId refs (`email-composer.tsx:598-617`), skipping cid-embedded images, and sends them along (`:2200-2213`); "Forward as attachment" also exists (`lib/forward-as-attachment.ts`).
  - What RN does: `navigateCompose` (`EmailThreadScreen.tsx:366-382`) passes no attachments and `Compose` params have no attachment field; `attachments` state starts empty (`ComposeScreen.tsx:354`). A forwarded invoice arrives without the invoice, silently.
  - Fix hint: add `attachments: email.attachments` (blobId/name/type/size, filter `disposition==='inline'` images referenced by the body) to the route param and seed `AttachmentEntry`s with `blobId` set and `uploading:false`; `OutgoingAttachment` already accepts blobIds from another message in the same account.

- [x] **Quote header is English-only and shows the sender name without address** — fixed in 5b72c4d — `P3` — `partial` (changelog #482, i18n quote header)
  - What WEB does: localized `quote_header.*` labels and `On {date}, {from} wrote:` (`lib/quote-header.ts:54-91`), sender rendered as `Name <email>`.
  - What RN does: `compose-html.ts:84-105` hardcodes "Forwarded message", "From/Date/Subject", "On …, X wrote:" and `senderName` (`:30-33`) returns name **or** email, never both. Locale files exist under `locales/<lang>/`.
  - Fix hint: pass translated labels via `QuoteHeaderOptions` and render `Name <email>` (escaped) like the web.

- [x] **Subject prefix handling does not strip foreign / stacked prefixes and is not localized** — fixed in 7f956d6 — `P3` — `bugfix-parity` (changelog "Drop single-letter R:/I: tokens and deduplicate localized reply/forward prefixes", "full-width colon")
  - What WEB does: `lib/subject-prefix.ts:14-56` token lists + `buildReplySubject`/`buildForwardSubject` (`:109-121`) strip `Re: AW: WG: Fwd:` chains, `Re[2]:`, full-width colons, then add the locale prefix from `email_composer.prefix.*`.
  - What RN does: `ComposeScreen.tsx:321-328` only tests `^re:`/`^fwd?:`; "AW: foo" becomes "Re: AW: foo", "Fwd: foo" replied becomes "Re: Fwd: foo".
  - Fix hint: copy `lib/subject-prefix.ts` verbatim (pure TS) and use the locale's prefix strings.

- [x] **Attachment reminder scans the quoted original** — fixed in 5b72c4d — `P3` — `bugfix-parity` (changelog #570)
  - What WEB does: `extractUserAuthoredText` strips blockquotes/quoted island and everything after the forwarded separator before keyword matching (`lib/email-composer-utils.ts:175-210`, used at `email-composer.tsx:2060-2066`).
  - What RN does: `passesAttachmentReminder` (`ComposeScreen.tsx:764-791`) runs `htmlToPlainText` over the **whole** editor HTML including the `<blockquote>`/forward block built by `buildInitialHtml`, so replying to any mail that mentions "attached" fires the warning.
  - Fix hint: strip `<blockquote>…</blockquote>` and everything from the forwarded separator before matching (regex is fine, no DOM needed).

- [x] **Empty subject blocks Send instead of confirming** — fixed in 5b72c4d — `P3` — `bugfix-parity` (changelog #684)
  - What WEB does: confirm dialog with "Don't ask again" (`email-composer.tsx:2046-2051`, `:3228-3264`, setting `emptySubjectWarningEnabled`).
  - What RN does: `canSend` requires `subject.trim().length > 0` (`ComposeScreen.tsx:513`) — the Send button is simply disabled with no explanation.
  - Fix hint: drop the subject condition from `canSend` and add an Alert ("Send without subject?") gated by a new `emptySubjectWarningEnabled` setting.

- [x] **Toolbar coverage: no text color, tables, font, horizontal rule, text-direction** — fixed in 5b72c4d — `P3` — `partial`
  - What WEB does: Tiptap with Underline, Link, TextAlign, TextStyle+Color, ResizableImage, Table (`components/email/rich-text-editor.tsx:191-225`), auto text direction (changelog 1.7.0), tables (#236).
  - What RN does: bold/italic/underline/strike, H1/H2, lists, blockquote, align, link, image, clear, undo/redo (`ComposeScreen.tsx:1190-1240`; commands in `src/components/RichTextEditor.tsx:8-24`). No `dir="auto"` on the editor (`src/lib/editor-html.ts:244`).
  - Fix hint: `execCommand('foreColor')` + a small palette, `insertHTML` for a basic table; set `dir="auto"` on `#editor`.

- [x] **Plain-text mode still renders the rich editor and derives text from HTML (links lose their href)** — fixed in c659b54 — `P3` — `partial` — note: the toggle now also lives under Composing; the duplicate in ReadingSettings (area 08 file, uncommitted edits there) was left in place
  - What WEB does: plain-text mode swaps to a `<textarea>` (`email-composer.tsx:2875-2891`) and `htmlToPlainText` renders links as `text <href>` (`lib/html-to-text.ts:134-146`); the setting lives under Composing (#422).
  - What RN does: `plainTextMode` only suppresses the HTML part at send (`ComposeScreen.tsx:951`); the user still sees formatting buttons; `htmlToPlainText` (`compose-html.ts:113-135`) strips `<a>` tags entirely so pasted links disappear from the text/plain alternative (which is the **only** part in plain-text mode). The toggle sits in `ReadingSettings.tsx:262` instead of Composing.
  - Fix hint: hide the format bar and use a `TextInput multiline` when `plainTextMode`; in `htmlToPlainText` replace `<a href="X">T</a>` with `T <X>` before stripping tags; move the toggle to `ComposingSettings`.

- [x] **Inline image insert: no camera, no paste, no multi-select; not offered for file attachments either** — fixed in 5b72c4d — `P3` — `partial`
  - What WEB does: drag/drop and paste of images embed as data URLs + cid (`email-composer.tsx:1519-1551`, changelog #163).
  - What RN does: `insertInlineImage` (`ComposeScreen.tsx:693-732`) library only, single image; `pickFileAttachment` (`:646-673`) picks one file at a time; no `launchCameraAsync`.
  - Fix hint: add a "Camera" option to the attach Alert (`ImagePicker.launchCameraAsync`) and allow multiple in `pickFileAsync` where supported.

- [x] **Send-time editor readback (RN #9/#11) — verified robust, one edge** — fixed in 5b72c4d — `P3` — `rn-only-bug`
  - What RN does: `getHtml` rejects after 2 s when the page script is dead (`src/components/RichTextEditor.tsx:143-152`) and `performSend` aborts loudly (`ComposeScreen.tsx:890-902`); `editor-html.ts` is escape-free and unit-tested (`src/lib/__tests__/editor-html.test.ts`). The Android release fix (c5e5092) has since been superseded by the inline `source={{ html }}` + `originWhitelist={['about:blank']}` approach (`RichTextEditor.tsx:198-230`); `android/app/src/main/assets/editor.html` from that commit is no longer referenced (`grep editor.html` → only the TS module). Edge: `removeAttachment` (`ComposeScreen.tsx:553-571`) rewrites `bodyHtml` from the last `change` message rather than a live readback, so if the bridge lags it can `setHtml` a stale body and drop the last keystrokes.
  - Fix hint: use `await editorRef.current.getHtml()` before stripping the `<img data-cid>`; delete the orphaned `editor.html` asset.

### Attachments / upload

- [x] **No byte progress, cancel does not abort the transfer, no size-limit check** — fixed in 5b72c4d — `P2` — `partial` (changelog 1.9.0 "Real byte progress…cancel aborts", 1652a0ec "respect server limits")
  - What WEB does: XHR upload with `onProgress` + `AbortSignal` (`lib/jmap/client.ts:3954-3990`), chip progress bar (`email-composer.tsx:2951-2965`), `abortController.abort()` on remove (`:1605-1609`), `getMaxSizeUpload()` from the core capability (`lib/jmap/client.ts:4180-4181`; used for files at `components/files/files-app.tsx:311-336`).
  - What RN does: `uploadBlob` (`src/api/blob.ts:5-62`) reads the whole file into memory (`new File(uri).bytes()`) and `fetch`es it with no progress or signal; `AttachmentChip` shows a spinner + "Uploading..." (`ComposeScreen.tsx:174-192`); `removeAttachment` (`:553-571`) removes the chip while the upload keeps running; no `maxSizeUpload`/`maxSizeAttachmentsPerEmail` check — a 60 MB video from the picker fails only after the full upload with a raw `Upload failed: 413`.
  - Fix hint: check `session.capabilities['urn:ietf:params:jmap:core'].maxSizeUpload` (and the mail capability's `maxSizeAttachmentsPerEmail` for the running total) before starting; use `expo-file-system` `createUploadTask`/`uploadAsync` with progress callback and `cancelAsync()`, keep the handle on `AttachmentEntry`.

- [x] **Attachment chip has no preview / open** — fixed in 5b72c4d — `P3` — `missing`
  - What WEB does: click a chip to preview via `FilePreviewModal` (`email-composer.tsx:1615-1646`).
  - What RN does: chip is display-only (`ComposeScreen.tsx:164-200`).
  - Fix hint: on press open the local `uri` with `expo-sharing`/`Linking`.

### Scheduled send

- [x] **Scheduled screen: cancel only — no reschedule, no "send now", no edit** — fixed in c659b54 — `P2` — `partial` — reschedule dropped Cc and Bcc until e67947a, and a refused half of it could drop or double-send the message until 7e598c5 (audit B19)
  - What WEB does: scheduled view with send-now button (changelog 1.6.x), reschedule (`stores/email-store.ts:4353` rescheduleScheduledEmail, `lib/jmap/client.ts:7985`), cancel-for-edit that reopens the composer (`email-store.ts:4326`), listing routed to the owning account (#874).
  - What RN does: `src/screens/ScheduledScreen.tsx:51-78` offers only "Cancel send"; `src/api/email.ts:902-988` has `listScheduledEmails`/`cancelScheduledSend` only.
  - Fix hint: add `rescheduleScheduledSend(submissionId, emailId, identityId, holdFor)` = `EmailSubmission/set { update: {id: {undoStatus:'canceled'}}, create: {replacement: {emailId, identityId, envelope(HOLDFOR)}} }` and an edit path once drafts exist (cancel → open composer prefilled from the Email).

- [x] **Scheduled screen strings are hard-coded English** — fixed in c659b54 — `P3` — `rn-only-bug`
  - What RN does: `ScheduledScreen.tsx:52-56`, `:69`, `:85` (`toLocaleString()` without locale/12h setting), `:118` "Scheduled", `:20`/`:88` "(no recipient)"/"(no subject)" — no `t()` calls at all, whereas `ComposeScreen` is localized.
  - Fix hint: wrap in `useLocaleStore().t` and format with the shared date helper (`src/lib/date-format.ts`).

- [x] **Scheduled preset times ignore the user's 12/24h format** — fixed in c659b54 — `P3` — `rn-only-bug`
  - What RN does: `ComposeScreen.tsx:966-970` and `:1321-1326` use `toLocaleString(undefined, …)` / `toLocaleString()` rather than the `timeFormat` setting the quote header already respects (`compose-html.ts:37-51`).
  - Fix hint: reuse `formatQuoteDate`-style formatting with `timeFormat`.

### Templates

- [x] **No way to insert a template in the RN composer** — fixed in 5b72c4d — `P2` — `missing`
  - What WEB does: template picker + "save as template" buttons in the composer (`email-composer.tsx:3030-3049`), `t` shortcut, insertion at the caret keeping typed text and the signature (#539/#540/#621, `:1278-1373`), placeholder auto-fill (`lib/template-utils.ts:46-62`, `components/templates/placeholder-fill-modal.tsx`), default recipients / identity per template (`lib/template-types.ts:8-13`).
  - What RN does: templates can be created/edited/imported/exported in `src/components/settings/TemplateSettings.tsx` and stored in `src/stores/templates-store.ts`, but `ComposeScreen.tsx` never imports `useTemplatesStore` — the feature is unreachable from the composer.
  - Fix hint: add a toolbar button that opens a bottom sheet listing `templates`; on pick set subject if empty and `editorRef.insertHtml(escaped body)` (the `insertHtml` bridge exists in `editor-html.ts:368-373`); substitute `{{date}}`, `{{day_of_week}}`, `{{sender_name}}` via a port of `getAutoFilledPlaceholders` and prompt for the rest.

- [x] **Template model lacks isHTML, category UI, favourites, default recipients, identity; export format differs** — fixed in c659b54 — `P3` — `partial`
  - What WEB does: `lib/template-types.ts:1-17`, export envelope `{version:1,type:'webmail-templates',…}` (`lib/template-utils.ts:148-156`), import validation (`:286-351`), favourites/recent (`stores/template-store.ts`).
  - What RN does: `templates-store.ts:307-316` has name/subject/body/category/isFavorite only; `exportAll` (`:395-397`) emits `{version:1,templates}` **without** `type:'webmail-templates'`, so the web `importTemplates` rejects an RN export with `invalid_type` (`lib/template-utils.ts:302-304`); RN import (`:399-434`) accepts web exports. Category/favourite are not editable in `TemplateSettings.tsx:68-81`.
  - Fix hint: add `type: 'webmail-templates'` and `exportedAt` to `exportAll`; carry `isHTML`/`defaultRecipients`/`identityId` through import so they survive a round trip.

- [ ] **Templates not in cross-device settings sync (#825)** — `P3` — `missing` (blocked) — deferred: blocked on native settings sync (issue #1)
  - What WEB does: templates ride in the per-account settings blob with tombstone merge (`stores/template-store.ts:208-218`, `lib/template-utils.ts:163-284`).
  - What RN does: no settings sync exists at all (native issue #1 "Common settings / global settings" is open), so this is blocked on that feature.
  - Fix hint: when settings sync lands, reuse `mergeSyncedTemplates` (pure TS).

### mailto / share intents

- [x] **No `mailto:` handling / share-to-app intent** — `P2` — `missing` — composer side (prefill*, prefillAttachments upload) done in 5b72c4d; scheme, intent filters and links to Compose done in 5802cae (area 08); shared files, `SENDTO` and `+` addresses work since cd4ce9d, 06e8942, ee652d3 (audit B9–B11)
  - What WEB does: PWA `protocol_handlers` for mailto (`app/manifest.ts:118`), `parseMailtoUrl` (`lib/validation.ts:133-167`), in-app composer open through the unsaved-draft guard (`components/mail/mail-app.tsx:1110`, changelog 1.9.0).
  - What RN does: `app.config.js:29` registers only the custom `bulwarkmobile` scheme; no `intentFilters` (Android `mailto`/`SEND`) or iOS `LSApplicationQueriesSchemes`/`CFBundleURLTypes` for `mailto`; no `Linking.getInitialURL`/`addEventListener('url')` handling that routes to `Compose` (grep over `App.tsx`/`src/navigation` shows none). Tapping a mailto link in another app cannot open Bulwark; sharing a file/text to the app is impossible.
  - Fix hint: add `scheme: ['bulwarkmobile', 'mailto']` + Android `intentFilters` for `mailto` and `android.intent.action.SEND`, parse with a port of `parseMailtoUrl`, and navigate to `Compose` with `prefillTo`/subject/body (add those params); for SEND intents seed `attachments` from the shared `content://` URI (upload path already supports it, `src/api/blob.ts:17-22`).

### Security / crypto

- [ ] **S/MIME sign/encrypt on send is a stub** — `P3` — `missing` — deferred: no raw-MIME send path in RN; certificates are stored only
  - What WEB does: crypto plugins hook `onComposeSend` (`email-composer.tsx:2180-2216`) and the store has `sendRawEmail` (`stores/email-store.ts:1724`).
  - What RN does: `src/components/settings/SmimeSettings.tsx` lists imported certificates ("Your Certificates", "Recipient Certificates") but `ComposeScreen.tsx` has no sign/encrypt control (`grep -i smime|sign|encrypt` → none) and `sendEmail` has no raw-MIME path.
  - Fix hint: out of scope for parity right now; document as a known gap in the settings pane ("certificates are stored but not yet used for sending").

### Misc

- [x] **Auto-add reply recipients to trusted senders** — fixed in 5b72c4d — `P3` — `missing` (changelog 1.5.x)
  - What WEB does: after a reply, To/Cc are added to the trusted-senders list/address book (`email-composer.tsx:2283-2294`).
  - What RN does: `settings-store.ts:105-106` has `trustedSenders`, but `ComposeScreen.tsx` never touches it (`grep -i trusted` → none).
  - Fix hint: after a successful reply push `finalTo`/`finalCc` emails into `trustedSenders` (dedupe).

- [ ] **Offline send is not queued** — `P3` — `missing` (RN-only opportunity) — deferred: needs a new outbox op kind carrying the whole Email/set + submission payload; drafts now autosave to the server instead
  - What RN does: `outbox-store.ts:40-43` only knows `keywords|mailboxes|destroy` ops; `performSend` fails with a network error when offline (`ComposeScreen.tsx:975-979`) and the composed text is lost unless the user keeps the screen open. WEB has no offline outbox either, so this is not a parity item, but once drafts exist the natural mobile behaviour is "save draft locally, submit when online".
  - Fix hint: add a `send` op kind carrying the Email/set create + submission payload, flushed by `outbox-store.flush`.

- [x] **Permission / picker error strings are not localized** — fixed in 5b72c4d — `P3` — `rn-only-bug`
  - What RN does: `ComposeScreen.tsx:620-623`, `:696-699`, `:719` hard-code "Photo library permission is required…", "Could not load image"; `identityError` fallback text at `:1052` ("identity unavailable", "Loading...").
  - Fix hint: route through `t()` with keys in `locales/<lang>/common.json`.

## Verified at parity (brief list, so the fixer knows what NOT to redo)
- Scheduled send via `EmailSubmission` envelope `HOLDFOR` with explicit `rcptTo` (bare addresses, names stripped) and `maxDelayedSend`/FUTURERELEASE capability checks: `src/api/email.ts:828-844`, `src/api/jmap-client.ts:513-531`, `ComposeScreen.tsx:796-821` — matches `lib/jmap/client.ts:592-612`, `:3245-3258`. The capability check read only the session-level object, which Stalwart leaves empty, so scheduling and the undo delay were off on Stalwart until e28e8b4 (#57, audit B8); holds are capped at Stalwart's 7-day limit since 4e7ae2f.
- Undo-send delay setting (0/5/10/20/30 s) applied only when the server supports delayed send: `ComposeScreen.tsx:825-828`, `ComposingSettings.tsx:42-48`.
- Send-time readback of the live editor DOM with timeout + loud abort (RN #9/#11): `RichTextEditor.tsx:143-152`, `ComposeScreen.tsx:890-902`; escape-free page script with a parse test.
- `Name <addr>` recipients split into JMAP `name`/`email` (#672): `ComposeScreen.tsx:69-84`, `:944-947`.
- Duplicate recipients within one field rejected on blur/submit: `ComposeScreen.tsx:466-499`; suggestion list hides already-added addresses `:371-392`.
- Quote header values HTML-escaped (#482): `src/lib/compose-html.ts:88-100`.
- Inline images: data-URL placeholder in the editor, `cid:` rewrite + `disposition:'inline'` parts on send, orphaned cids not attached: `compose-html.ts:143-161`, `ComposeScreen.tsx:910-927`; removing the chip strips the `<img>`.
- Attachment reminder with word-boundary keyword match and configurable keyword list: `ComposeScreen.tsx:764-791`, `ComposingSettings.tsx:95-136`.
- Send blocked while uploads are in flight or errored (web waits instead; equivalent outcome): `ComposeScreen.tsx:502-516`.
- Body/attachment presence required to send; dirty-check close guard on the header X: `ComposeScreen.tsx:506-541`.
- Auto-select reply identity from original To/Cc + setting: `ComposeScreen.tsx:431-437`, `settings-store.ts:131`; preselect identity matching the active account (a971d5a1 / "pre-select primary sender identity"): `:426-429`.
- Identity picker bottom sheet (`src/components/IdentitySheet.tsx`), identity CRUD in settings with email immutable on edit (`IdentitySettings.tsx:263-277`).
- Guarded UUID generator (a92c852c equivalent): `src/lib/uuid.ts:6-20`.
- Pasted `<script>`/`<style>` stripped before send: `ComposeScreen.tsx:913` via `stripDangerousTags`; link insertion rejects non-http/mailto/tel schemes: `editor-html.ts:380-384`.
- Plain-text-only send (text/plain part only) when `plainTextMode`: `ComposeScreen.tsx:951`, `src/api/email.ts:798-806`.
- Blob upload tolerant of both Stalwart upload-response shapes: `src/api/blob.ts:38-61`.
- Scheduled list filters `undoStatus==='pending'` and future `sendAt`, cancel via `undoStatus:'canceled'` keeping the Sent copy: `src/api/email.ts:902-988`.
- Contact prefill from contact/group detail: `ContactDetailScreen.tsx:159`, `GroupDetailScreen.tsx:83`.

## N/A on mobile
- Ctrl/Cmd+Enter send, Ctrl+Shift+Enter schedule, `t` template shortcut, Escape close (`email-composer.tsx:2428-2468`).
- Drag-and-drop of files onto the composer and drag-to-reorder / drag-between-fields recipient chips (#593), chip drag preview.
- Pro multi-account From dropdown namespacing (44cdd083), per-pane composer tabs, tab-title logic (`lib/subject-prefix.ts:129-144` buildComposeTabTitle), "Keep the fresh-compose tab title clear".
- Composer sidebar / toolbar plugin slots and all `emailHooks.*` plugin transforms (no plugin runtime in RN).
- `beforeunload` server autosave (browser lifecycle) — replaced by the `beforeRemove` recommendation above.
- Browser `registerProtocolHandler`/PWA manifest mailto registration (replaced by OS intent filters above).
- Signature "double-click to unlock" atom (Tiptap-specific); the RN contenteditable is always editable.
- Quoted-HTML shadow-island typing detection (#654) — Tiptap/shadow-DOM specific.
- Send through another logged-in account's client for DKIM (#461) — RN is single-active-account; identities always belong to the submitting account.
- Route scheduled sends / identity on reschedule to a shared account (#874, a15af722) — RN does not compose on behalf of shared accounts, but the Scheduled screen lists, cancels, reschedules and edits sends held in shared accounts since 72f48db.
