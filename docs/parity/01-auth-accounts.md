# Authentication, login, session & multi-account

## Summary
RN covers the happy paths (password login, webmail-mediated OAuth handoff, QR pairing, per-account keychain credentials, restore/switch/logout, Stalwart account-security API) and several WEB fixes are already mirrored (refresh coalescing, cached-token reuse, keep-session-on-network-error). The biggest gaps are: no TOTP/2FA password login at all (and the webmail handoff silently breaks for TOTP accounts), the Account Security screen is dead against every Stalwart server because it checks the wrong capability map (native issue #47), a failed "add account" or failed switch destroys the live session, expired/revoked tokens never lead back to the login screen, account display names are never refreshed (#900), relative session URLs are not resolved, and there is no per-account remove / per-device push revoke / public-key management.

## Findings

### Login flow

- [x] **TOTP / 2FA password login is impossible** — `P1` — `missing` — fixed in b52768e
  - What WEB does: login form has a TOTP field (auto-shown when the server answers 402 "MFA code required", `lib/jmap/client.ts:956-966` → `TOTP_REQUIRED`). With a code it calls `/api/auth/totp-token-exchange` which performs Stalwart's structured login `POST {server}/api/auth {type:'authCode', accountName, accountSecret, mfaToken, clientId, redirectUri, codeChallenge, codeChallengeMethod:'S256'}` then `POST {server}/auth/token` (authorization_code + PKCE) and continues as a bearer session (`app/api/auth/totp-token-exchange/route.ts:26-28, 90-93, 125, 150`; `stores/auth-store.ts:651-706`; changelog 1.7.5 "Support MFA login via the structured auth endpoint"). Legacy `password$totp` basic-auth fallback for pre-0.16 servers (`auth-store.ts:696-702`).
  - What RN does: `JMAPClient.connect` only does HTTP Basic with the raw password (`src/api/jmap-client.ts:88-106`, `363-383`). A 402 becomes `"Session discovery failed: 402 …"`, which `describeLoginError` only maps for 403/404 (`src/lib/login-errors.ts:57`) so the user sees a generic "Sign-in failed". The 401 copy tells 2FA users to create an app password (`login-errors.ts:39-44`) — that is the only workaround today.
  - Fix hint: detect 402 with a title containing `totp`/`mfa` in `fetchSession`, show a code step, then implement the two-step exchange directly on device (no CORS on native): `/api/auth` with `mfaToken` + `clientId: 'bulwark-webmail'` + PKCE, then `/auth/token`; persist the result as an OAuth bundle (`tokenEndpoint = ${server}/auth/token`, `clientId`) so `connectWithOAuth` and the existing refresh path take over.

- [x] **Webmail password handoff breaks for TOTP-protected accounts** — `P1` — `bug` (cross-repo) — fixed in 0d94d76 (RN retries the handed-off password with a code prompt; the webmail-side flow=oauth hand-off is still open)
  - What WEB does: in mobile-handoff mode the login page always hands back `flow=password` with the raw password the user typed (`app/(main)/[locale]/login/page.tsx:638-642, 282`) even when the webmail itself upgraded that login to token auth via TOTP (`stores/auth-store.ts:651-706`, `upgradedToOAuth`).
  - What RN does: `loginViaWebmail` feeds the password into `login()` → Basic auth (`src/stores/auth-store.ts:226-229`) → Stalwart 402 → "Sign-in failed". The user completed 2FA in the browser and still cannot sign in.
  - Fix hint: WEB should hand off `flow=oauth` (access/refresh token, `token_endpoint`, `client_id`) when the password login was TOTP-upgraded (the mobile SSO branch in `app/api/auth/sso/complete/route.ts:66-97` already returns that shape); RN needs no change once WEB does that. Alternatively RN implements the previous finding and retries with a TOTP prompt when the handed-off password is rejected with 402.

- [x] **No direct OAuth/OIDC (PKCE) against the mail server — a Bulwark webmail at the JMAP origin is assumed** — `P2` — `missing` — fixed in 4bebf70
  - What WEB does: discovers `/.well-known/oauth-authorization-server` or `openid-configuration` (`lib/oauth/discovery.ts:150-175`), runs client-side PKCE (`login/page.tsx:569-621`, `lib/oauth/pkce.ts`) or server-side SSO; works against Stalwart's built-in OAuth (default client id `bulwark-webmail`, `lib/oauth/token-exchange.ts:14`), Keycloak, Authentik.
  - What RN does: `ConfirmStep → runHandoff(serverUrl)` opens `${serverUrl}/login?mobile_redirect_uri=…` (`src/lib/oauth.ts:49-56`, `src/screens/LoginScreen.tsx:128-135`). `serverUrl` comes from probing `/.well-known/jmap` on `domain`, `mail.domain`, `webmail.domain` (`src/lib/server-discovery.ts:70-72, 143-170`) — i.e. it finds the Stalwart host, and then assumes a Bulwark webmail lives at that same origin. When webmail is on another host (or the server only runs Stalwart), the browser opens a 404/Stalwart admin page and the only way in is the password step.
  - Fix hint: either (a) do PKCE natively with `expo-web-browser`/`expo-auth-session` against the discovered `authorization_endpoint` (redirect `bulwarkmobile://auth/callback`, client id `bulwark-webmail`, scopes `openid email profile`), or (b) probe `${serverUrl}/api/config` before opening the handoff and ask for the webmail address when it is not a Bulwark instance.

- [x] **Login error classification is thinner than WEB** — `P3` — `partial` — fixed in b52768e
  - What WEB does: `classifyLoginError` maps invalid credentials, network, 5xx `server_error`, `totp_required`; 429 is a `RateLimitError` with retry-after (`stores/auth-store.ts:71-96`, `lib/jmap/client.ts:849-853`).
  - What RN does: `describeLoginError` (`src/lib/login-errors.ts`) has no 402 (MFA), 429 or 5xx branches; `RateLimitError('Rate limited by server')` falls to the generic "Sign-in failed" with the raw message.
  - Fix hint: add branches for `402` → 2FA copy, `429`/`RateLimitError` → "try again in N s", `5xx` → "server error, try later".

- [x] **Saved-username suggestions on the login form** — `P3` — `missing` — fixed in 2404717
  - What WEB does: remembers the last 5 usernames and offers them as an autocomplete (`login/page.tsx:500-517`).
  - What RN does: `EmailStep`/`PasswordStep` start empty; in add mode `ChooseStep` only offers the known server, not known usernames.
  - Fix hint: prefill/offer `accounts[].username` from the registry (and remember the last typed address in AsyncStorage) in `EmailStep`.

- [x] **Login flow strings are hard-coded English** — `P3` — `partial` — fixed in 2404717
  - What WEB does: every login string is localized (`login.*` keys used throughout `login/page.tsx`).
  - What RN does: `LoginScreen.tsx`, all `src/screens/login/*.tsx`, `QrScanModal.tsx` and `login-errors.ts` use literal English while `SettingsScreen` already uses `useLocaleStore().t` (`src/screens/SettingsScreen.tsx:169-190`).
  - Fix hint: route through `t()` with `login.*` keys (the i18n audit may cover this; listed here so it is not lost).

- [x] **QR hint copy points to a settings page that does not exist** — `P3` — `bug` — fixed in b52768e
  - What WEB does: the pairing QR is generated in Settings → Security ("Link device", `components/settings/account-security-settings.tsx:894-1026`).
  - What RN does: hints say "Settings → Devices → Add phone" (`src/components/QrScanModal.tsx:66`) and "Settings → Devices" (`src/screens/LoginScreen.tsx:221`).
  - Fix hint: change the copy to Settings → Security → Link device.

- [x] **Client TLS certificate support is Android-only and does not cover push/SSE** — `P3` — `partial` (native issue #3) — fixed in edc26ce (live updates fall back to polling with a cert; redirects handled in JS (6f747db); iOS implementation still deferred)
  - What WEB does: N/A (the browser negotiates mTLS).
  - What RN does: `src/lib/client-cert.ts` bridges an Android `BulwarkClientCert` module and `secureFetch` is used by the JMAP client, blob and discovery code. Gaps: iOS has no implementation (`getNative` returns null off Android, `client-cert.ts:34-45`); the JMAP SSE stream uses `EventSource` with a plain header (`src/api/push.ts:120-137`) so live updates fail behind mTLS; the system browser used for the webmail handoff cannot present the cert; the abort signal does not reach the native path (`server-discovery.ts:103-135` works around it).
  - Fix hint: document the limits in the native issue; route SSE through a native fetch-based reader or the `react-native-sse` fetch option when a cert alias is set; consider an iOS `URLSession` delegate implementation.

### Session

- [x] **Relative session URLs are not resolved** — `P2` — `bugfix-parity` (changelog 1.9.0 "Resolve relative session URLs without corrupting URI templates") — fixed in 0b1c240 (unified-inbox.ts copy is with the mail-list agent)
  - What WEB does: `rewriteSessionUrl` prefixes the connected origin when `apiUrl`/`downloadUrl`/`uploadUrl`/`eventSourceUrl` have no scheme, and rewrites the origin of absolute ones without touching `{accountId}`/`{blobId}` templates (`lib/jmap/client.ts:1091-1110`).
  - What RN does: `rewriteSessionUrls` only rewrites absolute URLs; `extractOrigin` returns null for `/jmap/` so the relative value is passed through unchanged and `secureFetch('/jmap/')` fails (`src/api/jmap-client.ts:320-340`). Same in the unified inbox `rewriteApiUrl` (`src/api/unified-inbox.ts:55-60`).
  - Fix hint: when the URL has no `^https?://`, return `serverOrigin + (url.startsWith('/') ? url : '/' + url)`; keep the plain string splitting (the comment about the RN URL polyfill corrupting templates still applies).

- [x] **Redirected session fetch may lose the Authorization header** — `P3` — `partial` — fixed in 0b1c240; the check keyed on `response.redirected`, which React Native's fetch never sets, so it only works since 859770b (audit B15)
  - What WEB does: `fetchSessionResponse` detects a redirected 200 with no accounts/username (Safari and some auth proxies drop `Authorization` on redirect) and refetches `response.url` with the header (`lib/jmap/client.ts:911-925`).
  - What RN does: `fetchSession` trusts the redirected response (`src/api/jmap-client.ts:363-383`); Stalwart 0.16.19 answers `/.well-known/jmap` with a 307 to `/jmap/session` (verified against stw-test19), and iOS `NSURLSession` can strip the header on redirect, which ends in `resolveAccountId` throwing "No account found in JMAP session".
  - Fix hint: mirror the WEB check (`response.redirected` and empty `accounts`/`username` → refetch `response.url` with the header).

- [x] **Transient token-endpoint failure evicts the account** — `P2` — `bugfix-parity` (changelog 1.7.6 "Keep the session when the auth server is briefly unreachable", 1.7.8 "End refresh loops on sign-out and back off failed retries") — fixed in 2c0dbd1
  - What WEB does: only a definitive 400/401/403 from the token endpoint drops the refresh token (`app/api/auth/token/route.ts:143`); 5xx/network → 503 and the client keeps the account and retries with backoff (`stores/auth-store.ts:1209-1226`, `1792-1799`, `isTransientAuthError` at `:106`).
  - What RN does: `refreshOAuthAccessToken` throws `HandoffError` for any non-OK status or network error (`src/lib/oauth.ts:239-241`); `forceRefreshToken` turns every failure into `false` (`src/api/jmap-client.ts:211-221`) so an expired access token + a 5xx/offline token endpoint becomes `AuthenticationError`, and `restoreSession`/`switchAccount`/`retrySession` then delete the keychain entry (`src/stores/auth-store.ts:397-405, 505-512, 569-586`).
  - Fix hint: in `refreshOAuthAccessToken` throw a distinct transient error for network failures, 429 and 5xx; in `fetchSession`/`request` rethrow it as `NetworkError` instead of `AuthenticationError`; only 400/401/403 from the token endpoint are definitive.

- [x] **A revoked/expired refresh token never leads back to the login screen** — `P2` — `rn-only-bug` — fixed in b52768e
  - What WEB does: a 401 from refresh marks the session expired, logs out and redirects to login with a "session expired" banner (`stores/auth-store.ts:1209-1214`, `markSessionExpired`, `login/page.tsx` `session_expired` banner).
  - What RN does: `request()` throws `AuthenticationError('Session expired')` (`src/api/jmap-client.ts:433`) but nothing outside `auth-store`/`login-errors` handles that class (grep over `src/`); the email store just records the message. `retrySession` returns early because `get().session` is still the stale object (`src/stores/auth-store.ts:554`). The user is stuck on a dead session until a relaunch.
  - Fix hint: give `JMAPClient` an `onAuthFailure` callback (set by auth-store) that runs the `AuthenticationError` branch of `retrySession` (clear creds for the active account, `isAuthenticated:false`, error "Session expired"); or clear `session` in the store on that error so `retrySession` can run.

- [x] **Logout does not revoke the OAuth refresh token** — `P3` — `partial` — fixed in 4bebf70 (pairing bundles are deliberately not revoked)
  - What WEB does: `DELETE /api/auth/token` posts the refresh token to the IdP `revocation_endpoint` on logout/remove/logout-all (`app/api/auth/token/route.ts:181-254`).
  - What RN does: `logout`/`logoutAll` only delete the SecureStore entry (`src/stores/auth-store.ts:286-357`, `src/api/jmap-client.ts:350-361`); the refresh token stays valid server-side.
  - Fix hint: discover `revocation_endpoint` from `${serverUrl}/.well-known/oauth-authorization-server` and POST `token=<refresh>&token_type_hint=refresh_token&client_id=…` best-effort. Caveat: a QR-paired phone shares the desktop's refresh token (`app/api/auth/pair/create/route.ts:18-22`), so revoking it would also sign out the desktop — only revoke bundles that came from the browser handoff, or accept that behaviour deliberately.

- [x] **No request deadline on JMAP calls** — `P3` — `partial` (changelog 1.8.1 "Time out stalled JMAP requests so a send can't hang forever (#702)") — fixed in 0b1c240
  - What WEB does: `timedFetch` aborts when no response headers arrive within 30 s (300 s for blob transfers) and does not retry timed-out non-idempotent requests (`lib/jmap/client.ts:786-816`).
  - What RN does: `request()`/`fetchSession` use bare `secureFetch` with no timeout (`src/api/jmap-client.ts:363-383, 410-445`); only the native-cert path (30 s) and the discovery probe (2.5 s) have deadlines.
  - Fix hint: add an `AbortController` timeout in `request()` (and blob helpers), surfacing a distinct timeout error; do not auto-retry sends.

- [x] **SSE stream is opened without a token freshness check** — `P3` — `partial` (verify with the push audit) — fixed in edc26ce
  - What WEB does: SSE uses `authenticatedFetch`, so a 401 triggers the refresh path.
  - What RN does: `connectEventSource` reads `jmapClient.authHeader` once (`src/api/push.ts:137`) without `ensureFreshToken` (private, `src/api/jmap-client.ts:195`), so a nearly-expired access token can be used for a long-lived stream.
  - Fix hint: expose an `ensureFreshToken()`-then-header helper on the client and call it before connecting/reconnecting the stream.

### Multi-account

- [x] **A failed "add account" destroys the active session** — `P1` — `rn-only-bug` — fixed in b52768e
  - What WEB does: connects the new account with a fresh `JMAPClient` and only snapshots/clears the previous account after `connect()` succeeded (`stores/auth-store.ts:709-716`, `957-962`).
  - What RN does: `login()` and `completeOAuthHandoff` call `jmapClient.reset()` and reset contacts/calendar *before* connecting (`src/stores/auth-store.ts:110-114, 175-180`). On failure the store still says the previous account is active, but the singleton now holds the wrong credentials and no session; cancelling the modal (`App.tsx:470-481`) restores nothing, so every request throws "Not connected" until relaunch.
  - Fix hint: connect with a throwaway `new JMAPClient()` (or keep the current creds/session in locals) and only adopt the new connection into the singleton after success; on failure `await jmapClient.loadAccount(previousActive)`.

- [x] **A failed account switch leaves the client half-switched** — `P2` — `rn-only-bug` — fixed in b52768e
  - What WEB does: on restore failure the previous account's client is re-activated (`stores/auth-store.ts:1546-1565`); rate-limited/transient failures keep both accounts.
  - What RN does: `loadAccount(target)` overwrites `credentials` and nulls `session`/`_accountId` on failure (`src/api/jmap-client.ts:244-273`); `switchAccount` restores only the email-store view (`src/stores/auth-store.ts:393-411`) and leaves the store's `session` set, so `retrySession` short-circuits (`:554`) and the previous account is dead.
  - Fix hint: in the catch, `await jmapClient.loadAccount(previousActive)` (or restore the saved in-memory creds/session) before returning; alternatively set `session: null` so the network-recovery watcher re-establishes it.

- [x] **Account display name is never refreshed from the server (#900)** — `P2` — `missing` (changelog 1.9.0 "Refresh the account display name from the Stalwart principal on login, restore, and switch") — fixed in b52768e
  - What WEB does: seeds `displayName`/`email` from the primary identity at login, then `syncAccountDisplayName` reads `x:Account/get` (principal "Full name") on login, restore and switch and updates the registry (`stores/auth-store.ts:146-176, 741-751`; `lib/stalwart/principal.ts`).
  - What RN does: `addAccount({ displayName: username, email: username })` (`src/stores/auth-store.ts:123-131, 186-193`) and nothing ever updates it; the drawer header shows the raw username (`src/components/SidebarDrawer.tsx:297`). `fetchPrincipal` already exists (`src/api/account-security.ts:157-176`) but only feeds the security screen, and saving a new display name there does not touch the registry.
  - Fix hint: after each successful connect run `Identity/get` (name/email) and, when `urn:stalwart:jmap` is in the account's `accountCapabilities`, `fetchPrincipal()`; `accountStore.updateAccount(id, { displayName, email })`; also update on `updateDisplayName` success.

- [x] **OAuth account id/email derived from the raw JMAP username** — `P3` — `partial` — fixed in b52768e (email refreshed from the primary identity; registry id unchanged)
  - What WEB does: prefers the primary identity email over `Session.username` for OAuth/SSO because OIDC `preferred_username` may not be an address (`stores/auth-store.ts:946-951, 1096`).
  - What RN does: `connectWithOAuth` uses `session.username || accessToken.slice(0, 8)` (`src/api/jmap-client.ts:135-136`), so the same mailbox logged in via password and via OAuth can produce two registry entries, and the drawer synthesizes `username@host`.
  - Fix hint: read `Identity/get` after connect and use the primary identity email for `email` (and ideally for the registry id).

- [x] **Cannot remove a non-active account** — `P2` — `missing` (changelog 1.7.8 "Remove a specific account from the switcher") — done in 6ae21d5, 490355c
  - What WEB does: per-row remove button in the switcher (`components/layout/account-switcher.tsx:138-143, 322-333`) backed by `removeAccount` which tears down the client, evicts caches and clears cookies (`stores/auth-store.ts:1382-1401`).
  - What RN does: only "Sign out of <active>" and "Sign out all" (`src/components/SidebarDrawer.tsx:400-437`).
  - Fix hint: add a per-row remove (long-press or trailing X) that runs `teardownPushNotificationsForAccount(id)`, `jmapClient.clearAccountCredentials(id)`, `useEmailStore.removeAccount(id)`, `accountStore.removeAccount(id)`.

- [x] **Switcher shows stale connection state and no error indicator** — `P3` — `partial` — done in 6ae21d5 (the drawer shows `hasError` with its message)
  - What WEB does: shows `hasError` (alert icon) with `errorMessage` and a live `isConnected` dot per account (`account-switcher.tsx:296-303`).
  - What RN does: renders only the `isConnected` dot (`SidebarDrawer.tsx:355-361`); `hasError`/`errorMessage` (set in `restoreSession`) are never displayed, and since only the active account is ever connected, other rows show whatever value they had last.
  - Fix hint: render `hasError`; show the dot only for the active account (or treat inactive as "cached").

- [x] **Accounts list in Settings (reorder, set default, add) is missing** — fixed in 490355c — `P3` — `missing` (changelog 1.7.2 "List and reorder logged-in accounts from settings (#282)", 1.7.7 "Pin the default account on top and drag-to-reorder") — move up/down + set default + remove + add; account-store.reorderAccounts
  - What WEB does: `AccountSettings` lists all accounts with move up/down, drag reorder, set-default, add (`components/settings/account-settings.tsx:182-220`); switcher pins the default first (`lib/account-utils.ts:117-142`).
  - What RN does: `AccountSettings` shows only the active account's fields (`src/components/settings/AccountSettings.tsx`); the drawer lists accounts in registry order with set-default only (`SidebarDrawer.tsx:390-406`).
  - Fix hint: add an accounts section with set-default/remove/reorder (`accountStore` needs a `reorderAccounts`).

- [x] **AccountSettings reports the wrong auth method and never shows storage** — fixed in 490355c — `P3` — `rn-only-bug` — jmapClient.usesBearerAuth + Quota/get (src/api/quota.ts)
  - What WEB does: shows OAuth vs Basic from `authMode` and a quota bar (`account-settings.tsx:151-180`).
  - What RN does: `authMode = props.authMode ?? 'basic'` and `quotaUsed = props.quotaUsed ?? 0` (`AccountSettings.tsx:46-47`) but `SettingsScreen` renders `<Component />` with no props (`SettingsScreen.tsx:242`), so OAuth accounts read "Basic" and the storage row never appears (RN has no `Quota/get` at all — flag for the mail/settings audit).
  - Fix hint: derive from `jmapClient.usesBearerAuth` (or persist `authMode` on `AccountEntry`); fetch quota via `Quota/get` when `urn:ietf:params:jmap:quota` is advertised.

- [x] **Hard account cap of 5** — `P3` — `partial` — done in 6ae21d5 (cap raised to 10, `src/lib/account-utils.ts:4`)
  - What WEB does: 5 on HTTP/1.1, lifted to 50 when HTTP/2 is observed, because each web account pins an SSE socket (`lib/account-utils.ts:75-107`).
  - What RN does: `MAX_ACCOUNTS = 5` (`src/lib/account-utils.ts:1`) although only the active account holds a live connection.
  - Fix hint: raise the constant (or drop the cap) once the unified inbox cost per account is acceptable.

- [ ] **Shared/group account settings scope is missing** — `P3` — `missing` (changelog 1.7.5 "Manage shared/group account settings from the Accounts page") — partly: shared accounts are listed in AccountSettings (490355c), and tapping one scopes Filters and Vacation to it since a86cd1d; calendar and contacts settings are not scoped yet
  - What WEB does: lists `client.getSharedAccounts()` (non-primary) on the Accounts page and enters a scoped settings mode (filters, vacation, calendars, contacts) via `managed-account-store` (`components/settings/account-settings.tsx:43-48, 112-118, 225-262`; `stores/managed-account-store.ts`).
  - What RN does: `getSharedMailAccounts()` exists for mail/unified inbox (`src/api/jmap-client.ts:480-495`) but there is no shared-account listing or scoped settings.
  - Fix hint: list non-personal `session.accounts` in `AccountSettings` and pass an `accountId` into the filter/vacation stores.

- [x] **Unified-inbox shared-account filter disagrees with `getSharedMailAccounts`** — `P3` — `rn-only-bug` — done in 6ae21d5
  - What WEB does: a non-personal account counts as mail-capable even when its `accountCapabilities` omit mail (`lib/jmap/client.ts:4421-4445`); RN's own `getSharedMailAccounts` mirrors that (`jmap-client.ts:486-493`).
  - What RN does: the unified inbox requires `accountCapabilities == null || MAIL in accountCapabilities` (`src/api/unified-inbox.ts:208-210`), so a shared account that advertises other capabilities but not mail is silently skipped there while it appears in the sidebar.
  - Fix hint: reuse the `!advertisesMail && info.isPersonal → skip` rule from `getSharedMailAccounts`.

### Account security settings

- [x] **Account Security screen is dead against every Stalwart server (native issue #47)** — `P1` — `rn-only-bug` — fixed in 032732c
  - What WEB does: probes `client.hasAccountCapability('urn:stalwart:jmap')`, i.e. the *account-level* capability map (`stores/account-security-store.ts:276-290`, `lib/jmap/client.ts:4173-4177`, `lib/stalwart/principal.ts:33`).
  - What RN does: `isStalwartSupported()` checks the *session-level* `session.capabilities` (`src/api/account-security.ts:51-54`). Verified against Stalwart 0.16.19 (stw-test19): `urn:stalwart:jmap` is present only under `accounts[<id>].accountCapabilities`, not in the top-level `capabilities`. So `AccountSecuritySettings` always renders "Account security management requires a Stalwart server" (`src/components/settings/AccountSecuritySettings.tsx:584, 622`). The same effect also shows that copy when the session is merely offline (`:583`).
  - Fix hint: `const acc = session.accounts?.[jmapClient.accountId]; return !!acc?.accountCapabilities?.[STALWART_CAPABILITY] || STALWART_CAPABILITY in (session.capabilities ?? {})`; show an "offline" notice instead of the Stalwart notice when `currentSession` is null.

- [x] **Push subscriptions: no per-device list/revoke and no forced recreate (#841)** — fixed in f6f26f7 — `P2` — `missing` (changelog 1.9.0 "Per-device revoke for push subscriptions (#841)", "Recreate the push subscription on re-register (#841)")
  - What WEB does: lists relay devices with a "this device" marker and per-device revoke, and Re-register passes `forceRecreate` so a stale subscription is recreated rather than its expiry refreshed (`components/settings/notification-settings.tsx:95, 115-131, 169`).
  - What RN does: Enable / Re-register / Disable for this device only (`src/components/settings/NotificationSettings.tsx:81, 186-198`); no device list, and whether Re-register recreates the JMAP `PushSubscription` was not verified here (push audit).
  - Fix hint: call the relay device-list endpoint the web uses, render rows with revoke (`PushSubscription/set destroy` + relay unregister), and thread a `forceRecreate` flag through `setupPushNotifications`.

- [x] **Public keys (S/MIME/PGP) and encryption-at-rest configuration are missing** — fixed in ddae1e6 — `P3` — `missing` (changelog 1.8.1 "Manage S/MIME and PGP public keys and configure Stalwart encryption at rest from account security settings")
  - What WEB does: `PublicKeysSection` with `x:PublicKey/query|get|set` and `x:AccountSettings/set encryptionAtRest {@type, publicKey, encryptOnAppend, allowSpamTraining}` (`components/settings/account-security-settings.tsx:573-840`; `stores/account-security-store.ts:397-455, 625-700`).
  - What RN does: read-only `EncryptionSection` showing the `@type` only (`AccountSecuritySettings.tsx:539-555`; `src/api/account-security.ts:150-155`).
  - Fix hint: port the four store methods to `src/api/account-security.ts` and add a key list + encryption picker.

- [x] **OAuth `state` is generated with `Math.random`** — `P3` — `rn-only-bug` — fixed in 2c0dbd1
  - What WEB does: `crypto.getRandomValues` for verifier/state (`lib/oauth/pkce.ts:11-27`).
  - What RN does: `randomState()` uses `Math.random` (`src/lib/oauth.ts:41-46`) although a CSPRNG helper with `getRandomValues`/`randomUUID` fallbacks already exists in `src/lib/totp.ts:16-46`. The state is the only guard against a forged `bulwarkmobile://` redirect delivering foreign credentials.
  - Fix hint: export `randomBytes` from `totp.ts` (or a shared `random.ts`) and use it here.

## Verified at parity (brief list, so the fixer knows NOT to redo)
- QR login payloads: WEB emits `bulwarkmail://pair?server=<webmailBase>&code=…` (`account-security-settings.tsx:971`); RN parses it plus a `connect` variant and bare URLs (`src/lib/oauth.ts:135-162`) and redeems at `/api/auth/pair/redeem` (`:165-207`) into the same OAuth bundle the browser handoff yields.
- Webmail handoff (`mobile_redirect_uri`/`mobile_state`, fragment transport, state check, password/oauth flows) matches `login/page.tsx:115-130, 282, 638-650` and `auth/callback/page.tsx` mobile branch.
- Token refresh: coalesced per refresh token (`src/lib/oauth.ts:210-262`, WEB `refreshPromises`); cached access token reused until 60 s before expiry (#552; `jmap-client.ts:195-209`); client id always carried in the bundle so #873 does not apply; rotated refresh tokens persisted.
- Session restore: waits for AsyncStorage hydration, restores active → default account, keeps credentials and shows cached data on `NetworkError` (mirrors 1.7.6 "keep the session when the auth server is briefly unreachable"), evicts on definitive `AuthenticationError` (mirrors 1.6.0 "evict unrecoverable basic-auth accounts"), legacy single-slot migration.
- Logout: revokes this account's push subscription first, clears only that account's caches, switches to default/next account or falls back to the login screen; "Sign out all" wipes everything.
- Switch: email store is swapped before the network round-trip so the cached list shows immediately (same intent as 1.7.8 "eliminate the full-screen flash when switching accounts").
- Shared/group discovery: `getSharedMailAccounts` applies the WEB rule (non-personal OR advertises mail); unified inbox namespaces by `sourceAccountId`/`jmapAccountId`.
- Account security API (password change, display name, TOTP enrol/disable with `notUpdated` surfaced — 1.7.5 "Surface server errors on password change and TOTP toggle", app passwords, API keys with expiry/allowed IPs, principal/encryption reads, `Promise.allSettled` for forbidden principal reads) mirrors `stores/account-security-store.ts`; password/TOTP/display-name sections hidden for bearer sessions like WEB `isOAuth`.
- Server discovery by email domain (`/.well-known/jmap` probe on bare/`mail.`/`webmail.` hosts, 401 counts as a hit, known servers trusted) is RN's equivalent of WEB's admin server list / auto-pick-by-domain (#799); neither side does `_jmap._tcp` SRV.
- Login error → session-expired banner: RN's `ChooseStep` shows the store error ("Session expired") like WEB's `session_expired` banner.
- `AuthenticationError` on 401, `RateLimitError` on 429 with Retry-After parsing in `request()`.

## N/A on mobile
- "Remember me" (RN always stores credentials in the device keychain), `rememberMeEnabled`/`SESSION_SECRET` cookie logic, per-slot cookie handling (`cookieSlot`, `oauth_cookie_slot`), orphan-cookie adoption, `serverIdentifiers`/`classifySessionMatch` slot→token desync guard (RN keys credentials per registry id, no shared slot).
- Server-configured login branding/notice (`LOGIN_SHOW_TOTP`, `LOGIN_SHOW_VERSION`, logos, imprint/privacy links, company name), OAuth-only mode / auto-SSO / iframe embedded SSO (#69), server picker dropdown (#799), custom JMAP endpoint toggle, demo mode, dev-mode login, CORS error classification.
- Impersonation (`/api/auth/impersonate`, `%master` suffix stripping, impersonation reconciler), admin login.
- TOTP re-auth dialog (`totp-reauth-store`/`totp-reauth-dialog`): only used by WEB's legacy `password$totp` basic-auth path for pre-0.16 Stalwart; once RN gains TOTP via the token exchange no re-auth is needed.
- "Link device" QR generator (RN is the device being linked); TOTP enrolment QR image (same-device — RN's `otpauth://` deep link + manual secret is the right shape).
- 30 s keep-alive ping / `connectionLost` state (RN uses NetInfo + `retrySession`), per-tab SSE budget (#702), settings-sync enable/disable on login (settings audit), Stalwart passthrough auth context (`/api/auth/stalwart-context`), plugin logout hooks.
