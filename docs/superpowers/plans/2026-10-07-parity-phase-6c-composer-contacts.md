# Parity Phase 6c: Composer and Contacts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the open composer (04) and contacts (06) parity items, plus webmail's new "attach from Files" (#1179).

**Architecture:**
- Contacts work stays in the contacts store and its screens.
- Address book sharing generalises the calendar's share sheet.
- Send-path work adds plain JSON fields to `OutgoingEmail`, so the offline queue persists them with each row. Replay never re-reads composer or settings state.
- Editor work splits between the WebView page script and RN:
  - the page script handles DOM events, selection and plain-text insertion;
  - RN runs pure, tested TS (parsing, candidates) and shows the lists.

**Tech Stack:** React Native / Expo, TypeScript, Zustand, vitest, JMAP (`AddressBook/set shareWith`, `EmailSubmission/set` envelope parameters, `submissionExtensions`, `FileNode/get`).

**Spec:**
- The open items in [04-composer-send.md](../../parity/04-composer-send.md): identity refresh, DSN/REQUIRETLS, the Return-Path note, pasted lists and @-mentions.
- The open items in [06-contacts.md](../../parity/06-contacts.md): address book sharing, list filters, ParticipantInput autocomplete and contact deep links.
- The user chose this sweep on 2026-10-07.
- Webmail at `ccf6bf7` (cloned at `/tmp/webmail`) is the authority.
- Research with exact webmail and native refs: `/tmp/claude-1000/-home-waggins-projects-bulwark-native/9b59627a-d96a-4632-a107-64a9144b7f0c/scratchpad/phase-6c-research.md`. Each task names its section; read it.

## Global Constraints

- **Branch:** `parity/phase-6c-composer-contacts`, from `main` at `6156fbe`.
- **Gate on every commit:** `npm run typecheck && npm test && npm run i18n:check`.
- **Strings:** use `t('key', 'English fallback')` with webmail's key. RN-only keys go in `locales/rn/en.json` via `npm run i18n:harvest`.
- **Commits:** one per task, with the task's subject and the `Co-Authored-By:` and `Claude-Session:` trailers. Stage by explicit path, and never `git add -f` anything under `.superpowers`.
- **Parity docs:** do not edit `docs/parity/*.md` or `PARITY_CHECKLIST.md` in a task.
- **Tests:** vitest in node, with no RN render harness. Write tests first and record RED.
- **Accounts:** Stalwart ids are sequential per account and collide.
  - Every request carries its own account: `opScope`, `inAccount`, `requireShownAccountScope`, `isShownAccount`.
  - Async results are dropped if their account is no longer shown.
  - A sheet or modal that outlives a switch captures its app account when it opens and re-checks it on each action.
- **Offline send queue:** a queued message is never sent twice, never from the wrong account, and never dropped silently.
  - New send options live on `OutgoingEmail` and are read from the row at replay.
  - Old rows without them mean "off".
- **Editor:** text from recipients, clipboard or contacts is inserted as text or escaped HTML, never raw HTML.
  - Any regex inside `src/lib/editor-html.ts`'s template literal must survive the template's backslash cooking (see the file's header comment). Prefer char comparisons there.

## Review Focus

1. **A queued send with DSN, REQUIRETLS or an envelope override replays with exactly the stored envelope.** It replays once, from its own account, and REQUIRETLS is never stripped. Owned by Tasks 7 and 8.
2. **The envelope fallback retry runs only after an explicit `forbiddenMailFrom`/`forbiddenFrom` refusal of the first submission.** It runs on the same scope and with the same email copy. A timeout or transport error is never retried. Owned by Task 8.
3. **Opening `/contacts/<id>/edit` before contacts have loaded never saves a blank form over the card.** Owned by Task 5.
4. **A share sheet left open across an account switch never shares the new account's address book with the same id.** Owned by Task 6.
5. **A mention label or pasted text containing `<b>` or `<script>` lands as literal text.** Owned by Tasks 9 and 10.

## Not in this phase

- Webmail's paragraph-per-line rule for ordinary plain-text paste. Only pastes that contain a list are converted.
- Enter/Tab to pick a mention. Android soft keyboards report keyCode 229, so the list is tap-only.
- Address book subscription or visibility. Webmail has none.
- Sending from shared or group accounts, and S/MIME (roadmap Phase 5).

---

### Task 1: Re-vendor the webmail locale catalogs

**Files:**
- Modify: `scripts/sync-locales.mjs`. Accept a source directory from `--from <dir>` or `WEBMAIL_LOCALES`, falling back to today's path.
- Modify: `locales/*/common.json`, by running the script with `--from /tmp/webmail/locales`.
- Modify: `locales/rn/*.json`. Drop overlay keys that webmail now has, as the script reports.

**Interfaces:**
- Produces: the catalogs at webmail `ccf6bf7`. That includes `email_composer.mention_recipients`, `settings.email_behavior.recipient_mentions.*`, `email_composer.attach_from_files` and `email_composer.files_picker.*`.

- [ ] **Step 1:** Add the `--from` option. `node scripts/sync-locales.mjs --check --from /tmp/webmail/locales` lists about 185 missing en keys.
- [ ] **Step 2:** Run the sync. Trim the overlay keys it reports.
- [ ] **Step 3:** Run the gate. Fix any `keys.test.ts` or i18n failure caused by a renamed webmail key, by updating the native call site to the new key.
- [ ] **Step 4:** Commit `chore: vendor the webmail locale catalogs at ccf6bf7`.

### Task 2: Refresh identities on foreground and every 30 minutes

Research section 5.

**Files:**
- Modify: `src/stores/settings-store.ts`: add `refreshIdentities(): Promise<void>`.
- Modify: `App.tsx`: call it from `refreshAfterResume`, and from an interval in the live-updates effect.
- Test: `src/stores/__tests__/settings-store-identities.test.ts`.

**Interfaces:**
- `refreshIdentities()` calls `fetchIdentities()` only when `identitiesFor === identityScope()`. It swallows errors, leaves `error` unchanged, and keeps the old list.
- `IDENTITY_SYNC_INTERVAL_MS = 30 * 60 * 1000`.

- [ ] **Step 1:** Write the failing tests:
  - it refetches when the list is held for the current scope;
  - it does nothing when identities were never loaded;
  - it drops the result after a scope change;
  - it keeps the old list on error.
- [ ] **Step 2:** Run them to verify they fail.
- [ ] **Step 3:** Implement. The interval is cleared in the effect's cleanup, which also runs on account switch.
- [ ] **Step 4:** Run them to verify they pass.
- [ ] **Step 5:** Commit `feat: refresh sender identities when the app returns and every 30 minutes`.

### Task 3: Event guests get the composer's suggestions

Research section 3.

**Files:**
- Modify: `src/components/calendar/ParticipantInput.tsx`.
- Create: `src/lib/calendar-participants.ts` with `participantSuggestions(all: RecipientSuggestion[], existing: ReadonlySet<string>, limit = 8): RecipientSuggestion[]`.
- Test: `src/lib/__tests__/calendar-participants.test.ts`.

**Interfaces:**
- Consumes `getAutocomplete(query, 16)`, `loadRecentRecipients(sentId)`, `loadDirectory()` and `getGroupRecipients(groupId)` from the contacts store.

- [ ] **Step 1:** Write the failing tests:
  - existing participants are excluded, case-insensitively;
  - the list is capped at 8;
  - a query under 2 characters gives no suggestions;
  - groups are kept;
  - a group pick expands to its members, minus any already added. This expansion is a deliberate divergence: webmail can't pick a group at all.
- [ ] **Step 2:** Run them to verify they fail.
- [ ] **Step 3:** Implement in ParticipantInput:
  - subscribe to the store's contacts, recent and directory versions instead of the one-off snapshot;
  - load recent recipients from the own account's Sent folder;
  - when `availabilityAccount` is not the shown account (`isShownAccount`), show no suggestions;
  - placeholder `calendar.participants.email_placeholder`.
- [ ] **Step 4:** Run them to verify they pass.
- [ ] **Step 5:** Commit `feat: suggest contacts, groups, directory people and recent recipients for event guests`.

### Task 4: Contact list filters

Research section 2.

**Files:**
- Create: `src/lib/contact-filters.ts`, with `ContactListFilters`, `TriState = boolean | null`, `EMPTY_CONTACT_FILTERS`, `cycleTri`, `countActiveFilters` and `matchesContactFilters(card, filters)`. It ports WEB `components/contacts/contact-list.tsx:16-221` without the text search.
- Create: `src/components/contacts/ContactFilterSheet.tsx`, containing:
  - four text fields;
  - month chips named with `Intl.DateTimeFormat(locale, {month:'long'})`;
  - three tri-state chips;
  - a sort-by first/last row bound to `sortContactsByLastName`;
  - Clear and Close.
- Modify: `src/screens/ContactsScreen.tsx`. Add a header filter button with an active-count badge. The visible list is search ∧ filters. Filters reset when `activeAccountId` changes.
- Test: `src/lib/__tests__/contact-filters.test.ts`. Add the sheet to `contacts-i18n.test.ts`.

**Interfaces:** keys `contacts.filters.*`, which are already vendored.

- [ ] **Step 1:** Write the failing tests:
  - each text field, including organisation units and every address part;
  - the email domain with and without `@`;
  - birthday month from an ISO date, from `--MM-DD` and from a PartialDate;
  - each tri-state in both polarities;
  - `cycleTri` going null → true → false → null;
  - the count.
- [ ] **Step 2:** Run them to verify they fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run them to verify they pass.
- [ ] **Step 5:** Commit `feat: filter the contact list by organisation, title, place, domain, birthday month and details`.

### Task 5: Contact deep links for new and edit, and no blank edit form

Research section 4.

**Files:**
- Modify: `src/navigation/linking.ts`. Port WEB `parseContactsPath` (`lib/deep-links.ts:364-418`), including the legacy query forms and `?account=`.
- Modify: `src/navigation/types.ts`: `ContactForm.prefill?: { email?: string; name?: string }`.
- Modify: `src/screens/ContactFormScreen.tsx`.
- Create: `src/lib/contact-form-seed.ts`, with `canSaveContactForm({ isEdit, existing }): boolean` and `contactFormSeed(existing, prefill, …)`.
- Test: `src/navigation/__tests__/linking.test.ts` and `src/lib/__tests__/contact-form-seed.test.ts`.

**Interfaces:**
- DeepLink gains:
  - `{ kind: 'contact'; contactId; edit?: boolean; accountId? }`
  - `{ kind: 'contactNew'; email?; name?; accountId? }`
- Edit navigates to `ContactDetail` and then `ContactForm`, so Back lands on the detail screen.

- [ ] **Step 1:** Write the failing tests for these links:
  - `/contacts/new`
  - `/contacts/new?email=a@b&name=A%20B`
  - `?addEmail=`
  - `/contacts/C9/edit`
  - `?contactId=C9&view=edit`
  - a locale prefix
  - `?account=`

  Also test:
  - `handleDeepLink` with a fake navigation;
  - `canSaveContactForm({ isEdit: true, existing: undefined })` is false;
  - the seed handles a name-only prefill.
- [ ] **Step 2:** Run them to verify they fail.
- [ ] **Step 3:** Implement. In edit mode, ContactForm:
  - shows a loading state until the card is in the store, then `contacts.detail.not_found` once contacts have loaded, and never shows Save without the card;
  - seeds the form when the card first arrives, if the user hasn't typed;
  - never falls through to `createContact`;
  - captures the app account at mount and refuses to save if another account is shown.
- [ ] **Step 4:** Run them to verify they pass.
- [ ] **Step 5:** Commit `feat: open new and edit contact links, and never save an edit form before its contact loads`.

### Task 6: Share an address book

Research section 1.

**Files:**
- Create: `src/lib/share-presets.ts`:
  - `ShareKind = 'calendar' | 'addressBook'`;
  - `CALENDAR_PRESETS`, moved from the sheet unchanged;
  - `ADDRESS_BOOK_PRESETS`, with WEB `share-collection-dialog.tsx:36-40` values;
  - `presetOrder(kind)`;
  - `detectPreset(kind, rights)`, where a missing key counts as false and anything else is `'custom'`.
- Create: `src/components/ShareCollectionSheet.tsx`, generalised from `CalendarShareSheet`. `CalendarShareSheet` becomes a thin `kind="calendar"` wrapper, so CalendarScreen is unchanged.
- Modify: `src/api/contacts.ts`: `setAddressBookShare(addressBookId, principalId, rights | null, at: OpScope): Promise<void>`. It sends `AddressBook/set shareWith/<principal>` with `{ gen: at.gen }`, and throws on `notUpdated` or a missing `updated[id]`.
- Modify: `src/stores/contacts-store.ts`: `shareAddressBook(id, principalId, rights | null, owner: { appAccountId })`. It refuses shared books and patches `shareWith` locally only while the owner is shown.
- Modify: `src/components/settings/ContactsSettings.tsx`. Add a Share action on own books with `myRights.mayShare` when the principals capability is present.
- Modify: `src/components/contacts/ContactsSidebarDrawer.tsx`. Add a shared indicator on own books with a non-empty `shareWith`.
- Test: `src/lib/__tests__/share-presets.test.ts`, `src/api/__tests__/contacts.test.ts`, `src/stores/__tests__/contacts-store.test.ts`, and the i18n lists.

**Interfaces:**
- The sheet captures the app account when it opens and passes it to every `onShare`.
- The principal list is dropped if it lands after a switch.
- Keys: `sharing.*` and `contacts.address_books.share`, all vendored.

- [ ] **Step 1:** Write the failing tests:
  - the calendar presets are unchanged;
  - the address book presets equal webmail's;
  - `detectPreset` covers each preset and `'custom'`;
  - the API patch shape, revoke with null, both throw paths, and that `gen` is carried;
  - the store refuses when another account is shown;
  - the store makes no local write after a switch mid-request;
  - the store refuses shared books.
- [ ] **Step 2:** Run them to verify they fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run them to verify they pass.
- [ ] **Step 5:** Commit `feat: share an address book with people on the server`.

### Task 7: Delivery notifications and REQUIRETLS

Research section 6 and "Composer send path today".

**Files:**
- Modify: `src/api/jmap-client.ts`:
  - `export function hasSubmissionExtension(ext: unknown, name: string): boolean`. It is case-insensitive, and accepts either an array or an object whose value is neither `false` nor null.
  - `supportsSubmissionExtension(name, accountId?)`.
  - `hasDelayedSend` moves onto it, which also fixes the array form.
- Modify: `src/api/email.ts`:
  - `OutgoingEmail` gains `requestDsn?: boolean` and `requireTls?: boolean`.
  - Export `submissionEnvelopeParameters(opts, holdForSeconds?)` with webmail's values: `HOLDFOR`, `REQUIRETLS: null`, `RET: 'HDRS'`, and `NOTIFY: 'SUCCESS,FAILURE,DELAY'` on each rcpt.
  - `sendEmail` builds the envelope when holding, overriding, or when either option is set.
- Modify: `src/screens/ComposeScreen.tsx`. Add two toolbar toggles, `PackageCheck` and `LockKeyhole`. Each shows only when the **owner's** JMAP account supports the extension. They feed `buildOutgoing` for sends only, never drafts. The two existing `hasDelayedSend()` calls take the owner's account.
- Test: `src/api/__tests__/email-submission.test.ts`, `src/api/__tests__/jmap-client.test.ts`, and the send-queue replay tests.

**Interfaces:** keys `email_composer.dsn_on|dsn_off|require_tls_on|require_tls_off`, vendored. Use them as the accessibility label.

- [ ] **Step 1:** Write the failing tests:
  - no options and no hold gives the request body unchanged from today;
  - DSN sets `RET` and `NOTIFY` on every bare-address rcpt;
  - TLS sets `REQUIRETLS: null`;
  - each combines with HOLDFOR;
  - the extension matcher handles the array form, the object form, `false` and null values, and letter case;
  - a queued row with `requireTls` replays with the same envelope, even when the capability has since vanished;
  - an old row without the fields replays without them.
- [ ] **Step 2:** Run them to verify they fail.
- [ ] **Step 3:** Implement. Replay never strips REQUIRETLS: a server refusal becomes `failed`.
- [ ] **Step 4:** Run them to verify they pass.
- [ ] **Step 5:** Commit `feat: ask for delivery notifications or require TLS when the server offers them`.

### Task 8: Send as the From override, with the identity as fallback (#1009)

Research section 7. This task depends on Task 7, because both edit `sendEmail` and the envelope.

**Files:**
- Modify: `src/api/email.ts`.
  - `envelopeMailFrom` now means the requested MAIL FROM.
  - Add `envelopeFallbackMailFrom?: string`.
  - Factor the response parse into `parseSendResponse`.
  - Add a single retry, described in Step 3.
- Create: `src/lib/envelope-sender.ts`:
  - `pickSubmissionIdentity(identities, selected, overrideEmail): Identity`, which prefers the identity that owns the override address;
  - `envelopeFallbackIdentity(identities, selected, overrideEmail): string | null`.
- Modify: `src/screens/ComposeScreen.tsx`.
  - `senderAddress` sends the override as MAIL FROM, with the identity address as fallback. A sub-address keeps today's behaviour.
  - The picked identity's id goes to both `sendEmail` and `buildQueuedSend`.
  - Render `email_composer.from_override.envelope_notice` under the From row, and drop the custom tooltip text.
- Test: `src/api/__tests__/email-submission.test.ts`, `src/lib/__tests__/envelope-sender.test.ts`, and the replay tests.

- [ ] **Step 1:** Write the failing tests:
  - the override is requested as MAIL FROM;
  - `forbiddenFrom` makes one more request on the same `gen`, with the same email id and the identity MAIL FROM. HOLDFOR, DSN and TLS are kept, and it succeeds;
  - a refusal of the retry destroys the copy and throws `SendRefusedError`;
  - any other refusal type is not retried;
  - a legacy row with no fallback is not retried;
  - a transport error or timeout on the first request is not retried;
  - the pure helpers;
  - a queued override entry keeps both fields and its identity id.
- [ ] **Step 2:** Run them to verify they fail.
- [ ] **Step 3:** Implement. The retry reuses the first request's `at`, and runs only after an explicit `notCreated` with a known created copy.
- [ ] **Step 4:** Run them to verify they pass.
- [ ] **Step 5:** Commit `feat: send as the From override, falling back to the identity address`.

### Task 9: Pasted plain-text lists become lists

Research section 8, using the round-trip design.

**Files:**
- Create: `src/lib/plain-text-paste.ts`, with `plainTextPasteHtml(text: string): string | null`. It ports WEB `components/email/plain-text-paste.ts`:
  - markers `- `, `* `, `• `, `1. ` and `1) `;
  - the start number is kept;
  - nesting by indent, with a tab counted as 4 columns;
  - lazy continuation lines;
  - blank lines between items are dropped;
  - a change of type or indent ends a list.

  The output is `<ul>`/`<ol start>` with other lines as the editor's block element, and all text is HTML-escaped. It returns null when there is no list.
- Modify: `src/lib/editor-html.ts`. Add a `paste` listener:
  - with `text/html` on the clipboard, the browser's default paste runs;
  - otherwise, if any line starts with a marker (checked with char comparisons, no regex), save the range, call `preventDefault()` and `post('pastePlain', text)`.

  Also add `__rne.insertPasted(html | null, text)`: it restores the saved range, then inserts the HTML, or the plain text through `insertText`.
- Modify: `src/components/RichTextEditor.tsx`: handle `pastePlain` by calling `plainTextPasteHtml` and then `insertPasted`.
- Test: `src/lib/__tests__/plain-text-paste.test.ts` (ports webmail's cases plus `<script>` escaping) and `src/lib/__tests__/editor-html.test.ts` (a fake `clipboardData` for each of the three paths; the script still parses).

- [ ] **Step 1:** Write the failing tests.
- [ ] **Step 2:** Run them to verify they fail.
- [ ] **Step 3:** Implement. Add a 200 KB timing test for the parser, with a 1000 ms ceiling.
- [ ] **Step 4:** Run them to verify they pass.
- [ ] **Step 5:** Commit `feat: turn a pasted plain-text list into a real list`.

### Task 10: Mention a recipient with @

Research section 9. This task depends on Task 9, because both edit the editor bridge.

**Files:**
- Create: `src/lib/recipient-mentions.ts`, porting WEB `lib/recipient-mentions.ts`: `mentionLabel`, `buildMentionCandidates(to, cc)` (Bcc excluded, groups expanded) and `filterMentionCandidates`.
- Modify: `src/lib/editor-html.ts`.
  - Detect `@` at a word start: at the start of the node, or after a space or NBSP, with no whitespace up to the caret, and not inside pre, code or a link. Post `mention {query}`, or post `null` when it ends or on blur.
  - `__rne.insertMention(label)` re-validates the `@query` run, replaces it with **text**, adds a trailing space unless one follows, moves the caret, and reports the change.
- Modify: `src/components/RichTextEditor.tsx`: an `onMention` prop and an `insertMention(label)` handle.
- Modify: `src/screens/ComposeScreen.tsx`.
  - A tap-only candidate list (`@label · name · email`) sits above the format bar, labelled `email_composer.mention_recipients`.
  - It shows only when the setting is on, the rich editor is in use, and there are matches.
- Modify: `src/stores/settings-store.ts`: `recipientMentionsEnabled`, default true, persisted and validated.
- Modify: `src/components/settings/ComposingSettings.tsx`: a toggle using `settings.email_behavior.recipient_mentions.label`. For the description, use an RN-only key that doesn't promise Enter or Tab.
- Test: `src/lib/__tests__/recipient-mentions.test.ts` (port webmail's suite) and `src/lib/__tests__/editor-html.test.ts` (fake DOM):
  - an `@` after a space posts the query;
  - `info@x` posts nothing;
  - `insertMention` writes `<b>` as literal text and posts a change;
  - blur posts null.
  - Add the new strings to the i18n lists.

- [ ] **Step 1:** Write the failing tests.
- [ ] **Step 2:** Run them to verify they fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run them to verify they pass.
- [ ] **Step 5:** Commit `feat: mention a recipient by typing @`.

### Task 11: Attach files from the Files app (#1179)

Reference: webmail `92f1973b`. Read `components/files/file-picker-dialog.tsx` and the composer and `lib/jmap/client.ts` hunks.

**Files:**
- Create: `src/components/files/FilePickerSheet.tsx`, a folder-browsing, multi-select picker over the shown account's file listing (Task 9 of 6b, `getFileListing`).
- Modify: `src/screens/ComposeScreen.tsx`: add an "Attach from Files" entry next to the existing attach action.
- Modify: `src/api/files.ts`, adding whatever webmail's client hunk adds for turning a FileNode into an attachment.
  - Reuse the node's blob in the **same JMAP account** as the submission.
  - The picker lists only the owner's own files. A shared node from another account is shown disabled, so it can't be attached. Never reference another account's blob id.
- Test: a pure test for node selection to attachment (blobId, name, type, size, and the account check), plus the i18n lists.

**Interfaces:** keys `email_composer.attach_from_files` and `email_composer.files_picker.*` (vendored by Task 1).

- [ ] **Step 1:** Write the failing tests: same-account nodes become attachments; a node from another account is refused; folders can't be attached.
- [ ] **Step 2:** Run them to verify they fail.
- [ ] **Step 3:** Implement. The picker captures the composer owner's account and drops a listing that lands after a switch.
- [ ] **Step 4:** Run them to verify they pass.
- [ ] **Step 5:** Commit `feat: attach files from the Files app`. After the final review, tick the parity items in one `docs:` commit, and add an 04 entry for #1179.
