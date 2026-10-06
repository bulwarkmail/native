# Task 8 report: global search core

Status: DONE_WITH_CONCERNS. Commit: see `git log` ("feat: add webmail's global search core").

## Files (src/lib/global-search/)
types.ts, query-parser.ts, rank.ts, run-global-search.ts, store.ts, controller.ts; tests in __tests__/{query-parser,rank,run-global-search,store,controller}.test.ts.

## Mapping decisions
- `localAccountId` -> `appAccountId` everywhere. The raw id stays `id` (dispatch said so; the brief's `rawId` was not used). Dedupe key unchanged: server + jmapAccountId when serverUrl known, else appAccountId (#847); calendar by uid.
- `SearchAccount` has no `client` (native has no client object; providers use opScope(appAccountId)). Task 9 can add fields.
- `SearchProvider` interface identical to webmail (kind, local, remote, supports).
- Mail filters: `SearchFilters` = Pick of `EmailFilters` (type-only import from email-store), unset = undefined instead of ''/null. `hasRemoteQuery` adapted. Query-parser has no size operator (webmail's parser has none either).
- Store persists `scope` only, createJSONStorage(AsyncStorage) like search-history-store, key 'global-search'.
- controller.ts: `createGlobalSearchController({providers, accounts, localLimit, remoteLimit, debounceMs=300})` with update/rerun/loadMoreMail/subscribe/getState/dispose. Port of the hook: instant local pass, debounced server pass, mergeHits as each login lands, stale search-id drop, mail load-more. Differences: input unchanged -> no restart; load-more is aborted on new search/dispose (webmail never aborted it); pagination resets on query/scope/account change.
- Concurrency 4, timeout 8000, error rows kept.

## TDD
RED: `npx vitest run src/lib/global-search` -> 5 failed files, "no tests" (modules did not exist; import resolution failure), as expected.
GREEN: same command -> 5 files, 47 tests pass (all webmail cases ported, plus 9 controller tests, a default-filters test and a 200 KB hostile-title timing test for scoreHit).
Gate: `npm run typecheck && npm test && npm run i18n:check` -> typecheck clean, 287 files / 4690 tests pass, i18n ok. One earlier full run had a single hard-coded-English failure from the other implementer's in-progress EmailListScreen edit; it passed on rerun (not mine).

## Concerns
- query-parser type-imports EmailFilters from email-store.ts, which the other implementer is editing; the nine picked fields must stay.
- Load-more refetches a larger window (limit grows) like webmail, not Email/query position.
