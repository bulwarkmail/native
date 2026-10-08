# Parity Phase 6d: Filters, Vacation and Files Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- Close the open area 07 items: vacation forwarding and reply audience, the redirect-limit and auto-reply-size warnings, Files deep links and the stability notice.
- Fix a live data risk: native leaves webmail's v2 filter scripts unprotected.
- Finish the device-check leftover: sending after an offline cold start.
- Make All-mail search include Sent (webmail 1.13.0).

**Architecture:**
- Sieve work ports webmail's pure modules (`period.ts`, `vacation-forward.ts`, `vacation-audience.ts`, `forward-limit.ts`) and extends the native parser and generator to round-trip metadata v2.
- The vacation store gains forward and audience state, and syncs the filters script on one connection scope.
- Files deep links reuse `pending-files-open` with a path-based target.
- The offline composer reads the JMAP account id that `applyConnectedState` records on each account entry.

**Tech Stack:** React Native / Expo, TypeScript, Zustand, vitest, JMAP (`SieveScript/*`, `VacationResponse/set`, `FileNode/get`, `Email/query`).

**Spec:**
- The open items in [07-filters-vacation-files.md](../../parity/07-filters-vacation-files.md).
- The device-check leftover in the roadmap's "Device check pass 1".
- User decisions, 2026-10-07:
  - legacy flat-name migration stays webmail-only;
  - the stability notice is a dismissible row;
  - include All-mail search over Sent;
  - the unverified-sender warning becomes an open item, not part of this phase.
- Webmail at `3d48b122` (1.13.0), cloned at `/tmp/webmail`, is the authority.
- Research with exact refs: `.superpowers/sdd/2026-10-07-parity-phase-6d-filters-files/research.md`. Each task names its section.

## Global Constraints

- **Branch:** `parity/phase-6d-filters-files`, from `main` at `f0f6209`.
- **Gate on every commit:** `npm run typecheck && npm test && npm run i18n:check`.
- **Strings:** `t('key', 'English fallback')` with webmail's key. Every key these tasks need is already vendored; RN-only keys go through `npm run i18n:harvest`.
- **Commits:** one per task, with the task's subject and the `Co-Authored-By:` and `Claude-Session:` trailers. Stage by explicit path, and never `git add -f` anything under `.superpowers`.
- **Parity docs:** do not edit `docs/parity/*.md` or `PARITY_CHECKLIST.md` in a task.
- **Tests:** vitest in node, with no RN render harness. Write tests first and record RED.
- **Accounts:** Stalwart ids repeat across accounts and servers.
  - Every multi-step read-then-write (Sieve read → generate → write; vacation set → filters sync) runs on one `OpScope` and passes `{ gen }` to every request.
  - A `StaleLoadError` aborts before any write.
  - Results that land after a switch are dropped.
- **Sieve safety:** the filters script is the one active script.
  - Never write a script the parser couldn't read back to the same rules, forward and audience.
  - A script the parser can't fully read stays opaque and is never rewritten.
  - Never write a forward address that fails validation.

## Review Focus

1. **A webmail v2 script survives a native save byte-for-byte**, including rule periods, the forward block and the audience include. A rule with a period never loses it, because losing it would make a forwarding rule forward forever. Owned by Task 1.
2. **Turning the auto-reply on from native never leaves Stalwart's vacation script active in place of the filters script.** If that script is opaque, the save refuses with an error instead. Owned by Task 2.
3. **A forward address is only ever written for the shown account, on its own connection.** A switch mid-save writes nothing. Owned by Tasks 2 and 4.
4. **A queued send made offline uses the JMAP account recorded for its own app account, or refuses.** Replay holds anything the session doesn't serve. Owned by Task 9.
5. **A Files link opens only the shown account's own folder or file.** Owned by Task 7.

## Not in this phase

- **Legacy flat-name migration for Files.** Webmail-only by decision; it is destructive and webmail runs it whenever Files is opened there.
- **The unverified-sender warning (webmail 1.13.0).** A new 03 item.
- **Webmail's browser tab titles.** Not applicable on mobile.

---

### Task 1: Read and write webmail's v2 filter scripts (rule periods)

Research section 0 and section 6 (b), (d) 6a.

**Files:**
- Create: `src/lib/sieve/period.ts`, `src/lib/sieve/vacation-forward.ts` and `src/lib/sieve/vacation-audience.ts`, ported verbatim from WEB `lib/sieve/`.
- Modify: `src/lib/sieve/types.ts`:
  - `FilterRule.activeFrom?` and `activeUntil?`;
  - `VacationForward`;
  - `VacationAudience`;
  - `FilterMetadata.version: 1 | 2`, plus `vacationForward?` and `vacationAudience?`.
- Modify: `src/lib/sieve/parser.ts`. Accept versions 1 and 2 with webmail's validity rules. An invalid period, forward or audience makes the script opaque. Strip the `# Vacation forwarding` block from external rules only when the forward is enabled. Return `vacationForward` and `vacationAudience`.
- Modify: `src/lib/sieve/generator.ts`. `GenerateOptions` gains `vacationForward` and `vacationAudience`. Write:
  - the period tests, as `allof(<period>, <conditions>)`, and drop a rule whose period is unusable;
  - the audience include around the vacation include;
  - the forward block after the vacation part and before every rule;
  - the requires;
  - version 2 when a rule has a period, or the forward is enabled, or an audience is set.

  `stripRuleForMetadata` keeps periods.
- Modify: `src/lib/filters/account-filters.ts`, `quick-rules.ts` and `retroactive.ts`, to pass the forward and audience through and keep webmail's `hasPeriod` exclusions.
- Test: port WEB `lib/sieve/__tests__/{period,vacation-forward,vacation-audience,generator-compat}.test.ts`. Add a byte-for-byte round trip of a script webmail 1.13.0 wrote, with periods, an enabled forward and an audience.

- [ ] **Step 1:** Write the failing tests, including the round trip and "an invalid period makes the script opaque".
- [ ] **Step 2:** Run them to verify they fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run them to verify they pass.
- [ ] **Step 5:** Commit `fix: read and keep webmail's v2 filter scripts, rule periods included`.

### Task 2: The vacation store reads and syncs forward and audience, on one connection

Research section 6 (b) Store, (d) 6b and (e). Depends on Task 1.

**Files:**
- Modify: `src/stores/filter-store.ts`.
  - Port `readVacationFilters(accountId, at)`, which returns `{includesVacation, forward, forwardAvailable, audience, audienceAvailable, notRunning, otherForwards}`.
  - Port `syncVacationWithFilters({ enabled, forward?, audience?, period? }, at)`.
    - Throw `OpaqueFiltersError` on an opaque script instead of returning silently.
    - Activate the filters script when `enabled || forwarding || it is already active`.
    - Create it if missing.
  - Fetches and saves keep the forward and audience.
- Modify: `src/stores/vacation-store.ts`.
  - Add `forward`, `forwardAvailable`, `audience`, `audienceAvailable`, `notRunning` and `otherForwards`.
  - Key state by app account plus managed account, using a store epoch.
  - `save()` does `VacationResponse/set`, then the sync, both on one `OpScope`. It throws `VacationFiltersError` when only the filters part failed.
  - A result that lands after a switch is dropped.
- Modify: `src/api/sieve.ts` and the vacation API, so each call takes the scope and passes `{gen}`.
- Test: store tests with a Sieve mock, ported from WEB `lib/filters/__tests__/sieve-mock.ts` and `vacation-forward.test.tsx`:
  - an opaque script makes `save()` refuse, and the vacation script is never left active alone;
  - a switch mid-save writes nothing;
  - A→B, both "own", is detected;
  - a forward that fails validation is never written.

- [ ] **Step 1:** Write the failing tests.
- [ ] **Step 2:** Run them to verify they fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run them to verify they pass.
- [ ] **Step 5:** Commit `fix: keep the filters running when the auto-reply is turned on, and sync forward and audience on one connection`.

### Task 3: Warn before saving an auto-reply Stalwart would refuse

Research section 5.

**Files:**
- Create: `src/lib/vacation-limits.ts`, with `STALWART_VACATION_LIMITS = { subject: 511, body: 2047 }`, `utf8Length`, and `vacationOversize({ subject, textBody, html }, limits | null)`.
- Modify: `src/components/settings/VacationSettings.tsx`. Derive the payload the way `handleSave` does, show `settings.vacation.warnings.subject_too_long` and `body_too_long` with `{max}`, and block Save. Limits apply only when the edited account has `urn:stalwart:jmap`.
- Test: multibyte text is counted in bytes; HTML over the limit with short text still counts as over; a server that isn't Stalwart has no limits.

- [ ] **Steps 1-5**, with commit `feat: warn before saving an auto-reply Stalwart would refuse as too long`.

### Task 4: Vacation forwarding and reply audience in Out of Office

Research section 6 (b) UI and (d) 6c. Depends on Tasks 2 and 3.

**Files:**
- Modify: `src/components/settings/VacationSettings.tsx`:
  - a Forwarding section: a switch, an email field and a keep-copy toggle;
  - a "Reply to" select (all, internal or external), offered only when `audienceAvailable`, when this is not a managed account, and when the shown account's identities give domains (`ownDomains`);
  - warnings `forward_address` (which blocks Save), `forward_limit` (`1 + otherForwards > maxNumberRedirects` when the forward is on with keep-copy) and `not_running`;
  - only changed forward or audience settings are sent;
  - a partial-failure alert for `VacationFiltersError`.
- Modify: `src/lib/settings-search.ts`: add `settings.vacation.forward` and `.audience`, and drop the comment saying they're absent.
- Test: pure helpers for the form, covering domains, `canNarrow`, the warnings and the changed-only payload, plus the i18n list.

- [ ] **Steps 1-5**, with commit `feat: forward mail and choose who gets the auto-reply while away`.

### Task 5: Respect the server's forward limit in filter rules

Research section 4. Depends on Task 2, for `inRunOrder` with the vacation forward.

**Files:**
- Create: `src/lib/filters/forward-limit.ts`, a port of WEB `lib/filters/forward-limit.ts`.
- Modify:
  - `src/components/settings/settings-section.tsx`: the `Select` option gets `disabled?`;
  - `FilterRuleModal.tsx`: props `maxRedirects`, `forwardsBefore` and `forwardsAfter`; the forward option is disabled at the limit, with a warning;
  - `FilterSettings.tsx`: the `tooManyForwards` banner and `forwardsAround`;
  - `RulesFlow.tsx`: read the account's rules, and drop the result if the target changed.

  Use the selected Sieve account's capabilities.
- Test: port `forward-limit.test.ts` and `forward-limit-vacation.test.ts`.

- [ ] **Steps 1-5**, with commit `feat: respect the server's forward limit in filter rules`.

### Task 6: Edit a rule's active period

Research section 6 (d) 6d. Depends on Task 1.

**Files:**
- Modify: `FilterRuleModal.tsx`, with from/until date-time fields using `settings.filters.period_*` keys (vendored), stored as ISO UTC through `period.ts` validation.
- Modify: `FilterSettings.tsx`, with scheduled, active and expired status pills (`periodStatus`).
- Test: pure helpers for the date fields to ISO and back, plus status.

- [ ] **Steps 1-5**, with commit `feat: give a filter rule an active period`.

### Task 7: Files links open a folder and preview a file

Research section 2.

**Files:**
- Modify: `src/navigation/linking.ts`: `{ kind: 'files'; path?: string[]; preview?: string; accountId?: string }`. A bare `/files` stays `{kind:'files'}`.
- Modify: `src/navigation/pending-files-open.ts`. Add a path-based target and `resolveFilesPath(nodes, segments, preview)`, which walks own nodes only and returns `'folder_missing'` for a missing folder.
- Modify: `src/screens/FilesScreen.tsx`. The consumer branches on the target type. Toasts: `deep_link.folder_not_found`, and `deep_link.file_not_found`, which still opens the folder.
- Test: linking parse cases, and `resolveFilesPath` (nested, a same-named file ignored, shared nodes ignored, missing folder and file).

- [ ] **Steps 1-5**, with commit `feat: open a Files link to its folder and file`.

### Task 8: A dismissible storage notice in Files

Research section 3.

**Files:**
- Modify: `src/screens/FilesScreen.tsx`. A compact row at the Files root shows `files.stability_warning`, with a close button.
- Modify: `src/stores/settings-store.ts`. Add `filesStabilityNoticeDismissed: boolean` (app-only, persisted, validated, default false).
- Test: settings store default and persistence.

- [ ] **Steps 1-5**, with commit `feat: show the Files storage notice once, until dismissed`.

### Task 9: Queue a send when the app started offline

Research section 7.

**Files:**
- Modify: `src/stores/auth-store.ts`. In `applyConnectedState`, record `jmapAccountId` on the account entry only while `clientServesAccount(accountId)`.
- Modify: `src/lib/composer-account.ts`. `composerOwnerAtMount` takes `recordedJmapAccountId`. Add `queueJmapAccountId(owner, { liveJmapAccountId, clientServesOwner, recorded })`, evaluated at send time.
- Modify: `ComposeScreen.tsx` (mount and send) and `QuickReplyBox.tsx`, to use it. With no id at all, keep today's refusal.
- Test:
  - the live id wins;
  - the recorded id is used offline;
  - another account's entry is never used;
  - nothing recorded gives a refusal;
  - `applyConnectedState` records only while serving;
  - offline enqueue gets the recorded id;
  - replay holds an entry whose id the session doesn't serve.

- [ ] **Steps 1-5**, with commit `fix: queue a send when the app started offline`.

### Task 10: All-mail search includes Sent

Research section 9, webmail `832651bc`.

**Files:**
- Modify: `src/api/unified-inbox.ts`. A search from the unified All-mail view covers every folder except Trash and Junk, with Sent included, as WEB `lib/unified-mailbox.ts:499-545` does.
- Test: the filter for a search excludes only Trash and Junk; a view with no search is unchanged.

- [ ] **Steps 1-5**, with commit `fix: search All mail across every folder but Trash and Junk`. After the final review, tick the parity items in one `docs:` commit:
  - close legacy migration as webmail-only;
  - add rule periods to 07, and tick it;
  - add the unverified-sender warning to 03 as open;
  - add All-mail search to 02, and tick it.
