# Follow-up Cleanup 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the buildable items that Follow-up cleanup 1 left open:
- check four Stalwart behaviours on a throwaway local server, and let the answers set the sender-check and calendar gates;
- make an interrupted sign-out cleanup finish after an app kill, and close the two cleanup races in the ledger;
- held sends from before 6161666, push after a session refresh, `coalesceByKey`, the folder snapshot tuck, the font guard, the public suffix list's age, the legacy calendar colour key and the shadowed overlay key.

**Architecture:**
- JS only. No native module, no rebuild, no new dependency.
- Each decision goes in a pure function, tested in node; stores and screens only call it.
- The cleanup marker is one AsyncStorage row the auth store writes after the credentials are gone and clears when the cleanup is done or moot. A cold start reads it only once the account registry has loaded.
- Task 2 is conditional: Task 1's Stalwart check decides whether it is built.

**Tech Stack:** React Native / Expo SDK 54 (RN 0.81.5, React 19.1, Hermes; `android/` committed), TypeScript, Zustand, AsyncStorage, vitest, tldts 7.4.18. Task 1 also uses Docker and `stalwartlabs/stalwart:v0.16` (0.16.25).

**Spec:**
- The item list: "Follow-up cleanup 1 (2026-10-09)" → "Left open" in `docs/superpowers/plans/2026-10-04-webmail-parity-roadmap.md` (:638-697).
- House rules: `.superpowers/sdd/2026-10-10-cleanup-follow-ups-2/common.md`, copied into Global Constraints below.
- User decisions, 2026-10-10 (binding):
  1. **Sidebar apps' inline mode:** not built. It is closed as a deliberate difference: sidebar apps open in the in-app browser only, so no third-party page runs inside the app's view. Task 8 records it.
  2. **The "mail server name" setting:** built only if Task 1 shows that Stalwart's authserv-id doesn't match the JMAP host or its registrable parent by itself. Then Task 2 builds an optional per-account exact authserv-id. Otherwise Task 2 is skipped, and Task 8 records why.

## Global Constraints

- **Branch:** `cleanup/follow-ups-2`, from `main` at `c18c785`.
- **Gate before any commit:** `npm run typecheck && npm test && npm run i18n:check`. Check the exit status; never hide a failure behind `tail`.
- **Node 20:** CI runs Node 20. For any test that touches Intl, dates or email headers, also run `PATH=~/.nvm/versions/node/v20.20.2/bin:$PATH npx vitest run <file>`.
- **A red shared tree:** if another implementer's uncommitted work turns the tree red, verify on a scratch `git worktree` of HEAD plus your files, then remove that worktree.
- **Staging:** stage by explicit path only. Never `git add -A` or `git add .`.
- **Forbidden git commands:** never `git stash`, `git reset` or `git checkout -- <file>`. Other implementers' work may be in the tree.
- **Check each commit:** after it, run `git show --stat HEAD` and confirm it holds only your files. Report hashes from `git log -1 --format=%h`.
- **Commit messages:** lower-case conventional (`feat:`, `fix:`), saying what the user gets. One commit per task. End each message with:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01AdqB9PokeySGSsJ92sqngP`
- **Account safety (the house rule):**
  - JMAP ids collide across accounts and servers.
  - Every per-account stored key, cache entry or parked target is keyed by the **app account id**. Nothing ever resolves against another account's data.
  - Use the existing helpers: `opScope`/`inAccount`, `requireShownAccountScope`/`isShownAccount`, `clientServesAccount`, `jmapClient.request(…, {gen})`, `StaleLoadError`/`isStaleLoad`, and `jmapClient.connectedAccountId`.
  - Sign-out and eviction: credentials go first. Every later step is bounded and caught, and the pending-cleanup holds and `stillGone` guard in `auth-store.ts` and `account-data-cleanup.ts` must keep working.
- **Text from other people:** show sender- or other-user-written text through `plainDisplayText` (`src/lib/display-text.ts`). Write escapes like `' '` literally in source; never paste the raw invisible character.
- **Strings:** `t('key', 'English fallback')`. Reuse webmail's key where its English fits. RN-only keys go through `npm run i18n:harvest`.
- **Code:** match the surrounding comment style; comments say why. Regexes over sender- or server-controlled text are linear, with capped input.
- **Device-sync purity:** `src/device-sync` and the pure libs it imports must not import a store.
- **Native:** `android/` is hand-edited. Never run `expo prebuild --clean`.
- **TDD:** write the failing test first, run it, and record that it failed.
- **Don't:** dispatch subagents; contact the user's real mail server or write to it (Task 1's throwaway local Stalwart is fine); modify `/tmp/webmail`.
- **Docs:** only Task 1 (its findings block) and Task 8 edit the roadmap. Only Tasks 7 and 8 edit `README.md`. Only Task 8 edits `CHANGES.md`.
- **Shared files:** tasks whose Files blocks name the same file must not run at the same time. Run them in number order. Hot spots:
  - `src/stores/auth-store.ts` (Tasks 3, 4, 6);
  - `src/stores/account-data-cleanup.ts` (Task 3 only);
  - `src/lib/authserv.ts` (Tasks 1, 2);
  - `src/lib/managed-scope.ts` (Task 1 only);
  - `src/stores/settings-store.ts`, `src/lib/calendar-utils.ts`, `src/screens/CalendarScreen.tsx` (Task 6 only);
  - `src/stores/send-queue-store.ts`, `src/stores/email-store.ts` (Task 5 only);
  - `locales/rn/*.json` (Tasks 2, 7);
  - `package.json` (Task 7 only);
  - `README.md` (Tasks 7, 8);
  - the roadmap (Tasks 1, 8).
  Tasks 5 and 7 share nothing with Tasks 3, 4 and 6 and may run beside them.

## Review Focus

1. **A cold start whose account registry didn't load in time never runs a pending forget.** `useAccountStore.persist.hasHydrated()` is false, so every account looks gone. The markers wait for the next start, and nothing is erased. Owned by Task 3.
2. **A pending forget for an account that was signed back in before the kill never runs.** At the cold start the id is registered, so its marker is dropped unrun, and the account's identities, queued sends and subscriptions stay. Owned by Task 3.
3. **Two overlapping sign-ins of a signed-out id never let its cleanup run between them.** If both fail, the cleanup runs once afterwards. If either succeeds, it never runs. Owned by Task 3.
4. **A held send from before 6161666 that was sent once and retried is never moved to another account.** A never-tried one from then still goes out when the session serves its own account again. Owned by Task 5.
5. **An account signed in after this upgrade never shows a colour from the legacy key.** A settings import colours the shown account only, and never wipes another account's colours. Owned by Task 6.

## Not in this plan

- **Device checks:** every one listed in Phase 6e, Phase 7 and Follow-up cleanup 1 stays open, including pinning against the real server's authserv-id. Task 1's local Stalwart is no substitute for it.
- **Upstream requests:** all of them stand. Task 1 may add to them.
- **Shared-account sending**, the **8 blocked parity items**, and **sidebar apps' inline mode** (decision 1).
- **The 41ab162 squash:** #17 merged it as is; it is history. Task 8 marks it so.

---

### Task 1: Check Stalwart's Authentication-Results and calendar rights on a throwaway server

Size **M**. It runs first. Its findings decide Task 2 and the gates below.

**Files:**
- Scratch only (never committed): `$SCRATCH/stalwart-probe/`, a copy of `/tmp/webmail/integration`. `$SCRATCH` is the session scratchpad.
- Modify: `src/lib/managed-scope.ts:33-43` (`scopedCalendarActions` and its comment), by the table in Step 6.
- Modify: `src/lib/authserv.ts:59-100` (the comments on `isTrustedAuthservId` and `pinAuthenticationResults`). Comments only.
- Test: `src/lib/__tests__/managed-scope.test.ts` ("offers rename and recolour only where the rights allow it", `:90`).
- Modify: `docs/superpowers/plans/2026-10-04-webmail-parity-roadmap.md`. Append `## Follow-up cleanup 2 (2026-10-10)` with one subsection, `### Stalwart checks`. Task 8 writes the rest of the section.
- Shares: `authserv.ts` (Task 2), the roadmap (Task 8).

**Interfaces:**
- Produces, in the roadmap's `### Stalwart checks` block:
  - the Stalwart version (from the `Server` header or the container log);
  - the configured `serverHostname`;
  - the session's `apiUrl`;
  - the answers (a)-(d) below, each with the raw header lines or the JMAP `notUpdated` it rests on.
  - The block ends with exactly one of these lines, which Task 2 reads:
    - `Exact authserv-id setting: needed — <reason>`
    - `Exact authserv-id setting: not needed — <reason>`

- [ ] **Step 1: Bring up the throwaway server.**
  1. Check that no `bulwark-it-stalwart` container is running, and that ports 8025, 1025 and 1143 are free (`docker ps`, `ss -ltn`). If one is, it isn't yours: stop and report.
  2. `cp -r /tmp/webmail/integration $SCRATCH/stalwart-probe`. Every edit below is to the copy; `/tmp/webmail` is never touched.
  3. In the copy:
     - `cp .env.example .env`, and set `STALWART_RECOVERY_ADMIN=admin:admin` and `TEST_ACCOUNT_PASSWORD=test-pass-123`;
     - run `bash stalwart/prepare-stalwart-cli.sh`;
     - run `docker compose up -d --build --wait stalwart`.
  4. `docker exec bulwark-it-stalwart ss -ltn` (or `netstat -ltn`). Note whether an inbound SMTP listener (port 25) exists.
     - If none exists, add one to the copy's `stalwart/plan-accounts.ndjson.tpl`, shaped like the `submission` line but named `smtp` and bound to `[::]:25`.
     - Then `docker compose down -v && docker compose up -d --build --wait stalwart`.
  5. Record `curl -s -u bob@example.org:test-pass-123 http://127.0.0.1:8025/jmap/session | jq '{apiUrl, accounts: (.accounts|keys), primary: .primaryAccounts}'`.
- [ ] **Step 2: Send the four probes to bob.** Write each `.eml` with CRLF line endings, a `Date` and a unique `Message-ID`. Send with curl's SMTP client.
  - **A, local, plain:** From `alice@example.org`, no Authentication-Results. Authenticated submission: `curl -s smtp://127.0.0.1:1025 --user alice@example.org:test-pass-123 --mail-from alice@example.org --mail-rcpt bob@example.org --upload-file a.eml`.
  - **B, external, forged:** From `sender@external.test`, unauthenticated, to the inbound listener inside the container: `docker exec -i bulwark-it-stalwart curl -s smtp://127.0.0.1:25 --mail-from sender@external.test --mail-rcpt bob@example.org --upload-file - < b.eml`. Its headers, top to bottom:
    - `Authentication-Results: mail.example.org; spf=pass smtp.mailfrom=external.test; dkim=pass header.d=external.test; dmarc=pass header.from=external.test`
    - `Authentication-Results: mx2.example.org; dmarc=pass header.from=external.test`
    - `Authentication-Results: example.org; dmarc=pass header.from=external.test`
  - **C, local, forged:** like A, but carrying B's three forged headers.
  - **D, external, plain:** like B, with no Authentication-Results. If port 25 refuses B and D, retry them unauthenticated on `smtp://127.0.0.1:1025` and say which port took them.
- [ ] **Step 3: Read what bob received.** Take bob's mail account id from the session. Then run `Email/query` (sorted by `receivedAt`, descending, limit 10), and an `Email/get` that chains on its ids with these properties: `subject`, `header:Authentication-Results:asText:all`, `header:Received:asText:all`.
  - POST to `http://127.0.0.1:8025/jmap/`, or to the `apiUrl` path on port 8025 if that differs.
  - Record each message's headers in order.
- [ ] **Step 4: Answer (a)-(c).**
  - **(a) The id it stamps, and where it comes from.** The authserv-id of the topmost Authentication-Results on A, B and D (`authservIdOf` rules). Does it equal `serverHostname` (`mail.example.org`)? Then confirm the id follows that setting:
    1. Change the copy's `plan-bootstrap.ndjson` `serverHostname` to `mx.probe.test`.
    2. `docker compose down -v && docker compose up -d --build --wait stalwart`.
    3. Resend D, and check that the id is now `mx.probe.test`.
    4. Record whether the session's `apiUrl` follows the same setting.
  - **(b) Stripping.** On B, which of the three forged headers survived: the exact own id, the sibling `mx2.example.org`, and the parent `example.org`?
  - **(c) Local submissions.** Did A and C get a header from Stalwart at all? If C has no stamp of Stalwart's own, is a forged header now its topmost Authentication-Results?
- [ ] **Step 5: Answer (d), the calendar rights.**
  1. As alice, `Principal/query` or `Principal/get` (`urn:ietf:params:jmap:principals`) to find bob's principal id. `Calendar/get` gives her default calendar id.
  2. For each rights set in turn, alice grants it with `Calendar/set` `update: { <cal>: { "shareWith/<bob>": <rights> } }`:
     - **read:** `{ mayReadFreeBusy, mayReadItems }`;
     - **readWrite:** read plus `mayWriteAll, mayWriteOwn, mayUpdatePrivate, mayRSVP`;
     - **manager:** readWrite plus `mayShare`;
     - **manager+delete:** manager plus `mayDelete`.
  3. Bob then:
     - refetches his session and records the `myRights` keys Stalwart reports on the calendar (is there a `mayAdmin`?);
     - sends `Calendar/set` in alice's account with `{ name: 'probe-<set>' }`, then a second one with `{ color: '#ff0000' }`;
     - records `updated` or the `notUpdated` type for each.
  4. After each set, alice reads `name` and `color`. Is bob's colour hers too, or kept per user?
- [ ] **Step 6: Apply the findings.**
  - `scopedCalendarActions` (today `edit: !r || !!r.mayShare || !!r.mayAdmin`):

    | Stalwart accepted the rename with | `edit` becomes |
    |---|---|
    | manager, not readWrite | unchanged |
    | readWrite | `!r \|\| !!r.mayShare \|\| !!r.mayAdmin \|\| !!r.mayWriteAll` |
    | only manager+delete | `!r \|\| !!r.mayDelete \|\| !!r.mayAdmin` |
    | none of them | `!r` (a server that sends rights never offers it) |

    - Update the test at `managed-scope.test.ts:90` to the row that applies, with one case per rights set from Step 5.
    - Rewrite the comment to cite "checked on Stalwart 0.16.25, 2026-10-10", and say whether recolouring is per user there.
    - If the gate is unchanged, the test still gets the readWrite case (`edit: false`) so the check is pinned.
  - `authserv.ts` comments:
    - If (b) shows the exact id stripped, say so in `pinAuthenticationResults`'s RFC 8601 §5 paragraph, with the version.
    - If (b) and (c) together let a local user forge a pass (no stamp on C, and a forged header topmost), the comment says that plainly. It names it as the case the exact-id setting does not close.
  - Exact-authserv-id verdict:
    - **not needed:** (a)'s id is `serverHostname` and follows it, so a default single-host install pins with no setting (the JMAP host is that host, or a host under its registrable domain).
    - **needed:** the id is anything else (a fixed string, the container's own hostname, a separate setting that doesn't default to `serverHostname`).
    - A deployment that serves JMAP on another domain than its MX is the known limit already on the roadmap. It is not by itself a reason to build Task 2.
- [ ] **Step 7: Tear down.** `docker compose down -v` in the copy, then `rm -rf $SCRATCH/stalwart-probe`. Report the raw headers of A-D and the Step 5 table in your report.
- [ ] **Step 8: Write the roadmap block, run the gate, and commit** the roadmap, `managed-scope.ts`, its test and `authserv.ts`. Message: `fix: gate shared calendar renames on the rights Stalwart checks, and record how it stamps sender checks`. If the gate is unchanged, use `docs: record how Stalwart stamps sender checks and which rights rename a shared calendar`.

### Task 2 (conditional): An optional exact mail server name per account

Size **M**. Built only when Task 1's block reads `Exact authserv-id setting: needed`. Otherwise skip it: make no commit, and report "skipped: <Task 1's reason>" for Task 8.

**Files:**
- Modify: `src/stores/account-store.ts:7-27` (`AccountEntry.authservId?: string`). `addAccount` already keeps an existing entry's fields.
- Modify: `src/lib/authserv.ts` (add `normalizeAuthservId`, `authservPinOf`; `isTrustedAuthservId` reads an exact pin).
- Modify: `src/lib/authserv-host.ts` (`authservHostIn` uses `authservPinOf`).
- Modify: `src/components/settings/AccountSettings.tsx` (a row under "JMAP Server", `:131`).
- Modify: `locales/rn/*.json` via `npm run i18n:harvest` (three keys).
- Test: `src/lib/__tests__/authserv.test.ts`, `authserv-host.test.ts`, `sender-check.test.ts`.
- Shares: `authserv.ts` (Task 1), `locales/rn/*.json` (Task 7).

**Interfaces:**
- Consumes: Task 1's verdict line.
- Produces:
  - `normalizeAuthservId(input: string): string | null | 'invalid'`. Trimmed, lowercased, with the trailing dot dropped. Empty gives `null` (the setting is cleared). The result must match `AUTHSERV_ID_RE` and be at most 253 characters, else `'invalid'`.
  - `authservPinOf(serverUrl: string | null | undefined, authservId: string | null | undefined): string | null`.
    - With a set id, `'=' + id`.
    - Else `serverHostOf(serverUrl)`, or null when that host starts with `=`.
    - The `=` prefix marks an exact pin. No host contains it, so every caller of `authservHostFor`/`useAuthservHost` keeps its `string | null` parameter unchanged.
  - `isTrustedAuthservId(authservId, pin)`: a pin starting with `=` trusts only `authservId === pin.slice(1)`. Every other pin keeps today's rule.
  - `authservHostFor(appAccountId)` and `useAuthservHost(appAccountId)` return `authservPinOf(entry.serverUrl, entry.authservId)` for that app account's own entry. Their comments say "pin" from here on.
  - The AccountSettings row: label `t('settings.account.authserv_id.label', 'Mail server name')`.
    - Description: `t('settings.account.authserv_id.description', 'The name your mail server writes in the Authentication-Results header, if it isn\'t on {host}. Leave empty to use {host}.', { host })`.
    - Error: `t('settings.account.authserv_id.invalid', 'Enter a host name, such as mx.example.com')`.
    - It edits the account shown when the screen opened. On save it writes `updateAccount(id, { authservId })` only while `useAccountStore.getState().activeAccountId === id`; otherwise it writes nothing and shows the existing account-changed error. An empty field clears the setting (`authservId: undefined`).

- [ ] **Step 1: Write the failing tests.**

```ts
it('trusts only the exact mail server name once one is set', () => {
  const pin = authservPinOf('https://jmap.example.com', 'mx.mailhost.example')!;
  expect(pin).toBe('=mx.mailhost.example');
  expect(isTrustedAuthservId('mx.mailhost.example', pin)).toBe(true);
  expect(isTrustedAuthservId('jmap.example.com', pin)).toBe(false);
  expect(isTrustedAuthservId('mx2.mailhost.example', pin)).toBe(false);
  expect(authservPinOf('https://jmap.example.com', undefined)).toBe('jmap.example.com');
  expect(authservPinOf('https://=evil/', undefined)).toBeNull();
});
it('normalises the mail server name and refuses what is no host name', () => {
  expect(normalizeAuthservId('  MX.Example.COM. ')).toBe('mx.example.com');
  expect(normalizeAuthservId('   ')).toBeNull();
  for (const bad of ['mx example.com', 'mx;x', '"mx"', 'a'.repeat(254)]) expect(normalizeAuthservId(bad)).toBe('invalid');
});
// authserv-host.test.ts
it('reads each account\'s own mail server name, never another account\'s', () => {
  // A: serverUrl https://a.example, authservId 'mx.a-mail.example'; B: serverUrl https://b.example
  expect(authservHostFor('A')).toBe('=mx.a-mail.example');
  expect(authservHostFor('B')).toBe('b.example');
});
// sender-check.test.ts
it('passes a message stamped by the configured mail server name on another domain', () => {
  // headers: 'mx.a-mail.example; dmarc=pass header.from=bank.example', pin '=mx.a-mail.example'
  expect(deriveHeaderInfo(email, '=mx.a-mail.example').senderVerification).toBeNull();
});
```

- [ ] **Step 2: Run them and confirm they fail.** Run `npx vitest run src/lib/__tests__/authserv.test.ts src/lib/__tests__/authserv-host.test.ts src/lib/__tests__/sender-check.test.ts`.
- [ ] **Step 3: Implement the helpers, the entry field and the row, then run `npm run i18n:harvest`.**
- [ ] **Step 4: Run the gate, and the three files on Node 20.** Expected: PASS. Every existing pinning test passes unchanged.
- [ ] **Step 5: Commit** `feat: let an account name its mail server, so sender checks work when the server stamps another domain`.

### Task 3: Finish an interrupted sign-out cleanup after an app kill

Size **L**. It closes three ledger items:
- the durable forget-pending marker;
- a restart that overlaps a second sign-in holding no record;
- the shared-cleanup record that a non-last sign-out leaves parked.

**Files:**
- Create: `src/stores/forget-pending.ts`.
- Create: `src/stores/__tests__/forget-pending.test.ts`.
- Modify: `src/stores/auth-store.ts`:
  - the cleanup machinery (`:276-431`: `SHARED_CLEANUP`, `PendingCleanup`, `startCleanup`, `settlePendingCleanup`, `forgetSignedOut`, `forgetSharedAfterLast`, `forgetSharedSignedOut`, `evictAccount`);
  - `logoutAll` (`:1087-1122`);
  - `restoreSession` (`:1261`, after the orphan sweep at `:1296-1301`).
- `src/stores/account-data-cleanup.ts`: read it; change it only if a step's guard needs it, and say why in your report. `forgetAccountData`'s signature stays.
- Test: `src/stores/__tests__/auth-store-cleanup-race.test.ts` (every existing case must pass unchanged), `account-data-cleanup.test.ts`.
- Shares: `auth-store.ts` (Tasks 4, 6).

**Interfaces:**
- Produces:
  - In `forget-pending.ts` (AsyncStorage only, no store import):
    - `SHARED_CLEANUP = '\u0000shared'`, moved here from auth-store, which imports it.
    - `FORGET_PENDING_KEY = 'auth:forgetPending:v1'`.
    - The entry type:
      ```ts
      type ForgetPendingEntry =
        | { key: string; kind: 'signOut'; serverUrl?: string | null; username?: string | null; discardQueuedSends?: boolean; withShared: boolean }
        | { key: string; kind: 'evict'; serverUrl?: string | null; username?: string | null }
        | { key: typeof SHARED_CLEANUP; kind: 'shared' };
      ```
    - `readForgetPending(): Promise<ForgetPendingEntry[]>`. Unreadable JSON, a non-array, or an entry with no string `key` or an unknown `kind` reads as nothing (logged once). It never throws.
    - `markForgetPending(entry: ForgetPendingEntry): Promise<void>`. Upserts by `key`.
    - `clearForgetPending(key: string): Promise<void>`.
    - Writes run one at a time, on a module promise chain, each reading the row afresh, so two calls never lose each other's change.
  - In `auth-store.ts`:
    - `startCleanup(entry: ForgetPendingEntry): Promise<void>` replaces `startCleanup(key, run)`. `cleanupRun(entry): CleanupRun` maps each kind to today's body:
      - **signOut:** `forgetAccountData` with `discardQueuedSends`, then `forgetSharedAfterLast()` when `withShared` and `stillGone()`;
      - **evict:** `evictAccount`'s guarded `deleteIdToken` and `clearStoredRelayBaseUrl`, `forgetAccountData`, then the shared step;
      - **shared:** `forgetSharedData`.
      - `logoutAll`'s per-account cleanups pass `withShared: false`, since it runs `forgetSharedSignedOut` itself.
    - `PendingCleanup` gains `entry: ForgetPendingEntry`, so a re-run restarts from it.
    - The run's first action is `markForgetPending(entry)`, waited for at most `FORGET_MARK_TIMEOUT_MS = 2000` and logged on failure. The steps run either way. Every caller already cleared the credentials before `startCleanup`, so the marker is written after them.
    - `signInsUnderWay: number`, a module counter. `settlePendingCleanup` increments it before it awaits anything; its release decrements it once.
    - `stillGone`: `gone = record.returning === 0 && !isRegistered(key)`.
      - When not gone, `record.skipped = true` only while `record.returning > 0 || signInsUnderWay > 0`.
      - A skip with no sign-in under way means a settled account is registered under the key. Nothing is left to forget then, so it is not re-run later.
    - At the end of a run (the `finally`):
      - **Held** (`returning > 0`): the record stays in the map, ended. A sign-in that starts later finds it and holds it too. The last release decides.
      - **Parked** (`skipped`, `returning === 0`): stays, marker kept, as today.
      - **Otherwise:** deleted from the map. Its marker is cleared, but only if no other record for the key is in the map by then.
    - The release, when a record's `returning` reaches 0:
      - `skipped` and the key unregistered: `startCleanup(record.entry)` (the marker stays);
      - else, if the run has ended: delete the record if it is still the map's, and clear the marker under the same rule.
      - The "parked ones this sign-in never held" loop stays.
    - `resumeForgetPending(): Promise<void>`, module-private, called by `restoreSession` after the orphan sweep and before it picks `target`.
      - It does nothing unless `useAccountStore.persist.hasHydrated()`.
      - It reads the markers, waiting at most `EVICTION_CLEANUP_TIMEOUT_MS`.
      - For each entry:
        - key registered (for `SHARED_CLEANUP`: any account registered): `clearForgetPending(key)`;
        - else, with no record for the key in the map: `void startCleanup(entry)`, not awaited.
      - Never throws.
    - `resetCleanupMemoryForTests(): void`, exported. It clears `pendingCleanups` and `signInsUnderWay`, as an app kill does, and leaves storage alone.

- [ ] **Step 1: Write the failing tests.**

```ts
// forget-pending.test.ts
it('keeps one entry per key, and reads a corrupt row as nothing', async () => {
  await markForgetPending({ key: 'A', kind: 'signOut', withShared: true });
  await markForgetPending({ key: 'A', kind: 'evict' });
  await markForgetPending({ key: SHARED_CLEANUP, kind: 'shared' });
  expect(await readForgetPending()).toEqual([{ key: 'A', kind: 'evict' }, { key: SHARED_CLEANUP, kind: 'shared' }]);
  await AsyncStorage.setItem(FORGET_PENDING_KEY, '{not json');
  expect(await readForgetPending()).toEqual([]);
});
it('loses neither of two writes made back to back', async () => {
  await Promise.all([markForgetPending({ key: 'A', kind: 'evict' }), markForgetPending({ key: 'B', kind: 'evict' }), clearForgetPending('A')]);
  expect((await readForgetPending()).map((e) => e.key)).toEqual(['B']);
});
// auth-store-cleanup-race.test.ts (helpers leftBehind / expectAllForgotten / hangFirstStep as today)
it('finishes a cleanup the app was killed in, at the next cold start', async () => {
  await leftBehind(); hangFirstStep();
  const out = useAuthStore.getState().logout({ discardQueuedSends: true });
  await vi.advanceTimersByTimeAsync(EVICTION_CLEANUP_TIMEOUT_MS); await out;
  expect(await readForgetPending()).toContainEqual(expect.objectContaining({ key: ID, kind: 'signOut', discardQueuedSends: true }));
  resetCleanupMemoryForTests();                 // the kill: memory gone, storage kept
  await useAuthStore.getState().restoreSession();
  await vi.advanceTimersByTimeAsync(60_000);
  await expectAllForgotten();
  expect(await readForgetPending()).toEqual([]);
});
it('drops the marker of an account signed back in before the kill, and forgets nothing', async () => {
  await markForgetPending({ key: ID, kind: 'signOut', withShared: true }); // ID is registered (beforeEach)
  await leftBehind();
  resetCleanupMemoryForTests();
  await useAuthStore.getState().restoreSession();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(await AsyncStorage.getItem(`${IDENTITY_CACHE_PREFIX}${ID}`)).not.toBeNull();
  expect(await readForgetPending()).toEqual([]);
});
it('leaves the markers alone when the account registry has not loaded', async () => {
  useAccountStore.setState({ accounts: [] });
  vi.spyOn(useAccountStore.persist, 'hasHydrated').mockReturnValue(false);
  await markForgetPending({ key: ID, kind: 'signOut', withShared: true }); await leftBehind();
  await useAuthStore.getState().restoreSession(); await vi.advanceTimersByTimeAsync(60_000);
  expect(await AsyncStorage.getItem(`${IDENTITY_CACHE_PREFIX}${ID}`)).not.toBeNull();
  expect(await readForgetPending()).toHaveLength(1);
});
it('never runs the cleanup between two overlapping sign-ins of the account', async () => {
  // logout with the first step hung; sign-in S1 (addAccount refuses once) starts, the step ends while S1 holds it,
  // S2 starts before S1 settles (connect held open), S1 fails, then S2 succeeds and the new session writes its data
  expect(await AsyncStorage.getItem(`${IDENTITY_CACHE_PREFIX}${ID}`)).not.toBeNull();
  expect(useSearchHistoryStore.getState().recentSearches).toEqual(['invoice']);
  expect(await readForgetPending()).toEqual([]);
});
it('runs it once afterwards when both overlapping sign-ins fail', async () => { /* as above, S2 refused → expectAllForgotten() */ });
it('leaves no shared cleanup parked after signing out one of two accounts', async () => {
  // two accounts registered; logout() of the active one, no sign-in under way
  await vi.advanceTimersByTimeAsync(60_000);
  expect((await readForgetPending()).map((e) => e.key)).toEqual([]);
  expect(useSearchHistoryStore.getState().recentSearches).toEqual(['invoice']); // the other account's
});
```

- [ ] **Step 2: Run them and confirm they fail.** Run `npx vitest run src/stores/__tests__/forget-pending.test.ts src/stores/__tests__/auth-store-cleanup-race.test.ts`. Expected: the module is missing, the cold-start cases leave data behind, and the overlap case loses a step.
- [ ] **Step 3: Implement `forget-pending.ts`, then the auth-store changes.** Comment the marker's lifecycle once, above `startCleanup`, beside the existing comment on holds and parking, and say why `restoreSession` waits for the registry. In `evictAccount`, `logout`, `logoutAll` and `removeAccount`, the order stays credentials, then registry, then cleanup.
- [ ] **Step 4: Run the gate.** Expected: PASS, with every existing `auth-store*` and `account-data-cleanup` test unchanged.
- [ ] **Step 5: Commit** `fix: finish forgetting a signed-out account after the app is killed mid-cleanup, and never run a cleanup between two sign-ins of it`.

### Task 4: Refresh push after a session refresh, and coalesce per key

Size **S**.

**Files:**
- Modify: `src/lib/session-retry.ts:68-92` (`coalesceByKey`).
- Modify: `src/lib/push-inbox-only.ts`. Add `gainedMailAccounts` and `resyncPushAfterSessionChange`.
- Modify: `src/stores/auth-store.ts:1414-1435` (`refreshSessionFor`).
- Test: `src/lib/__tests__/session-retry.test.ts`, `src/lib/__tests__/push-inbox-only.test.ts`, `src/stores/__tests__/auth-store-refresh-session.test.ts` (mock `../../lib/push-inbox-only`).
- Shares: `auth-store.ts` (Tasks 3, 6).

**Interfaces:**
- Consumes: `resyncPushNotifications`, `getStoredRelayBaseUrl`, `hasNotificationPermission` (`push-notifications.ts`), `markPushRenewed` (`push-renewal.ts`), `useEmailStore.getState().fetchMailboxes()`, `clientServesAccount`.
- Produces:
  - `coalesceByKey`: one `Flight` slot per key, in a `Map<K, Flight>`. A call for another key starts its own flight and never drops the first key's. Within a key, today's join and one-re-run rules hold. A key's slot is deleted when its last flight settles with no re-run queued.
  - `gainedMailAccounts(prev: JMAPSession | null, next: JMAPSession): boolean`. True when `next.accounts` has an id whose `accountCapabilities` holds `urn:ietf:params:jmap:mail` and that `prev?.accounts` lacks.
  - `resyncPushAfterSessionChange(appAccountId: string): Promise<void>`. Never throws (logged).
    1. It awaits `fetchMailboxes()` (it joins the share presenter's load through `coalesceRefresh`), so the filter is built from a folder list that names the new account.
    2. Then, only while `clientServesAccount(appAccountId)`, email notifications are on, a relay is stored for the account and permission is granted, it runs `resyncPushNotifications({ relayBaseUrl, accountLabel })`, then `markPushRenewed(appAccountId)`.
  - `refreshSessionFor`: reads `before = get().session` before the fetch. After `set({ session: fresh })`, when `gainedMailAccounts(before, fresh)`, it calls `void resyncPushAfterSessionChange(appAccountId)`. A refresh that returns false never resyncs.

- [ ] **Step 1: Write the failing tests.**

```ts
// session-retry.test.ts
it('keeps one key\'s flight while another key runs', async () => {
  const resolvers: Record<string, Array<(v: number) => void>> = { a: [], b: [] };
  const fn = vi.fn((k: string) => new Promise<number>((r) => { resolvers[k].push(r); }));
  const run = coalesceByKey(fn);
  const a1 = run('a'); void run('b'); const a2 = run('a');
  expect(fn.mock.calls.map(([k]) => k)).toEqual(['a', 'b']);   // a2 joined a1, no second 'a' yet
  resolvers.a[0](1); expect(await a1).toBe(1);
  await vi.waitFor(() => expect(fn).toHaveBeenCalledTimes(3));  // a2's one re-run
  resolvers.a[1](2); expect(await a2).toBe(2);
});
// push-inbox-only.test.ts
it('notices a mail account the refreshed session gained, and nothing else', () => {
  expect(gainedMailAccounts(session({ me: [MAIL] }), session({ me: [MAIL], team: [MAIL] }))).toBe(true);
  expect(gainedMailAccounts(session({ me: [MAIL], team: [MAIL] }), session({ me: [MAIL] }))).toBe(false);
  expect(gainedMailAccounts(session({ me: [MAIL] }), session({ me: [MAIL], cal: [CALENDARS] }))).toBe(false);
});
it('resyncs push after the folders load, only while the client still serves the account', async () => {});
it('does not resync while email notifications are off, or with no relay stored', async () => {});
// auth-store-refresh-session.test.ts
it('resyncs push once when the refreshed session names a new mail account', async () => {
  expect(resyncPushAfterSessionChange).toHaveBeenCalledWith(ACTIVE);
});
it('does not resync push when the refreshed session has the same accounts, or the refresh was overtaken', async () => {});
```

- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.** In `push-inbox-only.ts`, the comment says why the folder load comes first: `buildEmailPushConfig` reads the loaded folder list, and an account missing from it gets the server's unfiltered fallback.
- [ ] **Step 4: Run the gate.** Expected: PASS. The two existing `coalesceByKey` tests pass unchanged.
- [ ] **Step 5: Commit** `fix: apply the push filter to a newly shared account straight after the session refresh, and keep one account's session refresh while another's runs`.

### Task 5: Held sends from before the attempt mark, and the folder snapshot tuck

Size **S**. Two store fixes. Their files share nothing with Tasks 3, 4 and 6.

**Files:**
- Modify: `src/stores/send-queue-store.ts`:
  - `QueuedSend` (`:80-110`), adding `schema?: 2`;
  - `hydrateAccount` (`:270-295`);
  - `enqueue` (`:297`).
- Modify: `src/stores/email-store.ts:1317-1395` (`selectMailbox`).
- Test: `src/stores/__tests__/send-queue-store.test.ts`, `src/lib/__tests__/send-queue-replay.test.ts` (fixtures only), `src/lib/__tests__/queue-restamp.test.ts` (unchanged), `src/stores/__tests__/email-store.test.ts`.
- Shares: nothing.

**Decision: mark every stored row from before this change as attempted.**
- No signal can pick out the risky rows. The user's Retry (`requeue`) clears `lastError`, `attemptStartedAt` and `heldReason`, and there is no status history. A row from before 6161666 that was sent once, failed and was retried therefore looks exactly like one never tried.
- Moving such a row to another account could send it twice, or from the wrong account. Marking it costs very little: `everAttempted` blocks only `restamp`. `releaseHold` reads `attemptStartedAt` alone, so a held, never-tried row from then still goes out when the session serves its own account again.
- The worst case is that a row whose account was renumbered waits for the user's Retry instead of moving by itself.
- Rows written between 6161666 and now get the mark too. They can't be told apart from older ones, and the cost is the same.

**Interfaces:**
- Produces:
  - `QueuedSend.schema?: 2`. `enqueue` stamps it, and every transition keeps it (they spread the entry).
  - `hydrateAccount`: a parsed row with no `schema` becomes `{ ...row, everAttempted: true, schema: 2 }`. It goes through the same write-back as the `sending` → `uncertain` repair, one `setItem` per row covering both changes, and a failed write rejects the hydrate with memory unchanged, as that repair does.
  - `selectMailbox`: the tuck is computed from `get()` at the `set`, after any await, never from the state read at the start.
    - The tuck covers the folder shown at that moment (`now.currentMailboxId`), if it is not `mailboxId` and `now` is a base view.
    - It goes on top of `now.mailboxSnapshots`, so a snapshot written for another folder during the await is kept.
    - `incoming` and the seed decision still come from the start; the cache read only happens when there was no snapshot.

- [ ] **Step 1: Write the failing tests.**

```ts
// send-queue-store.test.ts
it('marks a row stored before the attempt mark as attempted, and writes it back', async () => {
  await AsyncStorage.setItem(row('a1', 'q1'), JSON.stringify(entry({ heldReason: 'account_unavailable' })));  // no schema
  await useSendQueueStore.getState().hydrateAccount('a1');
  expect(mem('a1')[0]).toMatchObject({ everAttempted: true, schema: 2 });
  expect(await stored('a1', 'q1')).toMatchObject({ everAttempted: true, schema: 2 });
});
it('leaves a row enqueued now unmarked across a reload', async () => {
  await s.enqueue(input('q2')); await s.unloadAccount('a1'); await s.hydrateAccount('a1');
  expect(mem('a1')[0]).toMatchObject({ schema: 2 });
  expect(mem('a1')[0].everAttempted).toBeUndefined();
});
it('never re-stamps a row from before the mark, and still releases its hold', async () => {
  // stored: held account_unavailable, no schema, never attempted
  await expect(s.restamp('q1', 'jNew')).rejects.toBeInstanceOf(SendQueueStateError);
  await s.releaseHold('q1');
  expect(mem('a1')[0].heldReason).toBeUndefined();
});
// email-store.test.ts, in 'selectMailbox: hand picks and the cache-seed race'
it('tucks the folder as it is when the cache read ends, and keeps snapshots written meanwhile', async () => {
  // mb-1 shown with [e1]; mb-2 has no snapshot; getEmailsInMailbox held open
  const pick = useEmailStore.getState().selectMailbox('mb-2');
  useEmailStore.setState((s) => ({ emails: [e1, e2], totalEmails: 2, mailboxSnapshots: { ...s.mailboxSnapshots, 'mb-3': snap3 } }));
  releaseCacheRead(); await pick;
  const snaps = useEmailStore.getState().mailboxSnapshots;
  expect(snaps['mb-1'].emails.map((e) => e.id)).toEqual(['e1', 'e2']);
  expect(snaps['mb-3']).toEqual(snap3);
});
it('tucks nothing when a search started while the cache was read', async () => { /* searchQuery set mid-await → no mb-1 tuck */ });
```

- [ ] **Step 2: Run them and confirm they fail.** Existing fixtures that stand for rows written after this change gain `schema: 2`: the `restamp` describe and the re-stamp cases in `send-queue-replay.test.ts`. List each one you touch in your report.
- [ ] **Step 3: Implement.** Comment, at `schema`, why every older row counts as attempted (the decision above, in two lines).
- [ ] **Step 4: Run the gate.** Expected: PASS.
- [ ] **Step 5: Commit** `fix: never move a held send from before the attempt mark to another account, and keep a folder's latest list when switching folders`.

### Task 6: Retire the legacy shared-calendar colour key, one account at a time

Size **M**.

**Decision: migrate, but bounded.**
- The legacy key `accountId|originalId` names no app account, so every account reads it today. Stalwart's JMAP account ids are short and sequential, so two servers' shared calendars collide on it. That is a read across accounts, which the house rule forbids.
- A plain "claim at each account's next load" still lets an account added later pick up another account's colours. So only the accounts registered at the upgrade may claim legacy keys.
- Each of those accounts claims once, at its next full calendar load, and then reads only its own keys. When none is left, the legacy keys are deleted.
- A settings import stops writing legacy keys: it colours the shown account only.
- The cost: a shared calendar that isn't in the list at the claim (its account's load failed) gets a fresh colour later instead of its old one.

**Files:**
- Modify: `src/lib/calendar-color-keys.ts`. Add `isLegacyCalendarColorKey`, `readsLegacyCalendarColors`, `withoutLegacyCalendarColors`, `importedCalendarColors`.
- Modify: `src/lib/calendar-utils.ts:555-705`:
  - `sharedCalendarColorFor`, `applySharedCalendarColors`, `missingSharedCalendarColors`;
  - add `claimLegacyCalendarColors`.
- Modify: `src/stores/settings-store.ts`:
  - the `legacyCalendarColorReaders` field (`:281`, the default at `:464`, and `DEVICE_LOCAL_KEYS` at `:738`);
  - `forgetAccountCalendarColors` (`:945`);
  - `importSettings` (`:990`);
  - two new actions.
- Modify: `src/screens/CalendarScreen.tsx:395-418`, `src/components/settings/AboutDataSettings.tsx:162`.
- Modify: `src/stores/auth-store.ts`, `restoreSession`. One call, beside Task 3's `resumeForgetPending`.
- Test: `src/lib/__tests__/calendar-utils.test.ts`, `src/stores/__tests__/settings-store.test.ts`, `src/lib/__tests__/managed-scope.test.ts` (unchanged).
- Shares: `auth-store.ts` (Tasks 3, 4).

**Interfaces:**
- Produces:
  - In `calendar-color-keys.ts` (still importing nothing):
    - `isLegacyCalendarColorKey(key: string): boolean`: `key.split('|').length <= 2`.
    - `readsLegacyCalendarColors(readers: readonly string[] | null, appAccountId: string): boolean`. False for `''`. True when `readers` is null (not yet seeded) or holds the id.
    - `withoutLegacyCalendarColors(overrides): Record<string, string>`.
    - `importedCalendarColors(current, fromFile: Record<string, string>, appAccountId: string | null): Record<string, string>`.
      - Keeps `current` and writes each old-shape key in the file as `${appAccountId}|${key}` over it.
      - Ignores keys in the file with more parts.
      - Returns `current` unchanged without an `appAccountId`.
  - In `calendar-utils.ts`:
    - `sharedCalendarColorFor(overrides, appAccountId, cal, readsLegacy: boolean)` reads the legacy key only when `readsLegacy`, and nothing for `appAccountId === ''`.
    - `applySharedCalendarColors(calendars, overrides, appAccountId, readsLegacy: boolean)` and `missingSharedCalendarColors(calendars, loadedFor, overrides, appAccountId, readsLegacy: boolean)` pass it on. The parameter is required.
    - `claimLegacyCalendarColors(calendars: Calendar[], overrides: Record<string, string>, appAccountId: string): Record<string, string>`. For each shared calendar with a legacy override and no key of the account's own: new key → that colour.
  - In `settings-store.ts`:
    - `legacyCalendarColorReaders: string[] | null` (default null, device-local, never exported).
    - `seedLegacyCalendarColorReaders(appAccountIds: readonly string[]): void`. Only while the field is null: set it to the ids when any legacy key exists, else `[]`. Persisted.
    - `finishLegacyCalendarColors(appAccountId: string, claimed: Record<string, string>): void`. In one `set` and one persist: write `claimed`, remove the id from the readers, and drop every legacy key once the readers list is empty.
    - `forgetAccountCalendarColors` also removes the id from the readers, with the same drop when the list empties.
    - `importSettings(json: string, appAccountId: string | null = null)`. It stores `sharedCalendarColors` through `importedCalendarColors(current, file, appAccountId)` and never replaces the map with the file's. `AboutDataSettings` passes `useEmailStore.getState().activeAccountId`, as its export already does.
  - `restoreSession` calls `useSettingsStore.getState().seedLegacyCalendarColorReaders(ids)` with the registered ids, only when `useAccountStore.persist.hasHydrated()` and the settings store has hydrated.
  - `CalendarScreen`:
    - It computes `readsLegacy = readsLegacyCalendarColors(readers, calendarColorAccount(calendarsAppAccountId, shownAccountId))` and passes it to both helpers.
    - In the auto-assign effect, before `missingSharedCalendarColors`: when `calendarsAppAccountId === shownAccountId` and `readsLegacy`, it calls `finishLegacyCalendarColors(shownAccountId, claimLegacyCalendarColors(storeCalendars, sharedCalendarColors, shownAccountId))`.

- [ ] **Step 1: Write the failing tests.**

```ts
// calendar-utils.test.ts
const cal = { id: 'team:c1', originalId: 'c1', accountId: 'team', isShared: true, name: 'T' } as Calendar;
it('reads the legacy key only for an account still allowed to', () => {
  expect(sharedCalendarColorFor({ 'team|c1': '#00ff00' }, 'A', cal, true)).toBe('#00ff00');
  expect(sharedCalendarColorFor({ 'team|c1': '#00ff00' }, 'B', cal, false)).toBeUndefined();
  expect(sharedCalendarColorFor({ 'team|c1': '#00ff00' }, '', cal, true)).toBeUndefined();
});
it('claims legacy colours for the account\'s own shared calendars, never over its own key', () => {
  expect(claimLegacyCalendarColors([cal], { 'team|c1': '#00ff00' }, 'A')).toEqual({ 'A|team|c1': '#00ff00' });
  expect(claimLegacyCalendarColors([cal], { 'team|c1': '#00ff00', 'A|team|c1': '#111111' }, 'A')).toEqual({});
});
// settings-store.test.ts
it('lets only the accounts registered at the upgrade read legacy colours, then drops them', () => {
  s.setSharedCalendarColor('team|c1', '#00ff00');
  s.seedLegacyCalendarColorReaders(['A', 'B']);
  s.seedLegacyCalendarColorReaders(['A', 'B', 'C']);              // seeded once
  expect(get().legacyCalendarColorReaders).toEqual(['A', 'B']);
  s.finishLegacyCalendarColors('A', { 'A|team|c1': '#00ff00' });
  expect(get().sharedCalendarColors['team|c1']).toBe('#00ff00');   // B has not claimed yet
  s.finishLegacyCalendarColors('B', {});
  expect(get().sharedCalendarColors).toEqual({ 'A|team|c1': '#00ff00' });
  expect(get().legacyCalendarColorReaders).toEqual([]);
});
it('seeds nobody when there is no legacy colour', () => { /* no legacy key → [] */ });
it('imports a file\'s colours for the shown account only, keeping other accounts\' colours', () => {
  s.setSharedCalendarColor('B|team|c1', '#222222');
  s.importSettings(JSON.stringify({ sharedCalendarColors: { 'team|c1': '#00ff00' } }), 'A');
  expect(get().sharedCalendarColors).toEqual({ 'B|team|c1': '#222222', 'A|team|c1': '#00ff00' });
});
it('never exports or imports the legacy readers list', () => {});
it('forgetting an account takes it off the readers list', async () => {});
```

- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.** Rewrite the `legacySharedCalendarColorKey` comment for the bounded rule. The comment in `exportableCalendarColors` that says an import stores the file's keys as old keys changes to "as the shown account's".
- [ ] **Step 4: Run the gate.** Expected: PASS. Existing colour tests change only where they now pass `readsLegacy`; list them in your report.
- [ ] **Step 5: Commit** `fix: stop one account's old shared calendar colours showing on another's calendars, and import colours for the shown account only`.

### Task 7: Tooling: the font guard, the public suffix list's age and the shadowed overlay key

Size **S–M**. Three small items. Each step says which one it is for.

**Files:**
- Modify: `src/theme/__tests__/font-literals.test.ts`.
- Create: `scripts/psl-age.js` (CommonJS, like `scripts/babel-plugin-lucide-imports.js`).
- Create: `src/lib/__tests__/psl-age.test.ts`.
- Modify: `package.json` (`"deps:psl-age": "node scripts/psl-age.js"`).
- Modify: `README.md`, "Run locally" (`:129-139`), one line.
- Modify: all 27 `locales/rn/*.json`. Delete `settings.themes.default_name`.
- Modify: `src/components/settings/ThemesSettings.tsx:39`, `src/screens/SettingsScreen.tsx:254`. The fallback becomes `'Default'`.
- Test: `src/i18n/__tests__/rn-overlays.test.ts`.
- Shares: `README.md` (Task 8), `locales/rn/*.json` (Task 2), `package.json`.

**Interfaces:**
- Produces:
  - **Font guard.** `fontSizeOffenders(): string[]` (in the test file) walks `App.tsx` and `src`, skipping `__tests__` and `theme`.
    - It flags a `fontSize` property (an assignment or a shorthand) whose value is not one of these:
      - a `fontPx(…)` call;
      - `typography.<key>.fontSize`;
      - a conditional whose two branches are each allowed.
    - Each entry reads `path:line`.
    - The allow-list, with a reason each:
      - `src/widgets/`: home-screen widgets render as RemoteViews, outside the app's font setting;
      - `src/components/SenderAvatar.tsx`: the initials are sized to the avatar circle;
      - `src/stores/settings-store.ts`: the Appearance setting named `fontSize`, not a style.
    - `fontSizeLiterals` uses the same allow-list in place of skipping `widgets`.
  - **PSL age.** `scripts/psl-age.js` exports `pslAge({ installed, times, now }: { installed: string; times: Record<string, string>; now: Date }): { installed: string; published: string | null; ageDays: number | null; latest: string | null; latestPublished: string | null }`.
    - `times` is `npm view tldts time --json`.
    - `latest` is the newest stable version by publish time, skipping `created`, `modified` and prereleases.
    - Run directly, it reads the installed version from `node_modules/tldts/package.json`, runs `npm view tldts time --json` (`execFileSync`, 20 s timeout) and prints one line: `tldts <v>, public suffix list as of <date> (<n> days); latest <v> of <date>`.
    - `--check` exits 1 when the age exceeds `PSL_MAX_AGE_DAYS = 90`. An unreachable registry prints why and exits 2.
    - tldts ships no list date of its own. Its publish date is the list's, since each tldts release regenerates the list.
  - **README line:** "Before a release, run `npm run deps:psl-age`. The sender check's public suffix list ships inside tldts; update tldts when the list is over 90 days old."
  - **Overlay key.** The default theme card reads webmail's `settings.themes.default_name` in every language ("Default", "Standard", …) instead of the overlay's "Bulwark".

- [ ] **Step 1 (all three): Write the failing tests.**

```ts
// font-literals.test.ts
it('takes every fontSize from fontPx or typography outside the allow-list', () => {
  expect(fontSizeOffenders()).toEqual([]);
});
it('flags a computed or shorthand fontSize, and allows fontPx and typography', () => {
  expect(offendersIn('a.tsx', 'const s = { fontSize: size }; const t = { fontSize };')).toHaveLength(2);
  expect(offendersIn('a.tsx', 'const s = { fontSize: fontPx(13), a: { fontSize: typography.body.fontSize }, b: { fontSize: big ? fontPx(14) : fontPx(13) } };')).toEqual([]);
});
// psl-age.test.ts
it('dates the installed list by its tldts release and names the latest stable one', () => {
  const times = { created: '2020-01-01T00:00:00Z', modified: '2026-10-08T00:00:00Z', '7.4.18': '2026-09-01T00:00:00Z', '7.5.0': '2026-10-01T00:00:00Z', '7.6.0-beta.1': '2026-10-08T00:00:00Z' };
  expect(pslAge({ installed: '7.4.18', times, now: new Date('2026-10-10T00:00:00Z') }))
    .toEqual({ installed: '7.4.18', published: '2026-09-01T00:00:00Z', ageDays: 39, latest: '7.5.0', latestPublished: '2026-10-01T00:00:00Z' });
  expect(pslAge({ installed: '0.0.1', times, now: new Date() }).ageDays).toBeNull();
});
// rn-overlays.test.ts, inside the per-language loop
it(`${code} overlay shadows no key the vendored webmail catalog ships`, () => {
  expect([...flatten(overlay(code)).keys()].filter((k) => webKeys(code).has(k))).toEqual([]);
});
```

- [ ] **Step 2: Run them and confirm they fail.** Expected:
  - the offender list holds `src/components/SenderAvatar.tsx:102` and the two `settings-store.ts` lines before the allow-list exists;
  - `psl-age.js` is missing;
  - 27 overlays shadow `settings.themes.default_name`.
- [ ] **Step 3: Implement.** Remove the key from each overlay with a script that keeps each file's formatting (2-space JSON, trailing newline). Then:
  - run `npm run deps:psl-age` and paste its line into your report;
  - run `node scripts/sync-locales.mjs --check --from /tmp/webmail/locales`. Expected: no shadow notice.
- [ ] **Step 4: Run the gate.** Expected: PASS.
- [ ] **Step 5: Commit** `fix: catch computed font sizes that skip the font setting, report the public suffix list's age, and name the default theme as webmail does`.

### Task 8: Record what was done and what is left

Size **S**. It runs after every other task and after the final branch review.

**Files:**
- Modify: `docs/superpowers/plans/2026-10-04-webmail-parity-roadmap.md`, `CHANGES.md`, `README.md`.

**Interfaces:**
- Consumes:
  - `git log --oneline c18c785..HEAD`;
  - Task 1's `### Stalwart checks` block;
  - Task 2's outcome (built, or "skipped: <reason>");
  - each implementer's report.

- [ ] **Step 1: Mark the done items** in the Follow-up cleanup 1 "Left open" list. Append `— done in <hash>`, or:
  - "Stalwart must stamp … unverified": `— checked in <Task 1 hash>: <one line from the block>`.
  - "A configured exact authserv-id is an option": `— built in <hash>`, or `— not needed on Stalwart (<reason>), <Task 1 hash>`.
  - Sidebar apps' inline mode: `— closed: a deliberate difference. Sidebar apps open in the in-app browser only, so no third-party page runs inside the app's view (decision, 2026-10-10)`.
  - The shared-account calendar rename gate: `— checked against Stalwart 0.16.25 in <hash>`.
  - 41ab162: `— history: #17 merged it as is`.
- [ ] **Step 2: Complete `## Follow-up cleanup 2 (2026-10-10)`** under Task 1's block, in the Follow-up cleanup 1 shape ("What's new for users", then "Left open"). Left open:
  - every device check still listed;
  - the upstream requests, plus any Task 1 found (for example, Stalwart not stripping or not stamping);
  - shared-account sending and the 8 blocked parity items;
  - the sender-check limits that still hold after Task 1;
  - any reviewer follow-ups.
- [ ] **Step 3: Update `CHANGES.md`.**
  - Add `## Follow-up cleanup 2 (unmerged)` above Follow-up cleanup 1, with `Branch \`cleanup/follow-ups-2\`, everything after c18c785.`
  - Give it `### Improvements` and `### Fixes` bullets with short hashes, in the existing style.
  - Follow-up cleanup 1 is merged now: drop its "(unmerged)", and update the opening paragraph's description and commit counts.
- [ ] **Step 4: Update `README.md`.**
  - `:82` "Sidebar apps that open web links" becomes "Sidebar apps that open web links in the in-app browser".
  - If Task 2 was built, `:38` adds "or the mail server name you set for the account".
  - Change nothing else unless a claim is now wrong. Task 7's line stays.
- [ ] **Step 5: Commit.** Run `git add` on the three paths explicitly, then commit `docs: record follow-up cleanup 2 and what is left`.

---

## Self-review

1. **Spec coverage.**

   | Item | Task |
   |---|---|
   | Stalwart (a) authserv-id and its source, (b) stripping, (c) local stamping, (d) rename/recolour rights | 1 |
   | Gates and comments from the findings | 1 (managed-scope, authserv comments) |
   | Conditional exact authserv-id | 2, gated on Task 1's verdict line |
   | Durable forget-pending marker, holds, `stillGone`, credentials first | 3 |
   | A restart overlapping a second sign-in with no record | 3 (records stay while held; the last release decides) |
   | Parked shared record after a non-last sign-out | 3 (a skip with no sign-in under way doesn't park) |
   | Held sends from before 6161666 | 5 (mark all, justified) |
   | Detached push and a new shared account | 4 (`refreshSessionFor` → resync after the folder load) |
   | `coalesceByKey` per-key slots | 4 |
   | `selectMailbox` tuck after the await | 5 |
   | Font guard for non-literal `fontSize` | 7 |
   | PSL age script and docs line | 7 |
   | Legacy calendar colour key | 6 (bounded migration, justified) |
   | `settings.themes.default_name` overlay | 7 |
   | Sidebar apps' inline mode (decision 1) | 8 records it |
   | Docs: roadmap, CHANGES, README | 8 (and Task 1's block, Task 7's line) |

2. **Step scan.** Each step names its files, signatures, values or commands.
   - Task 1's open outcomes are tables or verdict lines, not judgement left to the implementer.
   - Line numbers are from `c18c785`. Tasks 4 and 6 run after Task 3, which moves `auth-store.ts` lines.
3. **Type consistency.**
   - `ForgetPendingEntry`, `SHARED_CLEANUP` and `startCleanup(entry)` (Task 3) are what Task 6's `restoreSession` call sits beside. Task 6 adds no cleanup.
   - `authservPinOf` (Task 2) is what `authservHostFor` returns, so `deriveHeaderInfo(email, serverHost)` keeps its signature.
   - `readsLegacy` is required in all three colour helpers (Task 6).
   - `resyncPushAfterSessionChange(appAccountId)` (Task 4) is the name the refresh-session test mocks.
4. **Review Focus.** Each line has a named test in its owning task:
   - 1: Task 3, "leaves the markers alone when the account registry has not loaded";
   - 2: Task 3, "drops the marker of an account signed back in before the kill";
   - 3: Task 3, the two overlapping sign-in tests;
   - 4: Task 5, "never re-stamps a row from before the mark, and still releases its hold";
   - 5: Task 6, the seeding test and the import test.
5. **Proportion.** About two thirds the length of the Follow-up cleanup 1 plan, for a similar number of items. Code blocks hold test names and assertions, plus one type.
