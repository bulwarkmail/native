# Parity Phase 6e: Settings, UI and Security Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the open settings, UI and security parity items that this repo can do on its own:
- the unverified-sender warning;
- screen-content protection;
- SSO sign-out;
- the settings scope for shared accounts;
- a per-account push relay;
- the date-format region and an app-wide time zone;
- font size everywhere;
- system-bar theming;
- sidebar apps;
- folder deep links;
- settings-search entries;
- the About build link.

**Architecture:**
- Most work is JS-only.
- One new Kotlin module, `BulwarkWindowModule`, carries FLAG_SECURE / recents protection and the system-bar appearance. Both ship in one native rebuild.
- Font size works by making the typography tokens live and re-keying `useColors`, so the 114 hook-built style files rescale without edits.

**Tech Stack:** React Native / Expo (prebuild, `android/` committed), TypeScript, Kotlin, Zustand, vitest, expo-auth-session / expo-web-browser.

**Spec:**
- The open items in [01](../../parity/01-auth-accounts.md) (~134, ~203), [02](../../parity/02-mail-list-folders.md) (~217), [03](../../parity/03-email-viewer.md) (~275), [08](../../parity/08-settings-push-i18n-ui.md) (~164, ~226, ~233, ~258, ~290, ~354, ~357, ~360) and [09](../../parity/09-jmap-core-sync-security.md) (~234).
- User decisions made on 2026-10-08:
  - **Screen protection:** off by default, with two toggles: "Block screenshots" (which also blanks the recents preview) and, on Android 13+, "Hide in recent apps only".
  - **SSO sign-out:** always end the identity-provider session, as webmail does.
  - **Shared accounts:** calendars and address books can be renamed and recoloured, but not deleted from the app.
  - **Time zone:** applies app-wide, as in webmail.
- Controller rulings:
  - **Relay:** keep free text, stored per account, until upstream exposes a policy the app can authenticate to.
  - **Sidebar apps:** open in a Custom Tab, never inline.
  - **About:** links the repository and commit the build came from.
- Webmail at `a2e36e6e`, cloned at `/tmp/webmail`, is the authority.
- Research with exact refs: `.superpowers/sdd/2026-10-08-parity-phase-6e-settings-ui/research.md`. Each task names its section.

## Global Constraints

- **Branch:** `parity/phase-6e-settings-ui`, from `main` at `3719f21`.
- **Gate on every commit:** `npm run typecheck && npm test && npm run i18n:check`.
- **Strings:** use `t('key', 'English fallback')` with webmail's key. RN-only keys go through `npm run i18n:harvest`.
- **Commits:** one per task, with the task's subject and the trailers. Stage by explicit path, and never `git add -f` anything under `.superpowers`.
- **Parity docs:** do not edit `docs/parity/*.md` or `PARITY_CHECKLIST.md` in a task.
- **Tests:** vitest in node, with no RN render harness. Write tests first and record RED. Native Kotlin is checked with `./gradlew assembleRelease -PallowDebugSignedRelease=true -PreactNativeArchitectures=arm64-v8a,x86_64` plus a mocked-module JS test.
- **Accounts:** Stalwart ids repeat across accounts and servers. Anything parked or opened later (a folder link, a sign-out, a relay) carries its app account and is dropped if another account is shown.
- **URLs:** any URL from settings or the server that reaches `Linking.openURL` or a browser is limited to `https:` (and `http:` only where the setting already allows it). Never `javascript:`, `intent:`, `file:` or `content:`.

## Review Focus

1. **A message that fails sender checks always shows the warning, and never offers "Always trust this sender".** A forged pass header in the body can't suppress it. Owned by Task 1.
2. **Protection toggles survive a cold start and apply before the first frame.** Turning them off restores screenshots. Owned by Task 2.
3. **Signing out of one SSO account never ends another account's provider session, and never sends one account's `id_token` to another provider.** Owned by Task 3.
4. **A folder link for account A never opens account B's folder with the same id.** Owned by Task 9.
5. **A sidebar-app URL or About link can't open a non-web scheme.** Owned by Tasks 8 and 10.

## Not in this phase

- **Webmail's admin-curated relay list and default sidebar apps.** Blocked: webmail's `/api/admin/policy` hides them from non-cookie clients. Raise this upstream.
- **iOS** (no device), **cross-device settings sync**, and **RTL completion**.
- **Flags in the language list.** Cosmetic.

---

### Task 1: Warn about an unverified sender

Research section 1.

**Files:**
- Run: `node scripts/sync-locales.mjs --from /tmp/webmail/locales` to vendor the 7 `email_viewer.sender_check.*` keys. Commit the locale changes in this task.
- Modify:
  - `src/lib/email-headers.ts`: port webmail's multi-DKIM parsing (`dkim.all`), `isAuthenticationSpoofed` with any-DKIM-pass, and the sender-check result (webmail `lib/email-headers.ts:36-90,237-252`).
  - The viewer header and message components (see research): add a banner above the message and a badge by the sender, using the `unverified` and `failed` variants and the vendored keys.
  - The trusted-senders action: hide "Always trust this sender" for flagged mail.
- Test: port webmail's 7 tests, plus native tests for the banner decision as a pure helper, and a check that "Always trust" is hidden for flagged mail.

- [ ] Steps 1-5, with commit `feat: warn when a message's sender could not be verified`.

### Task 2: Protect screen content, and theme the system bars

Research sections 2 and 5d. **Needs a native rebuild.**

**Files:**
- Create: `android/app/src/main/java/com/anonymous/bulwarkmobile/BulwarkWindowModule.kt`, with these methods:
  - `setSecure(enabled)` sets or clears `FLAG_SECURE` on the UI thread.
  - `setRecentsHidden(enabled)` is `setRecentsScreenshotEnabled(!enabled)` on API 33+, and a no-op below that.
  - `setSystemBarsAppearance(lightBackground)` uses `WindowInsetsControllerCompat` for light status and nav icons, and sets `isNavigationBarContrastEnforced = false` on API 29+.
- Modify: register the module in `BulwarkFcmPackage.kt`.
- Modify: `MainActivity.onCreate` reads the persisted protection flags from SharedPreferences, which the module writes on every change, so protection is applied before the first frame.
- Modify: `styles.xml`: `enforceNavigationBarContrast` false.
- Create: `src/lib/screen-privacy.ts`, a typed JS wrapper that no-ops off Android.
- Modify: `settings-store.ts` adds `blockScreenshots` and `hideInRecents` (app-only, persisted, default false). Add a Security settings section with the two toggles; use RN keys.
- Modify: `App.tsx` applies the protection flags on change, and calls `setSystemBarsAppearance(resolvedScheme === 'light')` on theme change.
- Test:
  - a mocked-module test for the wrapper calls;
  - settings defaults and persistence;
  - a successful `assembleRelease`;
  - on the emulator: a screenshot is black when "Block screenshots" is on (`adb exec-out screencap`).

- [ ] Steps 1-5, with commit `feat: let the user hide mail from screenshots and recent apps, and match the system bars to the theme`.

### Task 3: End the identity provider's session on sign-out

Research section 3.

**Files:**
- Modify: the OAuth sign-in. For direct PKCE ("native") sign-ins only, keep the `id_token` and the discovery `end_session_endpoint` per app account, in SecureStore and the account entry respectively. Handoff and pairing accounts are excluded.
- Modify: sign-out. After the local sign-out, open `end_session_endpoint?id_token_hint=…&post_logout_redirect_uri=…` with `WebBrowser.openAuthSessionAsync`, for that account only. Delete its stored token. If the endpoint isn't there, skip this step.
- Test: pure helpers covering:
  - building the logout URL;
  - only the signed-out account's token is used;
  - no call when the endpoint is missing or the account isn't native-PKCE;
  - the token is deleted on sign-out and on account removal.

- [ ] Steps 1-5, with commit `feat: end the identity provider's session when signing out`.

### Task 4: Shared accounts get their own calendar and contact settings

Research section 4.

**Files:** per the research.
- Calendar and contact settings take an account scope, as filters and vacation already do.
- Shared calendars and address books can be renamed and recoloured where the server allows it. Delete is not offered for shared collections.
- Every write uses `requireShownAccountScope` and the owning account.

**Test:** writes go to the owning account; delete is absent for shared collections; a switch mid-edit writes nothing.

- [ ] Steps 1-5, with commit `feat: manage a shared account's calendars and address books from settings`.

### Task 5: Keep a push relay per account

Research section 5a.

**Files:**
- Modify: `src/lib/push-notifications.ts`. Store the relay at `push:relayBaseUrl:v2:<appAccountId>`. On first read, migrate the v1 device-wide value to each account. Add `getEffectiveRelayBaseUrl(appAccountId)`.
- Modify: `NotificationSettings.tsx`. Edit the shown account's relay, and add a "Reset to default" action.
- Modify: signing out clears only that account's relay.
- Test: migration, isolation between accounts, default fallback, and cleanup on sign-out.

- [ ] Steps 1-5, with commit `feat: keep a push relay per account`.

### Task 6: Date-format region, and an app-wide time zone

Research section 5b.

**Files:**
- Modify: `settings-store.ts` adds `dateLocale: 'auto'|'iso'|'en-GB'|'en-US'` (default `'auto'`, validated, synced under the webmail name).
- Modify: `src/lib/date-format.ts`.
  - Add `resolveDateLocale`.
  - `formatListDate` takes `dateLocale` and `timeZone`: numeric parts use the region locale, names stay in the UI locale, and every part uses the time zone.
- Modify: `src/lib/email-date.ts` (header and detail times) and the list callers, to pass both settings.
- Modify: the existing `calendarTimeZone` becomes the app-wide time zone. Keep the stored key and add the webmail `time_zone.*` labels. "Automatic" follows the device.
- Modify: `LanguageSettings.tsx` adds a "Date format region" select with previews, and a time-zone row.
- Test:
  - `iso` gives 2026-04-28;
  - `en-GB` gives 28/04/2026;
  - `en-US` gives 04/28/2026;
  - `auto` is unchanged;
  - names stay German for `de` with `iso`;
  - list and header times shift with the zone;
  - formatter caching includes the zone.

- [ ] Steps 1-5, with commit `feat: choose the date format region and a time zone for the whole app`.

### Task 7: Font size applies everywhere

Research section 5c.

**Files:**
- Modify: `src/theme/tokens.ts` adds `applyFontScale(f)`, which mutates the live typography from a frozen base.
- Modify: `src/theme/colors.ts`: `useColors` re-keys its memo on font size.
- Modify: `src/theme/dynamic.ts`: `useTypography` becomes a thin wrapper.
- Modify: `App.tsx`. Apply the scale before render, both on hydrate and on change. Use webmail's factors (0.875 / 1 / 1.125).
- Modify: `RulesFlow.tsx` builds its styles in a hook.
- Test: `applyFontScale` is idempotent and keeps weights; the `useColors` identity changes; and a guard test that no module-level `StyleSheet.create` uses `typography`.

- [ ] Steps 1-5, with commit `feat: apply the font size setting across the app`.

### Task 8: Show sidebar apps, opening only web links

Research section 5e.

**Files:**
- Modify: `src/lib/sidebar-apps.ts`. Validate URLs on save and on open: `https:` only (`http:` only for a local-network host if the settings screen already allows it). Reject `javascript:`, `intent:`, `file:`, `content:` and `data:`.
- Modify: render the configured apps in the sidebar drawer, opening them in a Custom Tab (`WebBrowser.openBrowserAsync`).
- Test: the scheme allow-list, including mixed case and leading whitespace; that the drawer list is built from settings; and that invalid saved entries are hidden.

- [ ] Steps 1-5, with commit `feat: show sidebar apps, and open only web links from them`.

### Task 9: Folder links open their folder

Research section 5f.

**Files:**
- Modify: `src/navigation/linking.ts`, so `/mail/folder/<ref>` (and `?account=`) parks a folder target stamped with the app account after any switch.
- Modify: the email list consumer resolves the ref by role, path or id, using **that account's** mailboxes only. It drops a target for another account, and toasts `deep_link.folder_not_found` (vendored) when the folder is missing.
- Test: parsing; resolving by role, path and id; the account stamp after a switch; a target for another account dropped; a missing folder toasted.

- [ ] Steps 1-5, with commit `feat: open a folder link to its folder`.

### Task 10: Settings-search entries, and the About build link

Research sections 5g and 5h.

**Files:**
- Modify: `src/lib/settings-search.ts`: add the "Free scrolling" and automatic time-zone keys.
- Modify: `app.config.js` `extra`: add `gitCommit` and `sourceUrl`, taken from `git rev-parse HEAD` and the `origin` remote at build time and normalised to `https://github.com/<owner>/<repo>`.
- Modify: the About card links to `<sourceUrl>/commit/<gitCommit>` when both are known, and falls back to the repository. Only https URLs are opened.
- Test: search finds both entries; the URL builder normalises ssh and https remotes; a non-https or missing value falls back.

- [ ] Steps 1-5, with commit `feat: find more settings by search, and link About to the build's commit`. After the final review, tick the parity items in one `docs:` commit, and record the upstream policy-endpoint request in the roadmap.
