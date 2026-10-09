# Follow-up Cleanup 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the buildable follow-ups parked at the end of phases 6e and 7:
- the sender check pins the receiving server's authserv-id and aligns domains by the public suffix list;
- flagged senders are never auto-trusted, and a forged trusted address loads nothing;
- the font size setting reaches every screen, with the OS scale capped on body text;
- account, send-queue, calendar, notice, drawer, settings and tooling fixes from the two ledgers.

**Architecture:**
- Everything is JS-only except a `patch-package` patch to react-native's `Text` and `TextInput` (Task 9). No native module, no rebuild beyond the device checks.
- Each decision goes in a pure module under `src/lib` and is tested in node. Components only pass values in.
- Per-account device state stays keyed by the app account id. A write is refused once the account it was taken for is no longer shown.

**Tech Stack:** React Native / Expo SDK 54 (RN 0.81.5, React 19.1, Hermes; `android/` committed), TypeScript, Zustand, AsyncStorage, vitest, `patch-package` 8, and `tldts` ^7.4 (new in Task 1, MIT).

**Spec:**
- The item list: the "Phase 6e follow-ups" and "Phase 7 follow-ups" sections of `docs/superpowers/plans/2026-10-04-webmail-parity-roadmap.md` (:540-636), their "Follow-ups parked" and "Left open" lists.
- House rules: `.superpowers/sdd/2026-10-09-cleanup-follow-ups-1/common.md` (copied into Global Constraints below).
- Webmail at `/tmp/webmail` (1.13.0, read-only) where parity matters (expandedTags, the share toaster).
- User decisions, 2026-10-09 (binding):
  1. **Font size.** Convert the inline `fontSize` literals so the app setting applies everywhere (48 literals in 29 files under `src` and `App.tsx`; the Android home-screen widgets in `src/widgets` are RemoteViews outside the app's setting and stay as they are). Cap the OS font scale on body text at about 1.5× (`maxFontSizeMultiplier`); fixed chrome keeps `CHROME_MAX_FONT_SCALE`. A guard test stops new literals.
  2. **authserv-id pinning.** An Authentication-Results header counts for the sender check and invitation trust only when its authserv-id equals, or is a subdomain of, the JMAP server's host or that host's registrable domain. Otherwise the message has no results, and is never trusted. Pure: the expected host is passed in.
  3. **Flagged senders.** Replying and calendar RSVP never auto-trust a sender whose message failed or couldn't be verified. A trusted address loads remote content only when `getSenderVerification` returns null for the message.
  - Everything else buildable is in; device checks, upstream requests, sidebar apps' inline mode, the shared-account calendar rename gate against Stalwart and the 8 blocked parity items stay out (listed in Task 10).

## Global Constraints

- **Branch:** `cleanup/follow-ups-1`, from `main` at `afcf7b3`.
- **Gate before any commit:** `npm run typecheck && npm test && npm run i18n:check`. Check the exit status; never pipe the gate through `tail` in a way that hides a failure.
- **Node 20:** CI runs Node 20. For any test that touches Intl, dates or email headers, also run `PATH=~/.nvm/versions/node/v20.20.2/bin:$PATH npx vitest run <file>`.
- **Staging:** stage by explicit path only. Never `git add -A` or `git add .`, and never `git add -f` anything under `.superpowers`.
- **Forbidden git commands:** never `git stash`, `git reset` or `git checkout -- <file>`. Other implementers' work may be in the tree.
- **Check each commit:** after it, run `git show --stat HEAD` and confirm it holds only your files. Report hashes from `git log -1 --format=%h`.
- **Commit messages:** lower-case conventional (`feat:`, `fix:`), saying what the user gets. One commit per task. End each message with:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01AdqB9PokeySGSsJ92sqngP`
- **Account safety:** JMAP ids collide across accounts and servers.
  - Every per-account stored key, cache entry or parked target is keyed by the **app account id**. Nothing ever resolves against another account's data.
  - Use the existing helpers: `opScope`/`inAccount`, `requireShownAccountScope`/`isShownAccount`, `clientServesAccount`, `jmapClient.request(…, {gen})`, `StaleLoadError`/`isStaleLoad`, and `jmapClient.connectedAccountId`.
- **Text from other people:** sender- or other-user-written text shown inline goes through `plainDisplayText` (`src/lib/display-text.ts`). Write escapes like `' '` literally in source; never paste the invisible character.
- **Strings:** every user-visible string goes through `t('key', 'English fallback')`. Reuse webmail's key where its English fits. RN-only keys go under an RN namespace in `locales/rn/*.json`, through `npm run i18n:harvest`.
- **Code:** match the surrounding comment density and style; comments say why. Regexes over sender- or server-controlled text are linear, with the input length capped.
- **Device-sync purity:** `src/device-sync` and the pure libs it imports must not import any store (`purity.test.ts`). `src/lib/registrable-domain.ts` and `src/lib/authserv.ts` stay pure.
- **Native:** `android/` is hand-edited. Never run `expo prebuild --clean`.
- **TDD:** write the failing test first, run it, and record that it fails. vitest runs in node with no RN render harness, so component decisions go in pure helpers.
- **Scope:** don't dispatch subagents, don't contact the user's real mail server or write to it, and don't edit files outside your task's list without a reason you note in your report.
- **Docs:** only Task 10 edits the roadmap, `CHANGES.md` and `README.md`.
- **Shared files:** tasks whose Files blocks name the same file must not run at the same time. Run them in number order. Hot spots:
  - `package.json`, `package-lock.json` (Tasks 1, 8);
  - `src/lib/email-headers.ts` (Tasks 1, 2);
  - `src/lib/calendar-invitation.ts`, `src/components/email/CalendarInvitationBanner.tsx` (Task 2 only);
  - `src/components/email/MessageContent.tsx` (Tasks 2, 3);
  - `src/components/email/MessageHeader.tsx` (Tasks 2, 9);
  - `src/stores/send-queue-store.ts`, `src/lib/send-queue-replay.ts` (Tasks 3, 4);
  - `src/stores/auth-store.ts` (Tasks 4, 6);
  - `src/stores/settings-store.ts` (Task 8 only);
  - `src/components/SidebarDrawer.tsx`, `src/screens/SettingsScreen.tsx`, `src/components/settings/FilterSettings.tsx` (Tasks 7, 9);
  - `src/components/settings/FolderSettings.tsx` (Tasks 8, 9);
  - `src/screens/EmailListScreen.tsx`, `src/components/calendar/MonthView.tsx`, `src/components/calendar/EventBlock.tsx` (Task 9 only);
  - `src/screens/CalendarScreen.tsx` (Task 5 only);
  - `locales/rn/*.json` (every task that harvests a key: 6).

## Review Focus

1. **A message the receiving server never stamped, carrying only sender-written Authentication-Results, shows no verdict and vouches for nothing.** It gets no sender banner, an invitation reads "could not be verified", and a counter-proposal's Apply stays held. That includes a forged header naming another domain as its authserv-id and passing everything. Owned by Task 2.
2. **A server reached by IP, `localhost` or a single-label host still pins.** Only an exact authserv-id match counts there, and nothing throws inside the public suffix lookup. Owned by Tasks 1 and 2.
3. **A held send re-stamped onto the live primary account never writes a stale id there.** Its draft id and the replied-to message ids are dropped, and an entry with attachments or a non-matching identity stays held. A flush that an account switch overtakes re-stamps nothing. Owned by Task 4.
4. **A folder picked by hand while a cold-start link waits stays open, and a link for account A never opens on account B.** Owned by Task 7.
5. **With the Large setting and a 2× OS font, body text grows by at most 1.5× from the OS.** A nested `Text` inside a chrome-capped `Text` never gets the looser body cap. Owned by Task 9.

## Not in this plan

- **Device checks:** SSO sign-out against Keycloak, `FLAG_SECURE` and recents on Android 13+, font size Large with a large OS font, the Mail unread count with TalkBack, Hermes Intl `calendar: 'gregory'` and `\p{Nd}`, the DateTimePicker with `timeZoneName`, sidebar apps in a Custom Tab, folder links on a cold start, the live folder move, the icon picker and tag dots, the share sheet (iOS path included), Jalali labels in `fa`, RTL on a phone, counter-proposal Apply against a real attendee, and the month back arrow.
- **Upstream requests:** the `/api/admin/policy` blanks for bearer clients, Stalwart's missing `end_session_endpoint`, webmail's any-domain pass, the counter-proposal checks, the stored-event trust anchor, UID reuse, and Stalwart's read-only share readback.
- **Sidebar apps' inline mode**, the **shared-account calendar rename gate** against Stalwart (needs a server), and the **8 blocked parity items**.
- **The orphaned RN key** `settings.account.shared_accounts.description_manage`: already gone from every overlay in c9e033d. Task 10 records that.

---

### Task 1: Align domains by the public suffix list

Size **S**.

**Files:**
- Modify: `package.json`, `package-lock.json`. Run `npm install tldts@^7.4.18` (MIT, pure JS, no Node built-ins; Hermes-safe).
- Create: `src/lib/registrable-domain.ts`.
- Create: `src/lib/__tests__/registrable-domain.test.ts`.
- Modify: `src/lib/email-headers.ts:220-232` (`domainsAlign`, `hasAlignedDkimPass`).
- Test: `src/lib/__tests__/sender-check.test.ts`.
- Shares: `package.json` (Task 8), `email-headers.ts` (Task 2).

**Interfaces:**
- Produces:
  - `registrableDomain(host: string): string | null`, in `registrable-domain.ts`. It is tldts `getDomain(host, { allowPrivateDomains: true })`, lowercased, with a trailing dot dropped. It is null for an IP, a single label, a bare public suffix or an input over 253 characters. Private suffixes count, so `alice.github.io` and `bob.github.io` are two domains.
  - `domainsAlign(a: string, b: string): boolean`, moved from `email-headers.ts` and exported from `registrable-domain.ts`. True when `a === b`, or when both have a registrable domain and the two are equal (DMARC relaxed alignment). `email-headers.ts` imports it.

- [ ] **Step 1: Write the failing tests.**

```ts
it('finds the registrable domain under ICANN and private suffixes', () => {
  expect(registrableDomain('mx1.mail.example.com')).toBe('example.com');
  expect(registrableDomain('Mail.Example.CO.UK.')).toBe('example.co.uk');
  expect(registrableDomain('alice.github.io')).toBe('alice.github.io');
  for (const h of ['co.uk', '192.0.2.1', 'localhost', 'mx', 'a'.repeat(254)]) expect(registrableDomain(h)).toBeNull();
});
it('aligns siblings under one registrable domain, never across a shared suffix', () => {
  expect(domainsAlign('news.bank.example', 'mailer.bank.example')).toBe(true);
  expect(domainsAlign('bank.example', 'bank.example')).toBe(true);
  expect(domainsAlign('alice.github.io', 'bob.github.io')).toBe(false);
  expect(domainsAlign('evil.co.uk', 'bank.co.uk')).toBe(false);
  expect(domainsAlign('mx', 'mx')).toBe(true);
});
// sender-check.test.ts
it('counts a DKIM pass for a sibling subdomain of the From domain', () => {
  // 'mx; dkim=pass header.d=mailer.bank.example', From news.bank.example
  expect(getSenderVerification(auth, 'ceo@news.bank.example')).toBeNull();
});
it('does not count a pass for another tenant of a shared suffix', () => {
  // 'mx; dkim=pass header.d=evil.github.io', From alice.github.io
  expect(getSenderVerification(auth, 'a@alice.github.io')?.status).toBe('unverified');
});
```

- [ ] **Step 2: Run them and confirm they fail.** Run `npx vitest run src/lib/__tests__/registrable-domain.test.ts src/lib/__tests__/sender-check.test.ts`. Expected: FAIL; the module is missing and siblings don't align yet.
- [ ] **Step 3: Install `tldts` and implement `registrable-domain.ts`.** Point the comments at `isFromDomainAuthenticated` and `getSenderVerification` (`email-headers.ts:180-218`) at relaxed alignment by registrable domain (it replaces the 2026-10-08 parent/subdomain rule). Note the bundle size `npm ls tldts` reports in your report.
- [ ] **Step 4: Run the gate, and the two files on Node 20.** Expected: PASS. Every existing sender-check and calendar-invitation test still passes.
- [ ] **Step 5: Commit** `fix: tell sibling subdomains from strangers on a shared suffix when checking a sender`.

### Task 2: Trust only the receiving server's Authentication-Results

Size **M**. Decision 2.

**Files:**
- Create: `src/lib/authserv.ts` (pure).
- Create: `src/lib/authserv-host.ts` (reads the account store, for components).
- Create: `src/lib/__tests__/authserv.test.ts`.
- Modify: `src/lib/email-headers.ts:518-550` (`deriveHeaderInfo`).
- Modify: `src/lib/calendar-invitation.ts`:
  - `getEmailAuthenticationResults` (`:458`);
  - `InvitationTrustContext` (`:505`);
  - `getInvitationTrustAssessment` (`:544`);
  - `proposerHold` (`:986`);
  - `reviewCounterProposal` (`:1017`).
- Modify: `src/components/email/MessageContent.tsx:74`, `src/components/email/MessageHeader.tsx:106`, `src/components/email/CalendarInvitationBanner.tsx` (`:340`, `:402`, `:472`).
- Test: `src/lib/__tests__/email-headers.test.ts`, `sender-check.test.ts`, `calendar-invitation.test.ts`.
- Shares: `email-headers.ts` (Task 1), `MessageContent.tsx` (Task 3), `MessageHeader.tsx` (Task 9).

**Interfaces:**
- Consumes: `registrableDomain` (Task 1).
- Produces:
  - In `authserv.ts`:
    - `serverHostOf(serverUrl: string | null | undefined): string | null`. The host of an `http(s)://` URL, lowercased, with no port, brackets or trailing dot. Null otherwise.
    - `authservIdOf(header: string): string | null`. The first token before the first `;` outside comments and quotes, through `email-headers`' existing `splitResinfo` rules (export it as `splitAuthResinfo`), lowercased, with the trailing dot dropped. Cap the header at 16 KiB.
    - `isTrustedAuthservId(authservId: string, serverHost: string): boolean`. True when the id equals, or ends in `.` plus, `serverHost` or `registrableDomain(serverHost)`.
    - `pinAuthenticationResults(headers: readonly string[], serverHost: string | null | undefined): string[]`. The headers from the topmost trusted one down, in message order, so `parseAuthenticationResults` still treats lower ones as foreign. `[]` when none is trusted or the host is unknown.
  - `deriveHeaderInfo(email, serverHost: string | null | undefined): EmailHeaderInfo`. The second parameter is required. It parses `pinAuthenticationResults(values, serverHost)`, and `auth` is undefined when that is empty. `parseAuthenticationResults` keeps its signature and stays the raw parser.
  - `getEmailAuthenticationResults(email, serverHost: string | null | undefined): AuthenticationResults | null`, pinned the same way.
  - `InvitationTrustContext.serverHost?: string | null`. `getInvitationTrustAssessment` passes it on. `reviewCounterProposal`'s args gain `serverHost: string | null`, which `proposerHold` uses for both of its auth reads.
  - In `authserv-host.ts`: `useAuthservHost(appAccountId: string | undefined): string | null` and `authservHostFor(appAccountId: string | undefined): string | null`. Both are `serverHostOf` of the account registry entry's `serverUrl`, or null.
  - `MessageHeader`'s `headerInfo` prop becomes required (its only caller, `MessageContent`, passes it), so it never derives unpinned results itself.

- [ ] **Step 1: Write the failing tests** in `authserv.test.ts`, and add pinned cases to the three existing files.

```ts
it('reads the authserv-id, dropping a version, comments and the trailing dot', () => {
  expect(authservIdOf('MX.Example.com 1; spf=pass')).toBe('mx.example.com');
  expect(authservIdOf('(by us) mx.example.com.; dkim=pass')).toBe('mx.example.com');
  expect(authservIdOf('; spf=pass')).toBeNull();
});
it('trusts the server host, its registrable domain and their subdomains only', () => {
  expect(isTrustedAuthservId('mx1.example.com', 'jmap.example.com')).toBe(true);
  expect(isTrustedAuthservId('example.com', 'jmap.example.com')).toBe(true);
  expect(isTrustedAuthservId('example.com.evil.example', 'jmap.example.com')).toBe(false);
  expect(isTrustedAuthservId('mx.other.co.uk', 'mail.example.co.uk')).toBe(false);
  expect(isTrustedAuthservId('192.0.2.1', '192.0.2.1')).toBe(true);
  expect(isTrustedAuthservId('evil.192.0.2.1', '10.0.0.1')).toBe(false);
});
it('keeps the topmost trusted header and the ones below it', () => {
  expect(pinAuthenticationResults(['evil.example; dkim=pass', 'mx.example.com; dkim=fail', 'x; spf=fail'], 'jmap.example.com'))
    .toEqual(['mx.example.com; dkim=fail', 'x; spf=fail']);
  expect(pinAuthenticationResults(['evil.example; dmarc=pass'], 'jmap.example.com')).toEqual([]);
  expect(pinAuthenticationResults(['mx.example.com; dmarc=pass'], null)).toEqual([]);
});
it('takes the host from a server URL', () => {
  expect(serverHostOf('https://Mail.Example.com:8443/jmap')).toBe('mail.example.com');
  expect(serverHostOf('https://[2001:db8::1]/')).toBe('2001:db8::1');
  expect(serverHostOf('mail.example.com')).toBeNull();
});
// email-headers.test.ts
it('gives no results for a pass under an authserv-id the server does not own', () => {
  const info = deriveHeaderInfo({ headers: ar('evil.example; dmarc=pass header.from=bank.example'), messageId: null, from: [{ email: 'ceo@bank.example' }] }, 'jmap.example.com');
  expect(info.auth).toBeUndefined();
  expect(info.senderVerification).toBeNull();
});
// calendar-invitation.test.ts
it('never verifies an invitation whose only pass is under a foreign authserv-id', () => {
  expect(getInvitationTrustAssessment(event, forgedPass, 'request', { serverHost: 'jmap.example.com' }).reason).toBe('authentication_missing');
});
it('holds Apply on a counter-proposal authenticated under a foreign authserv-id', () => {
  expect(reviewCounterProposal({ ...args, serverHost: 'jmap.example.com' })?.hold).toBe('sender_unverified');
});
```

- [ ] **Step 2: Run them and confirm they fail.** Then thread `serverHost` through the existing derive and trust tests, so each one names the host its fixture's authserv-id belongs to (`'mx'`, `'x'`, `'mx.example'`). They then keep their old expectations.
- [ ] **Step 3: Implement `authserv.ts` and the pinned `deriveHeaderInfo` / `getEmailAuthenticationResults`.** In `deriveHeaderInfo`, replace the "first header is the receiving server's own" comment with the pinning rule and RFC 8601 §5 (a receiving MTA removes headers that claim its own id, so its own is the topmost trusted one).
- [ ] **Step 4: Pass the host in.**
  - `MessageContent` calls `useAuthservHost(appAccountId)` and memoises `deriveHeaderInfo(email, host)` on both.
  - `CalendarInvitationBanner` passes `serverHost: useAuthservHost(appAccountId)` into the trust context and both `reviewCounterProposal` calls.
- [ ] **Step 5: Run the gate, and the three test files on Node 20.** Expected: PASS.
- [ ] **Step 6: Commit** `fix: judge a sender only by your own server's authentication results`.

### Task 3: Never auto-trust a flagged sender

Size **M**. Decision 3.

**Files:**
- Modify: `src/lib/sender-check.ts`. Add `untrustedReplyAddresses`.
- Modify: `src/lib/trusted-senders.ts` (`isSenderContentTrusted`).
- Modify: `src/lib/trust-recipients.ts` (`trustRecipients`).
- Modify: `src/lib/reply-compose.ts` (`replyComposeParams`), `src/navigation/types.ts` (`ComposeReplyContext`).
- Modify: `src/stores/send-queue-store.ts:93` (`QueuedSend.replyTo`), `src/lib/queue-send.ts` (`buildQueuedSend`), `src/lib/send-queue-replay.ts:160` (`postSendEffects`).
- Modify: `src/screens/ComposeScreen.tsx` (`:2691`, `:2755`), `src/screens/EmailThreadScreen.tsx:571`, `src/components/email/QuickReplyBox.tsx:231`, `src/components/EmailBodyView.tsx:571`.
- Create: `src/lib/__tests__/rsvp-no-trust.test.ts`.
- Test: `sender-check.test.ts`, `trusted-senders.test.ts`, `queue-send.test.ts`, and `src/lib/__tests__/send-queue-replay.test.ts`.
- Shares: `MessageContent.tsx` (Task 2), `send-queue-store.ts` and `send-queue-replay.ts` (Task 4).

**Interfaces:**
- Consumes: `deriveHeaderInfo(email, serverHost)` and `authservHostFor` / `useAuthservHost` (Task 2).
- Produces:
  - `untrustedReplyAddresses(source: Pick<Email, 'from' | 'replyTo' | 'headers' | 'messageId'>, serverHost: string | null): string[]`. The lowercased From and Reply-To addresses when `deriveHeaderInfo(source, serverHost).senderVerification` is set (failed or unverified), else `[]`.
  - `ComposeReplyContext.untrustedAddresses?: string[]`. `replyComposeParams(mode, source, ownerAccountId, serverHost: string | null)` sets it, for every mode.
  - `QueuedSend.replyTo.untrusted?: string[]`, carried by `buildQueuedSend` and persisted.
  - `trustRecipients(recipients, refused, { syncToBook, exclude }: { syncToBook: boolean; exclude?: readonly string[] })`. It skips a recipient whose trimmed, lowercased address is in `exclude`. Compose passes `replyTo?.untrustedAddresses`, and replay passes `entry.replyTo?.untrusted`.
  - `isSenderContentTrusted(senderEmail, opts)`: `opts` gains `senderVerification: SenderVerification | null | undefined`. It returns true only when that is `null` and one of the lists has the address, so an unknown verdict (`undefined`) trusts nothing, as `canOfferTrustSender` already does.

- [ ] **Step 1: Write the failing tests.**

```ts
it('lists the From and Reply-To of a failed or unverified message, and nobody for a verified one', () => {
  expect(untrustedReplyAddresses(forgedFromBank, 'mx')).toEqual(['ceo@bank.example', 'pay@evil.example']);
  expect(untrustedReplyAddresses(verifiedFromBank, 'mx')).toEqual([]);
});
it('loads a trusted address\'s content only on a passing sender check', () => {
  const opts = { isLocallyTrusted: local(['ceo@bank.example']), syncEnabled: false, trustedBookEmails: [] };
  expect(isSenderContentTrusted('ceo@bank.example', { ...opts, senderVerification: null })).toBe(true);
  expect(isSenderContentTrusted('ceo@bank.example', { ...opts, senderVerification: { status: 'failed', domain: 'bank.example' } })).toBe(false);
  expect(isSenderContentTrusted('ceo@bank.example', { ...opts, senderVerification: undefined })).toBe(false);
});
it('carries the untrusted addresses on a queued reply', () => {
  expect(buildQueuedSend({ ...p, replyTo: { emailIds: ['e1'], keyword: '$answered', untrusted: ['ceo@bank.example'] } }).replyTo?.untrusted)
    .toEqual(['ceo@bank.example']);
});
// send-queue-replay.test.ts
it('a replayed reply trusts every accepted recipient except the flagged sender', async () => {
  // entry.outgoing.to = [ceo@bank.example, ann@ok.example], replyTo.untrusted = ['ceo@bank.example']
  expect(trusted()).toEqual(['ann@ok.example']);
});
// rsvp-no-trust.test.ts: answering an invitation never trusts anyone
it.each(['src/lib/invitation-actions.ts', 'src/stores/calendar-store.ts', 'src/components/email/CalendarInvitationBanner.tsx'])(
  '%s files nobody as trusted', (path) => {
    expect(readFileSync(join(ROOT, path), 'utf8')).not.toMatch(/addTrustedSender|trustRecipients|addToTrustedSendersBook/);
  });
```

- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement the helpers and thread them through.**
  - `EmailThreadScreen` passes `authservHostFor(viewerAppAccountId)` to `replyComposeParams`.
  - `ComposeScreen` uses `replyTo?.untrustedAddresses` for both its online `trustRecipients` and its queued `replyTo.untrusted`.
  - `QuickReplyBox`'s offline queue path sets `untrusted: untrustedReplyAddresses(email, authservHostFor(ownerAppAccountId))`.
  - `EmailBodyView` passes its `senderVerification` prop into `isSenderContentTrusted`.
  - RN's RSVP files no one as trusted today (checked: `invitation-actions.ts` and the `rsvpEvent` path never call a trust function). The guard test keeps it that way.
- [ ] **Step 4: Run the gate.** Expected: PASS.
- [ ] **Step 5: Commit** `fix: never trust a sender by replying to a forged message, and load nothing for a forged trusted address`.

### Task 4: Accounts: eviction cleanup, provider check and stale held sends

Size **M**.

**Files:**
- Modify: `src/stores/auth-store.ts`:
  - `forgetEvictedAccount` (`:240`) becomes `evictAccount`;
  - the five eviction sites (`:953`, `:968`, `:1107`, `:1150`, `:1222`);
  - `AccountProviderLogout` and `revokeStoredRefreshToken` (`:252-270`);
  - `providerStillInUse` (`:284`).
- Modify: `src/stores/send-queue-store.ts` (a `restamp` transition), `src/lib/send-queue-replay.ts` (`releaseAccountHold`, `:394`).
- Create: `src/lib/queue-restamp.ts` (pure).
- Create: `src/lib/__tests__/queue-restamp.test.ts`.
- Test: `src/stores/__tests__/auth-store.test.ts`, `auth-store-provider-logout.test.ts`, `send-queue-store.test.ts`, `src/lib/__tests__/send-queue-replay.test.ts`.
- Shares: `auth-store.ts` (Task 6), `send-queue-store.ts` and `send-queue-replay.ts` (Task 3).

**Interfaces:**
- Consumes: `forgetAccountData` (`src/stores/account-data-cleanup.ts`), `dropPendingMailFolder`, `getIdentities(accountId)` (`src/api/identity.ts`), and `QueuedSend.replyTo.untrusted` (Task 3).
- Produces:
  - `evictAccount(accountId: string, opts: { clearCredentials: boolean }): Promise<void>`, module-private in `auth-store.ts`. It does the old `forgetEvictedAccount` work, and when asked clears the credentials. It removes the account from the account and email stores, calls `dropPendingMailFolder(accountId)`, then runs `forgetAccountData({ appAccountId, serverUrl, username }, { lastAccount })`, logged and never thrown. `forgetAccountData` drops the offline cache, identity cache, folder icons and that login's calendar subscriptions. Queued sends are kept (`discardQueuedSends` unset). Each of the five sites calls it with the entry read before removal.
  - `AccountProviderLogout` gains `tokenEndpoint?: string`, the departing account's stored `credentials.tokenEndpoint`.
  - `providerStillInUse` also counts a remaining account whose stored credentials have `tokenSource === 'handoff'` and whose `tokenEndpoint` origin equals the departing one's. An unreadable entry still counts only on the same server origin.
  - In `queue-restamp.ts`: `restampTarget(entry: QueuedSend, live: { primaryId: string | null; servesEntryAccount: boolean; identities: readonly Identity[] }): string | null`. It returns `live.primaryId` only when all of these hold:
    - the entry is `queued`, held `account_unavailable` and never attempted;
    - the session doesn't serve its `jmapAccountId`, and `primaryId` differs from it;
    - it has no attachments;
    - `identities` has `entry.identityId` with the same address (case-insensitive) as `entry.outgoing.from[0]`.

    Otherwise it returns null.
  - `useSendQueueStore.getState().restamp(id: string, jmapAccountId: string): Promise<void>`. A compare-and-set on the same conditions. It sets `jmapAccountId`, clears `heldReason` and `draftId`, sets `replyTo.emailIds` to `[]` (keeping `keyword` and `untrusted`), and sets `replyTo.jmapAccountId` to the new id when it was the old one.
  - `releaseAccountHold` tries `releaseHold` first. When the account still isn't served, it fetches the primary's identities once per flush, with `getIdentities(jmapClient.connectedAccountId)`, and re-stamps through `restampTarget`. Only while `canReplay(entry.appAccountId)` holds before and after the fetch.

- [ ] **Step 1: Write the failing tests.**

```ts
// auth-store.test.ts
it('forgets a switched-to account\'s device data when its session has expired', async () => {
  // loadAccount rejects AuthenticationError for b@y.example.com
  expect(forgetAccountData).toHaveBeenCalledWith({ appAccountId: 'b@y.example.com', serverUrl: 'https://y.example.com', username: 'b' }, { lastAccount: false });
});
it('forgets the account restoreSession finds with no stored credentials', async () => { /* loadAccount → false */ });
// auth-store-provider-logout.test.ts
it('keeps the provider session while a hand-off account on another host signed in at the same token endpoint', async () => {
  // departing: native PKCE, tokenEndpoint https://sso.example.com/realms/r/…/token
  // remaining: serverUrl https://mail.other.example, tokenSource 'handoff', same tokenEndpoint origin
  expect(endProviderSession).not.toHaveBeenCalled();
});
// queue-restamp.test.ts
it('re-stamps a held, never-tried send onto the live primary when its identity matches', () => {
  expect(restampTarget(held, { primaryId: 'jNew', servesEntryAccount: false, identities: [{ id: 'i1', email: 'Me@X.example' }] })).toBe('jNew');
});
it.each([
  ['attempted', { attemptStartedAt: 't' }], ['with attachments', withAttachment], ['another hold', { heldReason: 'no_sent' }],
])('never re-stamps an entry %s', (_l, patch) => { expect(restampTarget({ ...held, ...patch }, live)).toBeNull(); });
it('never re-stamps onto an identity with another address', () => {
  expect(restampTarget(held, { ...live, identities: [{ id: 'i1', email: 'other@x.example' }] })).toBeNull();
});
// send-queue-store.test.ts
it('restamp drops the draft and the replied-to ids, and keeps the trust list', async () => {
  expect(entry('q1')).toMatchObject({ jmapAccountId: 'jNew', draftId: undefined, replyTo: { emailIds: [], untrusted: ['a@b.example'] } });
});
// send-queue-replay.test.ts
it('sends a stale held entry once, on the live primary, after re-stamping it', async () => { /* mockSend once, accountId 'jA' */ });
it('re-stamps nothing when a switch lands while the identities load', async () => { /* canReplay false after getIdentities */ });
```

- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement `evictAccount`, the provider check, `restampTarget`, `restamp` and the replay hook.**
- [ ] **Step 4: Run the gate.** Expected: PASS. The existing `account_unavailable` release tests still pass unchanged.
- [ ] **Step 5: Commit** `fix: forget an expired account's device data, keep a provider session hand-off accounts share, and send a held message on the account's new id`.

### Task 5: Calendar: per-account shared colours, the back arrow and the Tokyo tests

Size **S–M**.

**Files:**
- Modify: `src/lib/calendar-utils.ts:555-600` (`sharedCalendarColorKey`, `applySharedCalendarColors`).
- Modify: `src/lib/managed-scope.ts:84`.
- Modify: `src/screens/CalendarScreen.tsx` (`:396`, `:406`, `:421`, `:1061`, `:1404`).
- Modify: `src/lib/calendar-scroll-window.ts:181-196` (`windowStateForJump`).
- Modify: `src/lib/__tests__/calendar-alert-scheduler.test.ts:85-125` (fixtures only).
- Test: `calendar-utils.test.ts`, `managed-scope.test.ts`, `calendar-scroll-window.test.ts`, `calendar-system.test.ts`.
- Shares: nothing.

**Interfaces:**
- Produces:
  - `sharedCalendarColorKey(appAccountId: string, cal: Pick<Calendar, 'id' | 'accountId' | 'originalId'>): string`, which is `${appAccountId}|${accountId ?? ''}|${originalId ?? id}`.
  - `legacySharedCalendarColorKey(cal): string`, the old `accountId|originalId`, read only.
  - `sharedCalendarColorFor(overrides: Record<string, string>, appAccountId: string, cal): string | undefined`. It reads the new key, then the legacy one, so a webmail import or an existing override still shows.
  - `applySharedCalendarColors(calendars, overrides, appAccountId: string)` uses `sharedCalendarColorFor`.
  - Writes and resets always use the new key, and a reset also removes the legacy key for that calendar.
  - `CalendarScreen` renders with `shownAccountId ?? ''` (no override applies without an account) and writes with `screenAccount().appAccountId`. `managed-scope` writes with `scope.appAccountId`.
  - `windowStateForJump`: when the target is inside the loaded window but its grid start has no row above it while `canExtendStart`, it returns `growScrollWindow(current, 'before')` on the same anchor instead of a fresh window. The list keeps its `windowKey` and isn't remounted. A target outside the window still gets a fresh one.

- [ ] **Step 1: Write the failing tests.**

```ts
it('keeps two app accounts\' overrides for the same JMAP calendar apart', () => {
  const cal = { id: 'team:c1', originalId: 'c1', accountId: 'team', isShared: true, name: 'T' } as Calendar;
  const overrides = { [sharedCalendarColorKey('A', cal)]: '#ff0000' };
  expect(applySharedCalendarColors([cal], overrides, 'A')[0].color).toBe('#ff0000');
  expect(applySharedCalendarColors([cal], overrides, 'B')[0].color).toBeUndefined();
});
it('still shows an override stored under the old key', () => {
  expect(sharedCalendarColorFor({ 'team|c1': '#00ff00' }, 'A', cal)).toBe('#00ff00');
});
// managed-scope.test.ts: the existing recolour test now expects
expect(settings.setSharedCalendarColor).toHaveBeenCalledWith('app-1|team|c1', '#ff0000');
// calendar-scroll-window.test.ts
it('grows the window above a month you step back to, on the same anchor', () => {
  const next = windowStateForJump(state, 'month', prevMonth, opts);
  expect(next.anchorKey).toBe(state.anchorKey);
  expect(next.before).toBeGreaterThan(state.before);
});
```

Keep `calendar-system.test.ts`'s "never lands a jump to the previous month on the window's first row" passing unchanged.

- [ ] **Step 2: Run them and confirm they fail.** Also run `TZ=Asia/Tokyo npx vitest run src/lib/__tests__/calendar-alert-scheduler.test.ts`. Expected today: 2 failed ("lists display alerts…" and "words the reminders…").
- [ ] **Step 3: Fix the Tokyo fixtures.** JSCalendar `due` is a LocalDateTime: the `'2026-03-01T12:00:00Z'` fixtures lose their `Z` (read in the device zone) and fall before `now` east of UTC. Write them as `due: '2026-03-01T12:00:00', timeZone: 'UTC'`, and note why in a comment. The scheduler is unchanged.
- [ ] **Step 4: Implement the colour key and the jump.**
- [ ] **Step 5: Run the gate, then `TZ=Asia/Tokyo npm test` and `TZ=America/Los_Angeles npx vitest run src/lib/__tests__/calendar-alert-scheduler.test.ts`, and the touched files on Node 20.** Expected: PASS everywhere.
- [ ] **Step 6: Commit** `fix: keep shared calendar colours per account, step back a month without reloading the grid, and pass the reminder tests in any time zone`.

### Task 6: Notices and shares: cap the wait, refresh the session, name unknown shares

Size **M**.

**Files:**
- Modify: `src/lib/calendar-event-notification-toast.ts` (add `noticeWaitStep`, `NOTICE_WAIT_CAP_MS`).
- Modify: `src/lib/calendar-event-notification-presenter.ts`, `src/lib/share-notification-presenter.ts`.
- Modify: `src/lib/share-notification-toast.ts:29-35` (unknown `objectType`). Add `needsSessionRefresh`.
- Modify: `src/api/jmap-client.ts` (add `refreshSession`), `src/stores/auth-store.ts` (add `refreshSessionFor`).
- Modify: `locales/rn/*.json` via `npm run i18n:harvest` (one key).
- Test: `calendar-event-notification-toast.test.ts`, `calendar-event-notification-presenter.test.ts`, `share-notification-toast.test.ts`, `share-notification-presenter.test.ts`, and `src/api/__tests__/jmap-client-stale-load.test.ts`.
- Shares: `auth-store.ts` (Task 4), `locales/rn/*.json`.

**Interfaces:**
- Produces:
  - `NOTICE_WAIT_CAP_MS = 60_000`.
  - `noticeWaitStep(waitingSince: number | null, now: number, room: number): { action: 'show' | 'wait' | 'drop'; waitingSince: number | null }`:
    - with room, `show`, and the clock resets to null;
    - without room, `wait`, starting the clock;
    - without room and the clock past the cap, `drop`.
  - Both presenters keep one `waitingSince` and one timer. A `wait` arms `setTimeout(present, remaining)`. A `drop` shows nothing, still refreshes what the batch touched and acknowledges it, and logs once. The unsubscribe clears the timer.
  - `JMAPClient.refreshSession(): Promise<JMAPSession | null>`. It refetches the session document for the live credentials, on the live load generation without starting a new load. It swaps in the rewritten session and keeps `accountId`, only while the same generation and credentials still serve. Otherwise it returns null and changes nothing.
  - `useAuthStore.getState().refreshSessionFor(appAccountId: string): Promise<boolean>`. Only when `appAccountId` is active and `clientServesAccount(appAccountId)`, before and after the fetch, it calls `refreshSession` and sets `session`.
  - `needsSessionRefresh(shown: ShareNotification[], knownAccountIds: readonly string[]): boolean`. True when a share that grants rights (non-empty `newRights`) names an `objectAccountId` the session doesn't list.
  - The share presenter refreshes the session first when needed, then fetches the touched lists.
  - An unknown `objectType` reads `t('share_notifications.object.other', 'shared item')` (RN key). The raw type is never shown.

- [ ] **Step 1: Write the failing tests.**

```ts
it('waits for room, then drops the batch once the wait passes the cap', () => {
  expect(noticeWaitStep(null, 1000, 0)).toEqual({ action: 'wait', waitingSince: 1000 });
  expect(noticeWaitStep(1000, 1000 + NOTICE_WAIT_CAP_MS - 1, 0).action).toBe('wait');
  expect(noticeWaitStep(1000, 1000 + NOTICE_WAIT_CAP_MS, 0).action).toBe('drop');
  expect(noticeWaitStep(1000, 5000, 2)).toEqual({ action: 'show', waitingSince: null });
});
// presenters, with fake timers and three must-keep toasts held past the cap
it('acknowledges a batch without a toast after waiting a minute, and leaves the undo toast alone', () => {});
it('names an unknown shared object as a shared item, never by its raw type', () => {
  expect(shareNotificationMessage({ ...n, objectType: 'x:Weird‮' }, t).text).toContain('shared item');
});
it('asks for a fresh session when a share comes from an account the session lacks', () => {
  expect(needsSessionRefresh([grant('newOwner')], ['me', 'team'])).toBe(true);
  expect(needsSessionRefresh([grant('team'), revoke('gone')], ['me', 'team'])).toBe(false);
});
// jmap-client-stale-load.test.ts
it('a session refresh that a switch overtakes changes nothing', async () => { /* loadAccount starts mid-fetch → null, session unchanged */ });
```

- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement**, then run `npm run i18n:harvest`.
- [ ] **Step 4: Run the gate.** Expected: PASS.
- [ ] **Step 5: Commit** `fix: stop calendar and share notices waiting forever, show folders shared by a new owner, and name unknown shares plainly`.

### Task 7: Mail list and drawer: hand-picked folders, the seed race, tag collapse and RTL chevrons

Size **M**.

**Files:**
- Modify: `src/stores/email-store.ts:533`, `:1300-1382` (`selectMailbox`).
- Modify: `src/lib/tag-rows.ts`.
- Modify: `src/lib/rtl-layout.ts` (add `forwardIconStyle`).
- Modify: `src/components/SidebarDrawer.tsx` (`:60`, `:180-191`, `:424-436`, `:657`, `:810`, `:1214-1240`).
- Modify: `src/screens/SettingsScreen.tsx` (`:304`, `:341`, `:474`), `src/components/settings/AccountSettings.tsx:276`, `src/components/settings/ContentSendersSettings.tsx:172`, `src/components/settings/FilterSettings.tsx:397`.
- Test: `src/stores/__tests__/email-store.test.ts`, `src/lib/__tests__/tag-rows.test.ts`, `src/lib/__tests__/rtl-layout.test.ts`.
- Shares: `SidebarDrawer.tsx`, `SettingsScreen.tsx` and `FilterSettings.tsx` (Task 9).

**Interfaces:**
- Consumes: `dropPendingMailFolder(appAccountId)` and `usePendingMailFolder` (`src/navigation/pending-mail-folder.ts`), `isLayoutRTL()` (`src/i18n`).
- Produces:
  - `selectMailbox(mailboxId: string, opts?: { byUser?: boolean }): Promise<void>`:
    - With `byUser`, it first calls `dropPendingMailFolder(get().activeAccountId)`, so a hand pick wins over a cold-start link for the same account. The drawer's three calls pass `{ byUser: true }`; the mail list's own link and Inbox picks don't.
    - Each call takes a generation from a module counter. After the offline-cache read, a call that a newer `selectMailbox` or an account change (`activeAccountId` differs from the one it started on) overtook returns without touching state. That is the seed race.
  - `TagRowsOptions.collapsed?: ReadonlySet<string>`. `TagRow` gains `hasChildren: boolean` and `expanded: boolean`. A collapsed node's descendants are left out, except that the path down to `selectedId` stays open. `hiddenCount` still counts visibility only.
  - The drawer keeps the collapsed tag ids under `STORAGE_KEYS.collapsedTags = 'sidebar:collapsedTags'`, read with the others. Tag defs are device-wide, so the key is too, and a new parent starts expanded, as in webmail's default. It renders tag rows with `hasChildren`, `isExpanded` and a toggle that writes the set.
  - `forwardIconStyle(rtl: boolean): { transform: [{ scaleX: -1 }] } | undefined`. Applied to every forward chevron and back arrow in the settings files named above, and to `SidebarRow`'s collapsed chevron.

- [ ] **Step 1: Write the failing tests.**

```ts
// email-store.test.ts
it('a folder picked by hand drops a link still waiting for that account', async () => {
  setPendingMailFolder({ ref: 'Work', appAccountId: 'A', fromMailboxId: null });
  await useEmailStore.getState().selectMailbox('mb-2', { byUser: true });
  expect(usePendingMailFolder.getState().target).toBeNull();
});
it('the mail list\'s own pick keeps the link', async () => { /* no byUser → target kept */ });
it('a slower earlier pick never overrides a later one', async () => {
  // first call's cache read resolves after the second call finished
  expect(useEmailStore.getState().currentMailboxId).toBe('mb-2');
});
it('a pick an account switch overtook leaves the new account alone', async () => {});
// tag-rows.test.ts
it('hides a collapsed parent\'s children and marks the parent', () => {
  const { rows } = tagRows(defs, { nested: true, collapsed: new Set(['work']) });
  expect(rows.map((r) => r.def.id)).toEqual(['work', 'home']);
  expect(rows[0]).toMatchObject({ hasChildren: true, expanded: false });
});
it('keeps the path to the selected tag open', () => {
  expect(tagRows(defs, { nested: true, collapsed: new Set(['work']), selectedId: 'work/q3' }).rows.map((r) => r.def.id))
    .toContain('work/q3');
});
// rtl-layout.test.ts
it('mirrors a forward icon only in RTL', () => {
  expect(forwardIconStyle(true)).toEqual({ transform: [{ scaleX: -1 }] });
  expect(forwardIconStyle(false)).toBeUndefined();
});
```

- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.** Comment why the seed counter exists and why `byUser` drops the link. The drawer's tag section follows webmail `components/layout/sidebar.tsx:636-720, 970-1002`.
- [ ] **Step 4: Run the gate.** Expected: PASS.
- [ ] **Step 5: Commit** `fix: let a folder you pick win over a waiting link, collapse tags one by one, and point settings chevrons the right way in RTL`.

### Task 8: Settings and tooling

Size **M**. Seven small items; the steps are by item.

**Files:**
- Create: `src/lib/sidebar-app-url.ts`. Move `sanitizeSidebarAppUrl` there from `src/lib/sidebar-apps.ts` (which re-exports it), so the settings store can use it without an import cycle.
- Modify: `src/stores/settings-store.ts:957-972` (`importSettings`).
- Modify: `src/lib/time-zone-options.ts`.
- Create: `src/lib/after-dismiss.ts`. Modify `src/components/settings/FolderSettings.tsx:233-244`.
- Modify: `app.config.js:21-35`, `:117-121`, `src/lib/source-link.js`, `src/lib/source-link.d.ts`.
- Modify: `scripts/sync-locales.mjs:62-76`.
- Modify: `package.json`, `package-lock.json` (devDependencies).
- Test: `src/stores/__tests__/settings-store.test.ts`, new `src/lib/__tests__/time-zone-options.test.ts`, `date-format.test.ts`, new `src/lib/__tests__/after-dismiss.test.ts`, `source-link.test.ts`.
- Shares: `package.json` (Task 1), `FolderSettings.tsx` (Task 9).

**Interfaces:**
- Produces:
  - `importSettings` keeps only `sidebarApps` entries with string `id`, `name` and `url` whose `sanitizeSidebarAppUrl(url)` passes, with the URL stored as the sanitiser returns it. The rest of the file still imports. Hydrate is unchanged, so an app saved before the check stays editable.
  - `availableTimeZones(intl?: { supportedValuesOf?: (key: 'timeZone') => string[] }): readonly string[]`. `Intl.supportedValuesOf('timeZone')` when it is a function that returns a non-empty list, else `COMMON_TIME_ZONES`. A throw also falls back. `timeZoneOptions(deviceZone, current, autoLabel, zones = availableTimeZones())` keeps its other behaviour.
    - Today's Hermes has no `Intl.supportedValuesOf`: `strings` on the built `libhermes.so` lists `supportedLocalesOf` and `getCanonicalLocales` only. The device keeps the hand-picked list until Hermes adds it, and the comment says so.
  - The full list format: no code change. The whole string is formatted in the region locale, as webmail `lib/utils.ts:137-147` does, so its day period is the region's already. A test pins that.
  - `createAfterDismiss<T>(open: (target: T) => void, timeoutMs = 700): { arm(target: T): void; dismissed(): void; cancel(): void }`. `dismissed()` opens the armed target once. When `onDismiss` never comes (an iOS Modal quirk), the timer opens it. Either path clears the other. `FolderSettings` uses it for `shareAfterEditor` and cancels it on unmount.
  - `commitOnOrigin(p: { ci: boolean; dirty: string; remoteBranches: string }): boolean`, in `source-link.js`. True in CI. Otherwise true only when `git status --porcelain --untracked-files=no` printed nothing and `git branch -r --contains HEAD --list 'origin/*'` printed a branch.
    - `app.config.js` records `gitCommit` only when it holds, so a local, unpushed or dirty build links the repository, and About shows its short commit as plain text as it already does.
  - `sync-locales.mjs` compares, and writes on a copy, with `\r\n` turned into `\n`. The webmail checkout's catalogs are CRLF; ours are LF.
  - devDependencies gain `@babel/core` ^7.29.0, `@babel/plugin-transform-flow-strip-types` ^7.27.1 and `@babel/plugin-transform-modules-commonjs` ^7.28.6, the versions the lockfile hoists today. `src/lib/__tests__/helpers/rn-url.ts` and `lucide-imports.test.ts` import them.

- [ ] **Step 1: Write the failing tests.**

```ts
it('imports the valid sidebar apps and drops the rest', () => {
  expect(useSettingsStore.getState().importSettings(JSON.stringify({ sidebarApps: [ok, { ...ok, id: 'b', url: 'http://x.example' }, { ...ok, id: 'c', url: 'https://a.example\\@b.example' }] }))).toBe(true);
  expect(useSettingsStore.getState().sidebarApps.map((a) => a.id)).toEqual(['a']);
});
it('offers every zone the runtime knows, and the hand-picked list without it', () => {
  expect(availableTimeZones({ supportedValuesOf: () => ['Asia/Kathmandu', 'UTC'] })).toEqual(['Asia/Kathmandu', 'UTC']);
  expect(availableTimeZones({})).toBe(COMMON_TIME_ZONES);
  expect(availableTimeZones({ supportedValuesOf: () => { throw new RangeError(); } })).toBe(COMMON_TIME_ZONES);
});
it('writes the full format\'s AM/PM in the region locale', () => {
  expect(formatListDate(OLDER, { dateFormat: 'full', timeFormat: '12h', locale: 'en', dateLocale: 'en-GB', timeZone: 'UTC' }))
    .toBe('28/04/2026, 03:31 pm');
});
it('opens the share sheet on dismiss, or after the timeout when dismiss never comes, once', () => {
  vi.useFakeTimers(); const open = vi.fn(); const d = createAfterDismiss(open, 700);
  d.arm('f1'); vi.advanceTimersByTime(700); d.dismissed();
  expect(open).toHaveBeenCalledTimes(1);
});
it('links a commit only when it can be on origin', () => {
  expect(commitOnOrigin({ ci: true, dirty: ' M x', remoteBranches: '' })).toBe(true);
  expect(commitOnOrigin({ ci: false, dirty: '', remoteBranches: '  origin/main' })).toBe(true);
  expect(commitOnOrigin({ ci: false, dirty: ' M App.tsx', remoteBranches: '  origin/main' })).toBe(false);
  expect(commitOnOrigin({ ci: false, dirty: '', remoteBranches: '' })).toBe(false);
});
```

- [ ] **Step 2: Run them and confirm they fail** (the date test may already pass; record that it pins today's behaviour).
- [ ] **Step 3: Implement each item.** Then run `npm install -D @babel/core@^7.29.0 @babel/plugin-transform-flow-strip-types@^7.27.1 @babel/plugin-transform-modules-commonjs@^7.28.6`.
- [ ] **Step 4: Verify the tooling.**
  - `node scripts/sync-locales.mjs --check --from /tmp/webmail/locales; echo $?`. Expected: "Vendored locales are up to date." and `0`; today it reports 27 stale. The `settings.themes.default_name` shadow notice may remain; it is informational.
  - `npx expo config --json | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).extra))"` on this branch with an uncommitted edit. Expected: `gitCommit: ''`.
  - `npm ls @babel/core --depth=0`. Expected: listed as a direct devDependency.
- [ ] **Step 5: Run the gate, and `date-format.test.ts` and `time-zone-options.test.ts` on Node 20.** Expected: PASS.
- [ ] **Step 6: Commit** `fix: drop invalid sidebar apps on import, list every time zone the device knows, and link only commits that are on origin`.

### Task 9: The font size setting everywhere, with the OS scale capped

Size **L** (mechanical). Decision 1. Run it after Tasks 2, 7 and 8, which touch some of the same files.

**Files:**
- Modify: `src/theme/tokens.ts:326-353`. Add `BODY_MAX_FONT_SCALE` and `fontPx`; `applyFontScale` records the factor.
- Create: `patches/react-native+0.81.5.patch`, through `npx patch-package react-native` after editing `node_modules/react-native/Libraries/Text/Text.js` and `Libraries/Components/TextInput/TextInput.js`.
- Create: `src/theme/__tests__/font-literals.test.ts`.
- Modify: `src/theme/__tests__/typography-scale.test.ts`, `typography-module-scope.test.ts`, `chrome-font-cap.test.ts`.
- Modify: the 29 files with literals:
  - `App.tsx:296`;
  - `src/components/SidebarDrawer.tsx:1448,1475`;
  - `src/components/ToastHost.tsx:274,275,281`;
  - `src/components/calendar/EventBlock.tsx:220,221,234` (module scope: move `styles` into a `useMemo` builder);
  - `src/components/calendar/MonthView.tsx:359,394,398`;
  - `src/components/contacts/ContactActivity.tsx:288`;
  - `src/components/email/AttachmentPreviewModal.tsx:245`;
  - `src/components/email/MessageHeader.tsx:396`;
  - `src/components/filters/SieveEditorSheet.tsx:228`;
  - `src/components/settings/`:
    - `AboutDataSettings.tsx:450`;
    - `AccountSecuritySettings.tsx:1058,1095`;
    - `AppearanceSettings.tsx:190,197`;
    - `DownloadsSettings.tsx:182,191`;
    - `FilesSettings.tsx:270,280,281,295`;
    - `FilterSettings.tsx:112,113,642`;
    - `FolderSettings.tsx:682,688`;
    - `IdentitySettings.tsx:426,450`;
    - `KeywordSettings.tsx:429`;
    - `SidebarAppsSettings.tsx:254`;
    - `VacationSettings.tsx:578`;
  - `src/screens/`:
    - `ContactDetailScreen.tsx:980`;
    - `ContactFormScreen.tsx:1595`;
    - `ContactsScreen.tsx:730`;
    - `EmailListScreen.tsx:2257`;
    - `EmailSourceScreen.tsx:160`;
    - `EmailThreadScreen.tsx:1626`;
    - `FilesScreen.tsx:1533`;
    - `SettingsScreen.tsx:592,615,624`;
    - `UnifiedInboxScreen.tsx:628`.

  Line numbers are from `afcf7b3`; earlier tasks move some.
- Shares: `SidebarDrawer.tsx`, `SettingsScreen.tsx`, `FilterSettings.tsx` (Task 7), `FolderSettings.tsx` (Task 8), `MessageHeader.tsx` (Task 2).

**Interfaces:**
- Produces:
  - `BODY_MAX_FONT_SCALE = 1.5`.
  - `fontPx(px: number): number`. It is `Math.round(px * factor * 2) / 2`, with `factor` the last one `applyFontScale` set (1 before any). It is read inside a style builder, never at module scope, like `typography`.
  - Every literal becomes `fontPx(n)`, and a `lineHeight` literal beside it becomes `fontPx(m)` too. Where a literal equals a token's base size and weight, the token spread is fine instead.
  - The patch: a top-level `Text` (no text ancestor) and a `TextInput` without `maxFontSizeMultiplier` get 1.5. A nested `Text` keeps what it was given, so it inherits its parent's cap, including `CHROME_MAX_FONT_SCALE`. Each patched site carries a comment naming `BODY_MAX_FONT_SCALE` in `src/theme/tokens.ts`.
    - This is a patch to RN core because React 19 dropped `defaultProps` on function components, so `Text.defaultProps` no longer works, and a wrapper would mean changing the `Text` import in 168 files.
  - `MonthView`'s `monthLabel` and `chipText` Text and `EventBlock`'s `blockTitle`, `blockTime` and `barTitle` Text sit in fixed boxes. They pass `maxFontSizeMultiplier={CHROME_MAX_FONT_SCALE}` and join `CHROME_TEXT`.
  - `src/widgets` is out: home-screen widgets render as RemoteViews, outside the app's font setting.

- [ ] **Step 1: Write the failing tests.**

```ts
// font-literals.test.ts: AST walk of App.tsx and src (skipping __tests__, src/theme, src/widgets)
it('has no numeric fontSize literal outside the theme', () => {
  expect(fontSizeLiterals()).toEqual([]);   // today: 48 entries, "src/components/ToastHost.tsx:274", …
});
it('caps the OS scale on body text at 1.5 in the installed react-native', () => {
  expect(BODY_MAX_FONT_SCALE).toBe(1.5);
  const text = readFileSync(require.resolve('react-native/Libraries/Text/Text.js'), 'utf8');
  expect(text).toMatch(/hasTextAncestor[\s\S]{0,200}maxFontSizeMultiplier[\s\S]{0,80}1\.5/);
  expect(readFileSync(require.resolve('react-native/Libraries/Components/TextInput/TextInput.js'), 'utf8')).toMatch(/maxFontSizeMultiplier[\s\S]{0,80}1\.5/);
  expect(existsSync(join(ROOT, 'patches/react-native+0.81.5.patch'))).toBe(true);
});
// typography-scale.test.ts
it('fontPx follows the font size setting from the base, in half points', () => {
  expect(fontPx(14.5)).toBe(14.5);
  applyFontScale(1.125); expect(fontPx(10)).toBe(11.5);
  applyFontScale(0.875); expect(fontPx(14.5)).toBe(12.5);
});
// typography-module-scope.test.ts: the walk also flags `fontPx` at module scope
```

- [ ] **Step 2: Run them and confirm they fail.** Expected: the literal list has 48 entries, and the patch markers are missing.
- [ ] **Step 3: Implement `fontPx` and the cap, write the patch, and run `npm install`.** Confirm `patch-package` reapplies it from `postinstall`.
- [ ] **Step 4: Convert the literals,** file by file. Move `EventBlock`'s styles into a builder keyed on `useColors()`, as the other calendar components do.
- [ ] **Step 5: Run the gate.** Expected: PASS, with an empty literal list.
- [ ] **Step 6: Build a debug APK and check on the emulator.** Use the flags in the `android-test-apk-build` memory note. Check the Large setting with a 2.0 system font: settings badges, the toast, the month chips and the tab bar stay inside their boxes, and body text stops growing at 1.5×. Record what you saw; it is also a device check in Task 10.
- [ ] **Step 7: Commit** `fix: apply the font size setting to every screen, and stop a large system font from overflowing body text`.

### Task 10: Record what was done and what is left

Size **S**. It runs after every other task and after the final branch review.

**Files:**
- Modify: `docs/superpowers/plans/2026-10-04-webmail-parity-roadmap.md`, `CHANGES.md`, `README.md`.

**Interfaces:**
- Consumes: the commit hashes of Tasks 1-9 (`git log --oneline main..HEAD`), and each implementer's report: the tldts size, the emulator font check, and anything parked.

- [ ] **Step 1: Mark the done follow-ups in the roadmap.** In the Phase 6e and Phase 7 "Follow-ups parked" and "Left open" lists, append `— done in <hash>` to each item this plan closed.
  - Orphan key: `— already removed in c9e033d`.
  - Full list format: `— already in the region locale, as webmail; pinned by a test in <hash>`.
  - Time zone list: `— <hash>; Hermes has no Intl.supportedValuesOf yet, so devices keep the hand-picked list`.
- [ ] **Step 2: Add `## Follow-up cleanup 1 (2026-10-09)`** after the Phase 7 section, in its shape ("What's new for users", then "Left open"). Left open:
  - every device check from both phases, plus three new ones: the font cap on a phone, the iOS share timer, and pinning against the real server's authserv-id (`Authentication-Results` on a received message);
  - the upstream requests from both phases;
  - sidebar apps' inline mode;
  - the shared-account calendar rename gate against Stalwart;
  - the 8 blocked parity items;
  - the `settings.themes.default_name` overlay key, which the webmail catalog now ships;
  - any reviewer follow-ups.
- [ ] **Step 3: Update `CHANGES.md`.**
  - Add `## Follow-up cleanup 1 (unmerged)` at the top of the phase list, with `Branch \`cleanup/follow-ups-1\`, everything after afcf7b3.`
  - Give it `### Improvements` and `### Fixes` bullets with short hashes, in the existing style.
  - Update the opening paragraph's commit count.
- [ ] **Step 4: Update `README.md`.**
  - `:78`: "Font size for most of the app (a few screens still use fixed sizes)" becomes "Font size for the whole app, with the system font size capped where text would overflow".
  - `:38`: say the sender check reads only your own server's results.
  - Change nothing else unless a claim is now wrong.
- [ ] **Step 5: Commit.** Run `git add` on the three paths explicitly, then commit `docs: record follow-up cleanup 1 and what is left`.

---

## Self-review

1. **Spec coverage.**

   | Item | Task |
   |---|---|
   | Decision 1, font literals, OS cap, guard test | 9 |
   | Decision 2, authserv-id pinning (pure, host passed in) | 2 (registrable parent from 1) |
   | Decision 3, reply and RSVP never trust a flagged sender; forged trusted address loads nothing | 3 |
   | Public suffix list for `domainsAlign` (tldts, MIT) | 1 |
   | Shared-calendar colour key by app account | 5 |
   | Stale held send re-stamped | 4 |
   | Hand-off accounts by `tokenEndpoint` origin | 4 |
   | Icons, and `forgetAccountData`, on session-expired eviction | 4 |
   | Session re-fetch for a new owner's share; unknown `objectType` | 6 |
   | Full list AM/PM in the region locale | 8 (pinned; already so) |
   | Time zone list via `Intl.supportedValuesOf` with fallback | 8 |
   | Two Tokyo scheduler tests | 5 |
   | Month back-arrow grows `before` | 5 |
   | Calendar notice wait capped (share notices too) | 6 |
   | Settings chevrons in RTL (and the drawer's) | 7 |
   | Per-tag collapse | 7 |
   | iOS `onDismiss` fallback timer | 8 |
   | Cold-start link: hand pick wins | 7 |
   | `selectMailbox` seed race | 7 |
   | Sidebar apps import filter | 8 |
   | Orphan RN key | already removed in c9e033d; Task 10 records it |
   | `sync-locales.mjs --check` line endings | 8 |
   | Pin `@babel/core` and two plugins | 8 |
   | About: commit as text when not on origin | 8 |
   | Out of scope, kept on the roadmap | "Not in this plan"; Task 10 Step 2 |
   | Docs | 10 |

2. **Step scan.** Each step names its file, signature, values or command.
   - The two judgement calls are fixed in the Interfaces: the notice wait cap (60 s, then acknowledge silently) and the re-stamp guards (no attachments, matching identity, draft and reply ids dropped).
   - Line numbers are from `afcf7b3`. Tasks 7-9 say where earlier tasks move them.
3. **Type consistency.**
   - `deriveHeaderInfo(email, serverHost)` and `getEmailAuthenticationResults(email, serverHost)` (Task 2) are what Task 3's `untrustedReplyAddresses` calls.
   - `QueuedSend.replyTo.untrusted` (Task 3) is what Task 4's `restamp` keeps.
   - `registrableDomain` (Task 1) is used by `isTrustedAuthservId` (Task 2).
   - `forwardIconStyle` lives in `rtl-layout.ts` (Task 7).
   - `fontPx` and `BODY_MAX_FONT_SCALE` live in `tokens.ts` (Task 9).
   - `auth-store.ts` gains `evictAccount` (Task 4) and `refreshSessionFor` (Task 6), so those two tasks run in order.
4. **Review Focus.** Each line has a named test in its owning task:
   - 1: Task 2's foreign-authserv tests for deriveHeaderInfo, invitations and counter-proposals;
   - 2: Task 1's IP and single-label cases, and Task 2's `192.0.2.1` cases;
   - 3: Task 4's restamp store test and the replay "switch lands" test;
   - 4: Task 7's `byUser` tests (the link is still dropped for another account by `planMailFolderOpen`);
   - 5: Task 9's patch test, which checks the `hasTextAncestor` guard.
5. **Proportion.** About the length of the phase 7 plan for a similar number of items. Code blocks hold test names and assertions only.
