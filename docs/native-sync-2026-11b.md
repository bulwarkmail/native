# Native catch-up with webmail 1.21.1 and Stalwart 1.1.0 (2026-11b)

Branch `catch-up-2026-11b` from native main 37b93729 (origin/main ce5d4dd4
plus one local commit, the export compliance answer, made by another
session on 2026-11-12 and not pushed yet). Worktree
C:\Users\info\worktrees\react-native-catch-up-2.

Status: Phase 0 (inventory), the plan and the decisions are done; the
build is running.

## Inventory (Phase 0, 2026-11-12)

Sources, all checked against native origin/main ce5d4dd4 and webmail main
2c21722ae:

- Webmail 1.20.0, 1.21.0, 1.21.1 and the commits after 1.21.1 (369 without
  merges since 1.19.1): docs/parity/12-webmail-1.20-to-1.21.md, 101 rows
  (P1 2, P2 15, P3 84). 1.21.1 is the latest webmail release.
- Stalwart 1.0.2, 1.0.3 and 1.1.0 (1.1.0 is the latest release): below.
- Leftovers of docs/native-sync-2026-11.md, the unticked rows of
  docs/parity/01-11, the deferred items of docs/ux-audit-2026-10.md and
  docs/ios-test-2026-10.md, open issues and PRs: below.
- Dependencies and the overlap with the security audit branch: below.

The working notes of each pass are in local-data/native-catch-up-2/inventory
in the webmail repo (not in git).

### Stalwart 1.0.2, 1.0.3 and 1.1.0

Sources: release notes (`gh release view`), the clone at repos/stalwart
(tags fetched; each release is one squashed commit, so diffs are by path),
native snapshot ce5d4dd4 at a read-only worktree, webmail
main 2c21722ae. v1.1.0 (2026-11-09) is still the latest release on
2026-11-12. Stalwart paths below are given with the tag they were read at.

#### 1.0.2 (2026-11-02)

The client-visible changes are in encryption and OAuth. Encryption at rest
no longer has a per-account cipher: `encryptionAtRest` is now
`{"@type": "Disabled"}` or `{"@type": "Enabled", publicKey, headerProtection,
encryptOnAppend, allowSpamTraining}` (v1.0.2
`crates/registry/src/schema/structs.rs:3138-3154`), and accounts that had it on
are switched to Disabled by the upgrade. The app (and the webmail) still read
and write `Aes128`/`Aes256`, so the setting can't be turned back on from the
app (row 1). x:PublicKey now fills `emailAddresses` and `expiresAt` from the
key itself and gains server-computed `kind`, `keyType`, `fingerprints`,
`capabilities` and `warnings` (v1.1.0
`crates/jmap/src/registry/mapping/public_key.rs:61-230`). The authorization
endpoint now skips scope names it doesn't know instead of failing with
`invalid_scope` (v1.0.1 `crates/http/src/auth/oauth/authorize.rs:339` vs.
v1.1.0 `:331-351`); the app's 1.0.3 fix relies on that and breaks two-factor
sign-in on 1.0.0 and 1.0.1 (row 3). App passwords and API keys are refused
at `/api/auth`; the app uses `/api/auth` only for password plus TOTP, and
plain passwords still go over Basic auth (`src/api/jmap-client.ts:317`,
`:343-367`), so app passwords keep working in the app. The new encryption
gateway can hide the Subject of outgoing encrypted mail (RFC 9788 header
protection, off by default), which the app's in-app decryption doesn't undo
(row 2). Everything else in the JMAP list (EmailPush for imports, inline
`cid` parts in `multipart/related`, `notFound` for merged-thread ids,
queryChanges with collapseThreads, upload membership, mailbox name length)
needs nothing; see "No action".

#### 1.0.3 (2026-11-04)

Stalwart dropped first-party OAuth clients. `firstParty` is still accepted on
x:OAuthClient/set but silently dropped (v1.1.0
`crates/registry/src/schema/structs_impl.rs:52878-52880`, unpatched
properties are only used by the ACME validator,
`crates/jmap/src/registry/set.rs:466-482`). A registered client now gets
exactly the scopes in its `scopes` list; three new scopes,
`urn:stalwart:oauth:scope:security` (passwords, 2FA, app passwords, API
keys, grants, and from 1.1.0 passkeys), `:settings` (AccountSettings,
PublicKey, MaskedEmail) and `:full` (unrestricted, superuser-only to grant),
reach the account's own objects (v1.1.0
`crates/common/src/auth/oauth/scope.rs:469-515`, `:543-552`;
`crates/common/src/auth/oauth/registration.rs:516-522`). A request naming a
scope the client doesn't allow is refused as a whole with `invalid_scope`
(`crates/http/src/auth/oauth/authorize.rs:264-268`, `:331-351`). The session
lists `urn:stalwart:jmap` only to tokens with one of the three
(`crates/jmap/src/api/session.rs:248`, before 1.0.3 never to a scoped
token). Dynamic registration strips `full` (`crates/http/src/auth/oauth/registration.rs:109-128`).
Grants issued to a first-party client before the upgrade keep full access
(`crates/common/src/auth/oauth/grant.rs:116-123`), so existing sessions keep
working. A main password that has expired is now let in when the grant has
`security` or `full`, with every permission but the password change removed
(`crates/common/src/auth/access_token.rs:637-680`).

Native d345d15b (on main, 2026-11-05) adds `security` and `settings` to every
Stalwart sign-in (`src/lib/totp-login.ts:87-92`), checks `bulwark-mobile`
and the webmail's client with those scopes before using them
(`:292-320`, `:229-278`), registers its own client with them otherwise
(`:206`), forgets a remembered client that answers `invalid_client` or
`invalid_scope` and asks once more (`:536-547`, `src/lib/oauth-native.ts`
loginWithPkce). For the browser sign-in it adds the two scopes only when the
discovery document lists them (`src/lib/oauth-native.ts:151-160`).

What it covers: on 1.0.3 and later both the TOTP sign-in and the browser
sign-in through `bulwark-mobile` or the app's own client end with a token
that reaches account security and settings; a `bulwark-mobile` left over from
a first-party registration (now scope-less) is skipped. What it doesn't:

- The webmail's OAuth setup registers `bulwark-mobile` with the data scopes
  plus `full` when the admin is a superuser (webmail
  `app/api/admin/oauth/setup/route.ts:257-271`, `:576-579`), and the app never
  asks for `full`. Such a client refuses the app's `security settings`
  request, so the app always ends on its own client and loses what only
  `full` reaches: x:ArchivedItem (recover deleted mail) and x:Account/get
  (row 4).
- The TOTP sign-in asks for the two scopes whatever the server is. 1.0.0
  and 1.0.1 refuse unknown names, so two-factor sign-in breaks there unless a
  first-party `bulwark-mobile` exists (row 3).
- Accounts signed in through the app's own client before the upgrade keep
  their data-only grant; Settings keeps saying the administrator has to
  approve the app (row 5).

Other 1.0.3 items: PushSubscription with empty `types` (the app always sends
`EmailDelivery`, `src/lib/push-notifications.ts:227`, `:1571-1576`), the
`/copy` error text, OIDC issuer routing, blob encryption and compression,
role cache invalidation: no action.

#### 1.1.0 (2026-11-09)

Minor release. New: passkeys (x:Passkey, x:Passkey/registrationOptions,
three new `/api/auth` request types and two answers, `maxPasskeys`). Neither
the webmail nor the app uses any of it, so no row; see "New in 1.1.0". The
password `authCode` body the app sends is unchanged (v1.1.0
`crates/http/src/auth/oauth/auth.rs:130-145`; extra 0.16 fields are ignored,
no `deny_unknown_fields`). Fixes the app can see: PushSubscription/get now
returns `verificationCode` for verified subscriptions
(`crates/jmap/src/push/get.rs:124-136`); FileNode `role` must be unique per
account and isn't copied; `Email/set` refuses a body part that sets
Content-Type both raw and as a property; an RSVP on an invitation stored
without scheduling now sends the REPLY
(`crates/jmap/src/calendar_event/set.rs:1080-1094`,
`crates/groupware/src/scheduling/event_create.rs:54-69`). The app sets no
FileNode role and no raw body-part Content-Type, so none of these needs a
change. The login page gains a "Sign in with a passkey" button and
`autocomplete="username webauthn"` on the username field
(`resources/html-templates/login.html:177-211`).

Findings:

- [x] **Encryption at rest can't be turned back on, and shows "Disabled" while it is on** — `P1` — `bug` (Stalwart 1.0.2) — fixed in b82be4bd
  - What Stalwart does: `EncryptionAtRest` is `Disabled | Enabled(EncryptionSettings)` with a new `headerProtection` (None, NoConfidentiality; Baseline is refused for at rest) (v1.0.2 `crates/registry/src/schema/structs.rs:3138-3154`, v1.1.0 `crates/jmap/src/registry/mapping/public_key.rs:245-290`, `crates/jmap/src/registry/mapping/account.rs:116`). Release note: "accounts that had encryption at rest enabled are set to Disabled on upgrade. Until a user (or an administrator) selects their public key again ... new messages for that account are stored unencrypted."
  - What RN does: the type is `'Disabled' | 'Aes128' | 'Aes256'` (`src/api/account-security.ts:16`); the read maps anything but Aes128/Aes256 to Disabled (`:172-177`, `:232-247`), so an enabled account shows "Disabled"; the save sends `'@type': 'Aes128'|'Aes256'` (`:259-284`), which 1.0.2 refuses, and the screen offers only those two (`src/components/settings/AccountSecuritySettings.tsx:823-827`). The webmail has the same bug (`stores/account-security-store.ts:14`, `:460`, `:497`; `components/settings/account-security-settings.tsx:632`, `:798`), so there is no webmail fix to port.
  - Fix hint: read `Enabled` as on; on a server that answers with `Enabled` (or refuses `Aes*` with invalidPatch), send `{ '@type': 'Enabled', publicKey, encryptOnAppend, allowSpamTraining }` and drop the algorithm picker; keep `Aes128`/`Aes256` for 1.0.0/1.0.1 and 0.16. Tell the user after the upgrade that it is off. Live test: live-stalwart-secure-mail.test.ts, "turns encryption at rest on with a key and reads it back as on" (1.0.2+: `Enabled`; older: `Aes256`), then off again.

- [ ] **Encrypted mail from a Stalwart encryption gateway keeps "[...]" as its subject after the app decrypts it** — `P3` — `missing` (Stalwart 1.0.2)
  - What Stalwart does: the new outbound encryption gateway can apply RFC 9788 header protection that replaces the outer Subject with `[...]` and adds a legacy-display part (v1.1.0 `crates/crypto/src/mime/entity.rs:17-19`, `crates/crypto/src/mime/legacy.rs:14`). It is off unless the admin sets `gatewayHeaderProtection` (`crates/registry/src/schema/structs.rs:3120`, default None). The recipients are on other servers, possibly reading in Bulwark.
  - What RN does: decryption returns only body and attachments (`src/lib/crypto/secure-message.ts:59-65`, `:124-131`); the list and reader keep the outer Subject. The webmail has no RFC 9788 handling either. P3 because it needs a non-default server setting on the sender's side.
  - Fix hint: after decrypting, take Subject (and the other protected headers) from the inner part when the outer one is `[...]` or the part has `hp=`, and hide a `hp-legacy-display` part. Live test: live-stalwart-secure-mail.test.ts, "a PGP message with header protection shows the inner subject" (build the message locally; the rig's gateway can't send to itself).

- [x] **Two-factor sign-in fails on Stalwart 1.0.0 and 1.0.1 unless the admin registered bulwark-mobile** — `P1` — `bug` (1.0.0/1.0.1; caused by native d345d15b, which relies on 1.0.2) — fixed in 95f0f8f4
  - What Stalwart does: before 1.0.2 a scope name the server doesn't know fails the whole authorization request with `invalid_scope` for any client with a scope list (v1.0.1 `crates/http/src/auth/oauth/authorize.rs:331-345`, the check at `:339`); only a first-party client skips the check. The same check runs for GET /api/auth/client and POST /api/auth.
  - What RN does: the TOTP sign-in always asks for `STALWART_LOGIN_SCOPE`, which now names `urn:stalwart:oauth:scope:security` and `:settings` (`src/lib/totp-login.ts:87-92`, used at `:342`, `:206` and as the check scope at `:301`). On 1.0.0/1.0.1 the app's own registered client (`swc1.*`) is then refused; the retry at `:536-547` gets the same sealed client id and gives up, so the user sees "client rejected". The browser sign-in is not affected: it adds the scopes only when the discovery document lists them (`src/lib/oauth-native.ts:157`). The live suite would show it on stw-rel (1.0.1) without bulwark-mobile: `password through the structured endpoint` (`src/api/__tests__/live-stalwart-auth.test.ts:225-233`) calls exchangePasswordForTokens without a mobile client. I did not run it.
  - Fix hint: decide the scope like pkceScopes: add STALWART_ACCOUNT_SCOPES only when `/.well-known/oauth-authorization-server` lists them (or retry without them on `invalid_scope` from an `swc1.` client), and send the same string to the client check, the registration and `stalwartLoginBody`. Live test: live-stalwart-auth.test.ts, "two-factor sign-in with the app's own client works on 1.0.1 and on 1.1.0" (run against stw-rel before and after its upgrade, without bulwark-mobile).

- [x] **On a server set up by the webmail, the app never gets full access: deleted-mail recovery disappears and admins lose their alias lookup** — `P2` — `partial` (Stalwart 1.0.3) — fixed in be9d8b3a
  - What Stalwart does: with first-party clients gone, only a token carrying `urn:stalwart:oauth:scope:full` is unrestricted (`crates/common/src/auth/oauth/scope.rs:543-552`). x:ArchivedItem and x:Account permissions are in no scope table (`:236-515`), so `security`/`settings` tokens get `forbidden`. A client allowed `{data, full}` refuses a request naming `security` or `settings` (`crates/http/src/auth/oauth/authorize.rs:331-351`; FULL does not contain the SECURITY bit, `scope.rs:56-62`).
  - What RN does: always asks for `security settings`, never `full` (`src/lib/totp-login.ts:79-92`, `src/lib/oauth-native.ts:157`). The webmail's OAuth setup on 1.0.3+ registers `bulwark-mobile` with `{mail, contacts, calendars, files, full}` for a superuser admin (webmail `app/api/admin/oauth/setup/route.ts:257-271`, `:576-579`, `:298-323`; 34a37c29b, #1527), so the app's check (`src/lib/totp-login.ts:303`) fails and it registers its own client. Then Recover deleted items (`src/api/archived-items.ts:66`, hidden by `src/lib/recovery/use-deleted-items-recovery.ts:35`) and the admin's x:Account/get (`src/api/account-security.ts:372`, aliases in `src/lib/calendar-user-addresses.ts:8`) stop working; a 1.0.0-1.0.2 first-party bulwark-mobile reached both. With a non-superuser setup (`{data, security, settings}`) the app does use bulwark-mobile, but still without `full`.
  - Fix hint: on 1.0.3+ check bulwark-mobile first with the data scopes plus `full`; if it takes them, sign in with that scope string, else fall back to `security settings`, else register. Carry the chosen scope in LoginClient so the check, `stalwartLoginBody` and the PKCE URL agree. Live test: live-stalwart-auth.test.ts, "with bulwark-mobile allowed full, the app signs in as bulwark-mobile and x:ArchivedItem/query is not forbidden" (needs register-mobile-client.py to grant `full`, see Test rig).

- [ ] **Account security stays locked after the server moves to 1.0.3, and the notice blames the administrator** — `P3` — `bug` (Stalwart 1.0.3)
  - What Stalwart does: a grant keeps the scopes it was issued with (`crates/common/src/auth/oauth/grant.rs:116-123`); a grant from the app's own client before 1.0.3 has data scopes only and still gets no `urn:stalwart:jmap`. A new sign-in on 1.0.3 gets `security` and `settings`.
  - What RN does: shows the restricted notice for an `swc1.` client without the extension (`src/api/account-security.ts:103-106`, `src/components/settings/AccountSecuritySettings.tsx:961-965`), worded as "Your server lets only apps its administrator approved change ..." (`:1029`). Signing in again would fix it, and nothing says so.
  - Fix hint: when the discovery document lists `urn:stalwart:oauth:scope:security`, say "Sign in again to manage these settings here" with a button that re-runs the sign-in for this account. Live test: live-stalwart-auth.test.ts, "a token from the own client without security scope reports a limited sign-in; a fresh sign-in on 1.0.3+ does not".

- [ ] **Code comments and the restricted-notice text still describe first-party clients** — `P3` — `docs` (Stalwart 1.0.3)
  - What Stalwart does: no first-party clients since 1.0.3; access comes from scopes.
  - What RN does: `src/lib/totp-login.ts:60-64` ("public and first-party"), `src/api/account-security.ts:84-90`, `:98-103` ("only to first-party clients", "the session then lists no Stalwart extension"), `src/components/settings/AccountSecuritySettings.tsx:920-921`, `:1029`.
  - Fix hint: describe the scopes (1.0.0-1.0.2 first-party, 1.0.3+ `security`/`settings`/`full`). Live test: none needed beyond the rows above.

- [ ] **The live auth suite expects 1.0's old client rules and breaks on 1.0.3 and later** — `P2` — `test` (Stalwart 1.0.3)
  - What Stalwart does: an `swc1.` client registered with `security settings` reaches account security (`crates/common/src/auth/oauth/scope.rs:469-515`, `crates/jmap/src/api/session.rs:248`); a bulwark-mobile without scopes still passes a check that names no scope.
  - What RN does: `hasMobileClient` is probed without a `scope` parameter (`src/api/__tests__/live-stalwart-auth.test.ts:160-174`), so a scope-less bulwark-mobile (what register-mobile-client.py leaves on 1.0.3+) counts as present while the app itself skips it, and `expectV1Client` (`:135-138`) fails. "account security: 1.0 refuses it to the registered client" (`:273-287`) expects `forbidden` for an `swc1.` client, which 1.0.3+ no longer gives.
  - Fix hint: probe with the app's own scope string; split the expectation by whether discovery lists `urn:stalwart:oauth:scope:security`. Live test: the two cases above, rewritten; run against stw-rel at 1.0.1 and after the upgrade.

- [ ] **An expired password reads as a wrong password, or signs in to an app that can read nothing** — `P3` — `bug` (Stalwart 1.0.0, changed in 1.0.3)
  - What Stalwart does: `/api/auth` answers `{type: 'expired'}` when the main password has expired and the requested scopes don't allow a password change (v1.1.0 `crates/http/src/auth/oauth/auth.rs:727-740`). From 1.0.3 a request with `security` (the app's) is let in instead, and the token keeps only the password-change permissions (`crates/common/src/auth/access_token.rs:637-680`).
  - What RN does: `expired` falls to the default branch and becomes invalid_credentials (`src/lib/totp-login.ts:427-428`). On 1.0.3+ the TOTP sign-in succeeds and every mail call then fails. Only reachable with password plus TOTP; Basic sign-ins are unaffected by OAuth scopes. The webmail doesn't handle it either.
  - Fix hint: map `expired` to its own error ("Your password has expired. Change it in the server's web interface."), and after a 1.0.3+ sign-in whose session lists no mail account, open the password change. Live test: live-stalwart-auth.test.ts, "an expired password is reported as expired" (needs an account with an expired password on the rig).

Counts: 8 rows. P1: 2, P2: 2, P3: 4. By type: bug 4, missing 1, partial 1,
test 1, docs 1.

No action:

- 1.0.2 Email/import and IMAP APPEND send EmailPush with the message id: the app's filter is Inbox-only (`src/lib/push-notifications.ts:410-420`), so only Inbox appends notify, now with a real message instead of the empty-push fallback.
- 1.0.2 Email/queryChanges with collapseThreads: the list's queryChanges never sets collapseThreads (`src/api/email.ts:676-688`, `:744-750`); the widgets that do (`src/widgets/jmap.ts:167`) don't use queryChanges.
- 1.0.2 inline `cid` parts go into `multipart/related`: the app sends them as `attachments` with `cid` and disposition (`src/api/email.ts:1671-1682`); they now display in the body at the recipient, and a re-opened draft still finds them under attachments (`:2024`).
- 1.0.2 `notFound` for Email ids destroyed by a thread merge: callers already treat notFound as gone (device sync `src/device-sync/engine/contacts-sync.ts:698` is the pattern; the mail store drops unknown ids).
- 1.0.2 upload endpoint refuses accounts the caller isn't a member of: every app upload goes to the primary account (`src/api/blob.ts:85-90`); cross-account files use Blob/copy (`src/api/email.ts:2687`).
- 1.0.2 app passwords and API keys refused at `/api/auth`: the app sends a plain password over Basic auth (`src/api/jmap-client.ts:317`), only password plus TOTP goes to `/api/auth`.
- 1.0.2 x:PublicKey fills `emailAddresses`/`expiresAt` from the key and adds `kind`, `keyType`, `fingerprints`, `capabilities`, `warnings`: the app sends `emailAddresses: {}` (`src/api/account-security.ts:315-320`) and reads only id, description, addresses, dates (`:286-299`), so the list now shows the key's addresses. The webmail doesn't read the new properties either.
- 1.0.2 Mailbox/set name length, IMAP, Milter, DKIM/DKIM2, search indexing, telemetry, vCard/iCal quoted-printable charset, iTIP SEQUENCE, `mayWriteOwn` without calendar address, DestroyAccount, `Connection: close` on early errors, 500 on bad header values, Application `oauthScopes`, OIDC `trustedProvider`, new login page look (ui.css/ui.js; the Maestro texts "you@example.com", "••••••••", "000000", "Sign in", "Allow" are unchanged in v1.1.0 `login.html:177-230`): no app impact.
- 1.0.3 PushSubscription empty `types`: the app never sends an empty list (`src/lib/push-notifications.ts:227`, `:258`).
- 1.0.3 `/copy` with equal account ids: only the error text changed; the app copies only across accounts.
- 1.0.3 Core capability needs any data or Stalwart scope: every app token has data scopes.
- 1.0.3 refresh tokens: unchanged apart from the expired-credential rule (row 8); grants from first-party bulwark-mobile keep full access (`crates/common/src/auth/oauth/grant.rs:116-123`), so signed-in users are not logged out by the upgrade.
- 1.0.3 iTIP rewrite (`crates/groupware/src/calendar/itip.rs`), blob encryption/compression, BlobRecode, `STALWART_UPDATE_ROLE_PERMISSIONS`, OIDC issuer routing, role cache: server side.
- 1.1.0 PushSubscription/get returns `verificationCode` once verified: the app already asks for the property (`src/api/push.ts:35`) but decides verification from the relay (`src/lib/push-notifications.ts:1246-1247`, `:1610-1612`). It could re-verify a subscription that reads back `null`; the webmail doesn't do this either (`lib/web-push.ts:719`). Optional live case in live-stalwart-push.test.ts: "a verified subscription reads back its verificationCode on 1.1.0".
- 1.1.0 FileNode `role` unique per account, not copied: the app sets no role (`src/api/files.ts`, no `role` in any create or update).
- 1.1.0 `Email/set` raw `header:Content-Type` on body parts: the app sets only message-level raw headers (`src/api/email.ts:1695`, `src/lib/message-priority.ts:19-26`).
- 1.1.0 RSVP on an invitation stored without scheduling now sends the REPLY: the app's RSVP is a participationStatus patch with `sendSchedulingMessages` (`src/components/email/CalendarInvitationBanner.tsx:250`); it now reaches the organizer where it silently didn't. Optional live case in live-stalwart-event-notifications.test.ts: "RSVP on an imported invitation produces a REPLY to the organizer".
- 1.1.0 x:Account credentials can include `Passkey` entries: the app reads no credentials from x:Account (`src/api/account-security.ts:374-395`).
- 1.1.0 MTA, Milter, DKIM, ACME, storage, cluster, Keep, enterprise queue scoping, queued-message blob download: server side.

#### New in 1.1.0

| What | Kind | Webmail | App |
|---|---|---|---|
| x:Passkey (get, set, query; `description` editable, `createdAt`, `registration`) | registry object, `urn:stalwart:jmap` | not used (no `x:Passkey` in lib, stores, components, app, hooks) | not used |
| x:Passkey/registrationOptions (`accountId`, `currentSecret`, `otpCode` → WebAuthn `publicKey` creation options) | method (`crates/jmap-proto/src/method/passkey.rs:12-71`, `crates/jmap/src/api/request.rs:774-781`) | not used | not used |
| `/api/auth` `{type: 'passkeyOptions'}` → `{type: 'passkeyOptions', challenge, rpId, timeout}` | login request/answer (`crates/http/src/auth/oauth/auth.rs:164`, `:205-211`, `:363-377`) | not used | not used |
| `/api/auth` `authCodePasskey {credential, query, consent}`, `authDevicePasskey {credential, code, consent}`, answer `passkeyUnknown` | login request/answer (`auth.rs:165-180`, `:212`) | not used | not used |
| "Sign in with a passkey" button and passkey autofill on the built-in login page | login page (`resources/html-templates/login.html:177-211`) | reached only through the browser sign-in; nothing to build | reached through the browser sign-in (oauth-native) when the server is the authorization server; the password form can't use it |
| `sysPasskeyGet/Create/Update/Destroy/Query` permissions, in the `security` scope | permissions (`crates/common/src/auth/oauth/scope.rs:482-486`) | n/a | covered by the `security` scope the app already asks for |
| `maxPasskeys` in Authentication settings and as account quota | setting | not used | not used |
| PushSubscription/get `verificationCode` for verified subscriptions | behaviour change, not a new property | not used | not used (see No action) |

No new capability URN, no session change and no new JMAP standard method in
1.1.0 (session.rs is unchanged since 1.0.3). Nothing here is used by the
webmail and missing in the app, so 1.1.0 adds no row. Passkey management in
Settings and a passkey sign-in in the app would be new features on both
sides.

#### Test rig (VM 106, read only)

Read: /opt/stw-test/README.md, servers.conf, rel_setup.sh,
register-mobile-client.py, seed.py, run-container.sh and the bootstrap and
provision parts of stw.py. Nothing under secrets/ was opened. servers.conf:
stw-v016 v0.16.27, stw-v1 a local 1.0 build (4fb4420b5), stw-rel
`stalwartlabs/stalwart:v1.0.1` on http://10.10.10.62:8120.

What breaks or misleads on 1.1.0:

- rel_setup.sh: the 1.0 adjustments are switched on by `"v1.0" in stw.server(name)["image"]`. The tag `stalwartlabs/stalwart:v1.1.0` doesn't contain `v1.0`, so on a fresh 1.1.0 stw-rel none of them apply: x:Bootstrap/set sends `serverHostname` (1.1.0 has only `defaultHostname`), x:Http/set sends `useXForwarded` (gone in 1.x), and the TOTP accounts are created with `otpAuth` instead of `otpUrl`. Bootstrap fails first. Match on `v1.` (or "not v0.").
- register-mobile-client.py: sends `firstParty: True` and no `scopes`. From 1.0.3 the server accepts the call and drops `firstParty`, leaving a client that allows only `openid offline_access`. The script prints success; the app then skips bulwark-mobile (its check names data and account scopes) and registers its own client, and the live suite's `hasMobileClient` probe (no scope) still says it exists. Send `scopes: {mail, contacts, calendars, files, security, settings}` to mirror the webmail's non-superuser setup, and a variant with `full` instead of `security, settings` to mirror the superuser setup (row 4); the recovery admin is a superuser, so `full` is allowed.
- Upgrading stw-rel in place: run-container.sh starts the container with `STALWART_PUBLIC_URL=https://$HOST`, and stw-rel's HOST is `10.10.10.62:8120`, which serves plain HTTP (rel_setup.sh uses `http://`). An in-place upgrade through run-container.sh would advertise https URLs that don't answer. It also never sets `STALWART_UPDATE_ROLE_PERMISSIONS=true`; without one start with it, the upgraded default roles miss the 1.0.2 encryption permissions and the 1.1.0 `sysPasskey*` permissions. Fresh installs (rel_setup.sh) get them anyway.
- Encryption at rest after an in-place upgrade from 1.0.1: any test account that had it on is Disabled (1.0.2 note); a live test for row 1 must turn it on itself.
- seed.py: the request shapes still work on 1.1.0. `TotpJmap` (`/auth/register` with data scopes, `/api/auth` `authCode` with `query` and `consent: true`, token exchange) matches 1.1.0's `AuthCode` variant; its tokens carry data scopes only, which is all the seed needs (Sieve is in the mail scope). FileNode creates fall back to `@type`/`mediaType` as before and set no `role`. Uploads into the `team` account pass the 1.0.2 membership check because usera is a member. The newsletter's inline image is imported as built (`multipart/related`), so the 1.0.2 change to Email/set doesn't touch it.
- stw.py check reads `useXForwarded` from x:Http/get; on 1.x that property doesn't exist. I did not check whether 1.1.0 answers an unknown property with an error or ignores it.
- Passkeys can't be tried on stw-rel as configured: the relying party id is the host of the public URL (release note) and WebAuthn needs HTTPS or localhost, so `http://10.10.10.62:8120` gets `failure` for `passkeyOptions` (`crates/http/src/auth/oauth/auth.rs:363-377` returns Failure when `PasskeyRp::from_issuer` gives none). A public HTTPS name (as stw-v016/stw-v1 have) is needed.

#### Could not check

- Whether the 1.1.0 login page's `autocomplete="username webauthn"` makes Chrome Custom Tabs or ASWebAuthenticationSession pop a passkey sheet when Maestro taps the username field (`.maestro/subflows/stalwart-login-page.yaml`). Needs an emulator run against a 1.1.0 server with an HTTPS name. The CI e2e server is 0.16, so CI isn't affected yet.
- I did not run any live suite; row 3 and the test-rig points come from reading the source of both versions, not from a request against stw-rel.
- Whether x:ArchivedItem answers `forbidden` (as the scope tables say) or another error to a `security`/`settings` token: the recovery hook hides the entry on any refusal, so the user-visible result is the same, but the live case in row 4 should assert the type.
- The 1.0.2 vCard fix for yearless `--MM-DD` dates is in the calcard dependency; I could not tell from the Stalwart diff whether JMAP ContactCard writes (device sync, `src/device-sync/engine/contacts-sync.ts`) were affected, or only CardDAV uploads.
- Whether the admin of a real 1.0.3+ server who ran the webmail setup as a superuser is common enough to make row 4 more than P2; the setup prefers `full` whenever the admin may grant it (webmail `app/api/admin/oauth/setup/route.ts:576-579`).
- The webmail's 1.0.3 scope work arrived through merge 34a37c29b (#1527) without its own commit on main, so I cite the merge.

### Leftovers of docs/native-sync-2026-11.md

#### RESULT PENDING lines

- iOS e2e run 41220976434 (43bf8da7): red. Build and signin-phone passed,
  79 of 87 flows passed, no failure points to an app bug:
  - 07-move-delete-tag on all five feature legs: the flow looked for
    "Move to..." (fixed on main in b9dcbdea).
  - 12-settings in landscape: the simulator garbled the search text and the
    Storage row sat under the keyboard (fixed on rel-ios-e2e, ef31d6f1).
  - signin-tablet 01-password: "iOS driver not ready in time", the Maestro
    driver never started.
  - signin-tablet 15-email-discovery: the iPad dropped the first characters
    of a bare `inputText`; the flow doesn't use subflows/type.yaml. Not
    fixed anywhere.
  - phone-dark 02-read-messages: flake (the reader didn't close).
- The eleven e2e-ios runs after it are all red. The 0.1.91 and 0.1.92 runs
  fail mostly on dirty accounts: "E2E incoming" mail from earlier runs pushes
  the seeded messages below the fold, and stw-v016 was last reset before
  41220976434. Also tablet 07 and the landscape settings flow (both fixed on
  rel-ios-e2e) and driver flakes. The sign-in failures after d345d15b
  (03-totp-password, 04-oauth, 12-link-expired, 17-add-oauth, 07-webmail-totp)
  were not examined; the e2e server is stw-v016 (0.16.27), so they need a
  look against the scope change before they count as flakes. The test
  phase reruns the full matrix.
- Android emulator recheck and the quick-crypto self-test on Hermes: no
  result recorded anywhere. Both are part of the emulator walkthrough. The
  self-test is Settings > Encryption > "Run check"
  (src/lib/crypto/self-test.ts:161, src/components/settings/EncryptionSettings.tsx:225-236).

#### rel-ios-e2e

Six commits from 2026-11-02/03, flows and scripts/e2e only (5 files,
+53/-27). They fix the tablet 07 failure (wait for the selection bar to
close, fc73bf83) and the landscape settings failure (search for a word only
the Storage page has, ef31d6f1), retry a flow when the Maestro driver dies
(923f9d8e; its grep misses "iOS driver not ready in time") and print the
failed steps (a3e3ae9e, ab7e0b90). Both full runs on the branch passed 07 and
the landscape settings on every feature leg. `git merge-tree` against
origin/main is clean.

#### Open list

Fixed since: the custom From sheet when customFromEnabled is off
(b58c9dd7), no-third-party counted as off before /api/config (f11aea8a,
f173358e), Archive on the Android widget (762ec6ba), an expired session
dropping the composer (4d21adce). Still open: org signature details (needs
settings sync), group-identity policy scopes, mailbox share presets ignoring
sharingRights, idle sign-out and session length, external sender chip and
recipient confirm, PGP Argon2 and legacy S/MIME ciphers (by design), the iOS
Swift never run on a device and the widget left out of signed releases, the
bigger APK, nested tag rename and move, global search capped at about 500
files of other logins, Jalali pickers and widgets, accessibility extras,
composer extras and the BIMI verified mark, and the older list (run a rule
on a folder, #1141, settings sync on 0.16, background reminder refresh, real
APNs, camera QR scan, SSO pairing, discovery success).

#### The six questions of the last report

1. Dutch: the app overlay has 114 strings in the "u" form and 79 in "je";
   the webmail catalog mixes too (512 je, 253 u). Still a decision.
2. English source strings: every flagged key still has its problem (Title
   Case titles, plurals, fragments, desktop words, stale "Android only"
   push texts, " - " and em dashes, UK/US spelling mix).
3. ios-perf: never re-measured; no e2e-ios run since the merge ran the perf
   leg.
4. The webmail commits fb3ba0275, f74ff49f5, 3bdbdb136 are on webmail main
   and in 1.20.0; website 7292593 is pushed. Nothing left to push.
5. iOS widget: no IOS_WIDGET_PROVISIONING_PROFILE_BASE64 secret; signed
   releases leave the widget out (plugins/ios-widget/index.js:145). The App
   ID at Apple can't be checked from here.
6. Export compliance: af580e9f (on main) and 37b93729 (local main, unpushed)
   declare `usesNonExemptEncryption: false`, so nobody files documentation.
   Whether other export obligations apply is not a code question.

#### Older parity files and audits

49 unticked rows in docs/parity/01-11: 36 still open (4 P2, 32 P3), 3 done
but unticked (04 templates sync on Stalwart 1.0 fac318dc, 08 RTL 990cd84,
11 expired session 4d21adce), 2 blocked (settings sync, org signature
details), 8 not to do with the reasons the rows give. The four open P2s are
org policy rows (share-rights limit and group identities, session limits,
external sender chip, external recipient confirm). The webmail's policy
route takes the app's bearer token since 1.20.0, so none of them is blocked
any more. ux-audit-2026-10: the five unticked items are not to do (U-016,
and decision 12). ios-test-2026-10: the e2e matrices are still empty (P2);
camera, SSO, discovery and APNs need a device or setup; the iOS widget needs
the App ID and the secret.

#### Webmail bugs from the last report

Fixed in the webmail since: the filter-rule folder picker names (494ee5694),
the composing-settings locks (8905d31b3), the push device client id check
(f0617a61b), the smime plugin keyUsage (plugins 3051115). Partly fixed: the
vacation filter re-include (raises an error only with forwarding or an
audience), the raw relay error text (8b4fb7235 covers the common errors),
HELO SPF (skipped with several results, still counted with one). Every other
item is still open at 2c21722ae; bulwark-gpg is a third-party repo with no
commits since 2026-08-02.

### GitHub (bulwarkmail/native)

Releases: 0.1.92 (2026-11-05) is the latest; the 25 commits after it are in
no release.

| Issue | State on main | Release | Action |
|---|---|---|---|
| #3 | Android done; iOS built, never run on a device; the new native push lookup (#94) has no client certificate | 0.1.83 / 0.1.88 | keep open for iOS |
| #84 | fixed 14d009de | 0.1.88 | close |
| #85 | fixed 2fe83669 + 9669e07e on Android; iOS mail notifications have no actions | 0.1.88 | close |
| #86 | fixed 65f00640 | 0.1.88 | close |
| #91 | avatar tap selects in the folder list (6715df7f); not in the unified inbox or extra-compact rows | 0.1.88 | close with a follow-up row |
| #93 | PR #103 | none | see decisions |
| #94 | fixed on main up to 7616cb07 | unreleased | release, wait for the reporter |
| #95 | fixed 9b28c009 | unreleased | release, wait for the reporter |
| #96 | PR #101 (Android) | none | see decisions |
| #98 | fixed b2002361, 8275a305, 08029dda; other charsets than UTF-8 and windows-1252 still decode wrong in client-parsed mail | unreleased | release, wait for the reporter |
| #104 | not fixed: the list width ignores the tab rail and the reading pane has no minimum (src/screens/MailTab.tsx:51, :99, :123; src/lib/use-layout.ts:27-33, :44-46) | | P2 row |
| #105 | PR #106; cause `headerActions` `flex: 1` (src/screens/ContactsScreen.tsx:740) | | see decisions |

#85 and #91: the report called them fixed, and the code does what each
reporter asked in the main case (Delete from the notification no longer
needs an unlock when the account has a Trash, and the broadcast action
doesn't collapse the shade; a tap on the avatar selects). Nobody closed
them after 0.1.88.

PRs, all from wmcparla, all merge cleanly into ce5d4dd4 with CI green, no
shared file between them; every commit carries a Co-Authored-By trailer:

- #106 (ContactsScreen.tsx only): correct Yoga fix for #105. Merge as is.
- #103 (settings-store, use-layout, MailTab, UnifiedInboxScreen,
  EmailListScreen, use-message-pane, LayoutSettings, push-prompt-frame, four
  English strings): a device-local "Reading pane: Auto / Off". Close to the
  webmail's `mailLayout` focus mode. Needs the other 28 languages; the
  first frames before settings hydrate still show the split. Must land
  before the #104 fix, which touches the same lines.
- #101 (Kotlin push path, push-notifications, push-background-task): Android
  subscribes to `Email` too and removes notifications whose message was
  read, moved or deleted elsewhere. New behaviour (the webmail doesn't do
  this, and the app dropped `Email` from the subscription on purpose
  earlier). Every change on any client then sends a HIGH-priority FCM push
  to every Android device, most showing nothing, which risks FCM lowering
  the app's priority and undoing #94; the foreground listener syncs again
  on each; Android 7 subscribes without using it. Needs the relay to send
  `NORMAL` for change-only pushes first (repos/relay src/fcm.ts:168).

### Dependencies

Expo SDK 54 (54.0.38, the newest SDK 54 release; no patch since
2026-10-21). Newest stable is SDK 58 (58.0.24). npm audit: 18 findings
(2 high, 15 moderate, 1 low), all in the Expo CLI and Metro build chain;
none ships in the app.

- On SDK 54 now: postal-mime 4.2.1 (security release for the parser that
  reads untrusted .eml; the local patch applies unchanged, rename the patch
  file); a lockfile refresh within ranges (node-forge 1.4.3, nitro 0.37.2,
  native, so it rides with the next build). Optional: zustand 5.1.0
  (hydration goes through a Promise in 11 persisted stores, no known bug
  fixed), datetimepicker 8.4.7 and react-native-webview 13.16.2 (iOS crash
  fixes, outside Expo's pins).
- With an SDK bump (own project, through SDK 57 first): clears both highs;
  brings Gradle 9 and AGP 9 hand edits in android/, iOS SceneDelegate (the
  ios-push plugin edits the AppDelegate), async File.write, webview 14,
  react-native-android-widget 0.26 (both fixes of the local patch are
  upstream, so the patch can go).
- Skip: AsyncStorage 3, pkijs 4 and asn1js 4 (ESM-only), webview 15-17.

### Overlap with the security audit branch

fix/security-audit-2026-11 (worktree react-native-security) is 25 commits
on top of ce5d4dd4, last merged with main at 11:37 on 2026-11-12, 80 files.
Its native-ci and native-push batches haven't run yet (native-push waits
for relay-owner), so more native commits will come. It is not on GitHub.
It doesn't use stw-rel; its sec-* accounts live on stw-v016 and stw-v1.

Files both runs will touch:

- src/stores/policy-store.ts, src/lib/org-policy.ts: every organisation
  row (P1 remote content lock, device rules, announcement, session limits,
  external mail, labels). The security branch adds the per-identity policy
  resolution and push without content here.
- src/components/EmailBodyView.tsx, src/lib/email-html.ts,
  src/lib/quote-collapse.ts, src/lib/mail-reading.ts: the P1 remote content
  lock, phishing link stripping, quote folding for iPhone Mail and Outlook,
  inline images in plain-text view.
- src/lib/push-notifications.ts, src/lib/push-background-task.ts and the
  Kotlin push classes: #96/PR #101, notification Archive and Copy code
  actions, push catch-up.
- src/lib/oauth.ts, src/lib/oauth-native.ts, src/lib/login-errors.ts: the
  Stalwart 1.0.3 scope fixes and the expired-password error.
- plugins/ios-push/*.swift: iOS client certificates in the notification
  extension (#3).
- src/lib/email-export.ts, src/lib/file-preview.ts: the no-export and
  no-download device rules.
- locales/rn/*.json (all 29) and app.config.js.


## Plan (Phase 1)

Owners are build agents, each in its own worktree under
C:\Users\info\worktrees\ on a branch off `catch-up-2026-11b`, with disjoint
files, at most four at once. "P12" means a row in
docs/parity/12-webmail-1.20-to-1.21.md, "S" the Stalwart rows above, "L"
the leftovers, "GH" the GitHub table. Build agents don't touch locales/:
they use `t(key, fallback)` and list their new keys; the i18n agent adds
them to all 29 languages at the end.

Order:

0. Before wave 1 (coordinator): merge rel-ios-e2e and the approved PRs
   (#106, #103 with the author's commits kept, my changes on top).
1. Wave 1: auth, mail, compose, pim.
2. Wave 2: org, push-sync, layout-ios, plus the stw-rel upgrade.
3. Wave 3: i18n; dependencies in their own worktree (only if approved).
4. Merge main in if the security branch has landed; tests; review.

### Security

- P1 remote content stays blocked for trusted senders when the
  organisation locks or limits External content to "block" (P12). Owner: org
  (wave 2, in policy-store next to the security branch's changes).
- P2 Report phishing and links turned off on `$phishing` mail (P12) —
  mail.
- P1 encryption at rest on Stalwart 1.0.2+ (`Enabled` instead of
  `Aes128`/`Aes256`) (S). Owner: auth.

### Auth and accounts

- P1 two-factor sign-in on Stalwart 1.0.0/1.0.1 broken by d345d15b (S) —
  auth. First confirmed with the live auth suite on stw-rel while it still
  runs 1.0.1, then fixed, then rerun after the upgrade.
- P2 ask bulwark-mobile for `full` when the webmail set it up that way (S);
  P2 live auth suite for 1.0.3+ (S); P3 locked notice after the upgrade,
  first-party comments, expired password (S). Owner: auth.
- P2 masked addresses (P12); P3 old grant left open on a new sign-in,
  account security on Inbuxa, server settings for other mail apps, link to
  the server's account page, Gmail/Outlook/iCloud explanation, language
  before sign-in, unread counts in the account switcher (P12). Owner: auth.
- P3 subject of mail with RFC 9788 header protection (S). Owner: auth (it owns
  secure-message.ts for this one).

### Mail

- P2 folder lists over the server's get limit, P2 tags with non-Latin
  names, P2 deleted-item recovery on Stalwart 1.0 (P12). Owner: mail.
- P3 rows of P12 "Reading mail", "Attachments", "Mail list", "Search",
  "Folders and tags", "Import and export". Owner: mail, except the deferred ones
  below.
- P3 #91 tap to select in the unified inbox and extra-compact rows (GH) —
  mail.
- P3 #98 other charsets in client-parsed mail (GH). Owner: mail.
- P3 older rows still open in 02, 03 and 10 for mail (L). Owner: mail, small ones
  only.

### Compose

- P2 template placeholders with a default (P12). Owner: compose.
- P2 classification labels in the composer and on received mail (P12) —
  org (wave 2), since it reads the organisation policy and needs the
  composer and the reader after waves 1 are merged.
- P3 compose rows of P12 (Tags menu, undo send default and 5 s, "Draft
  saved" notice, reply reusing a saved reply draft, forward header To/Cc,
  reply from the delivered-to address, template pictures, signature
  switches, save as template, recipient picker, link text, one send-check
  sheet, signature editor). Owner: compose.
- P2 external recipient confirm (L). Owner: org (wave 2), into the send paths
  compose leaves behind.

### Calendar, tasks, contacts, files, filters

- P1 saving a contact keeps what the form doesn't show (P12). Owner: pim.
- P2 HTML event descriptions, P2 repeating tasks, P2 regex filter rules
  (P12). Owner: pim.
- P3 rows of P12 "Calendar", "Tasks", "Contacts", "Files", "Filters and
  vacation". Owner: pim, except the deferred ones below.

### Settings, organisation and push

- P2 device rules (downloads, export, offline caps; push without content is
  on the security branch), P2 refused accounts hide their mail, P2
  announcement banner, P2 session limits, P2 external sender chip, P2
  mailbox share presets, P3 group identities, directory limit, default
  tags, attachment chips policy (P12, L). Owner: org.
- P2 push catch-up after a reconnect (#1553, four commits together) (P12) —
  push-sync.
- P3 Archive and Copy code notification actions, calendar notification
  paging and summary (P12). Owner: push-sync.
- P2 #96 per the decision on PR #101 (GH). Owner: push-sync.
- P3 native push lookup without the client certificate (GH #3). Owner: push-sync.

### Device sync and widgets

- Push catch-up and the 1.0.2 thread-merge `notFound` reach the device-sync
  engine: push-sync checks src/device-sync against both and adds tests.
- Widgets follow the device rules where they show mail (org hands the rule
  readers to push-sync). Owner: push-sync.

### Layout and iOS

- P2 #104 reading pane on foldables, after #103 (GH). Owner: layout-ios.
- iOS widget in signed releases: IOS_WIDGET_PROFILE in release-ios.yml and
  the export plist, guarded so a release still builds without the secret
  (L, question 5). Owner: layout-ios.
- e2e: 15-email-discovery through subflows/type.yaml, the driver-timeout
  retry pattern, a check that the 1.1.0 login page's passkey autofill
  doesn't block the login subflow (S). Owner: layout-ios.
- P3 iOS client certificates in the notification extension (GH #3) —
  layout-ios, compiled in CI only (no device).

### i18n

- Every new key of waves 1 and 2 in all 29 languages; the Dutch sweep
  (question 1); the English source pass (question 2); Greek, Norwegian
  Nynorsk and Vietnamese as new app languages (P12). Owner: i18n (wave 3).

### Dependencies

- postal-mime 4.2.1 and a lockfile refresh, in their own worktree with
  their own node_modules, last (question 11). Owner: coordinator.

### Proposed not to do in this run (reason)

- The webmail's offline database (encrypted store, offline search, drafts,
  calendar, contacts and files): a project of its own. This run takes the
  per-account and organisation offline caps only.
- App lock: needs a new native module (biometrics) and a dependency
  install; own project.
- Remote wipe from the admin: needs the webmail to register phones without
  a session cookie first.
- mbox and PST import, folder and account export, contacts CSV import,
  merging duplicate contacts, company calendars and one-step free/busy
  sharing, "Suggest times": large features with no bug behind them.
- Passkeys (1.1.0): neither the webmail nor the app uses them.
- Still from earlier: settings sync and the org signature details (no
  route for the app), reader view and read aloud (left to the OS), nested
  tag rename with message moves, Jalali pickers and widgets, the
  accessibility extras.

## Decisions

Taken on 2026-11-12, before the build ("do whatever makes the most
sense", so the recommendations stand):

1. Dutch: one form, "je". The app's "u" strings are rewritten; the
   webmail's mix goes on the webmail bug list.
2. English source strings: one pass in the i18n wave, plural changes
   carried into the other 28 languages.
3. ios-perf: e2e-ios is dispatched with `all,perf` (`all` leaves perf out).
4. The webmail and website hand-off commits are pushed (in 1.20.0);
   nothing to do.
5. iOS widget: release-ios.yml uses IOS_WIDGET_PROVISIONING_PROFILE_BASE64
   when it exists and leaves the widget out when it doesn't. The App ID
   org.bulwarkmail.mobile.Widget, its profile and the secret are for Linus.
6. Export compliance: 37b93729 stays; the branch is based on it.
7. PR #106: merged as is (64c61e53), the author's commit kept.
8. PR #103: merged with the author's commits (f712f015); on top: a test
   fix for Windows line endings 09947d8b, the strings in all 29 languages
   and the layout waiting for the stored setting. #104 goes on top.
9. PR #101: left with the author. The relay change (normal priority for
   change-only pushes) is made in this run on a local branch in
   repos/relay, not pushed or deployed.
10. rel-ios-e2e: merged first (cf5a55e8).
11. Security branch: build now; org-policy and push work in wave 2; main is
    merged in once the security branch lands, otherwise the overlap list
    goes with the hand-over.
12. CI: push only `catch-up-2026-11b`, with ci.yml's push trigger widened
    to `catch-up-*` in its own commit; no PR, no push to main; e2e-ios by
    workflow_dispatch on the branch. Local main isn't fast-forwarded as the
    run goes; the branch is the result.
13. Dependencies: postal-mime 4.2.1 and a lockfile refresh within ranges,
    in their own worktree, last. Skipped: zustand 5.1.0, datetimepicker,
    webview, the SDK bump.
14. Scope: every P1, P2 and P3 bug or partial row and the small P3
    features. Not in this run, with the reasons in the plan: the offline
    database (only the per-account and organisation caps are taken), app
    lock, admin remote wipe, mbox/PST import and folder/account export,
    contacts CSV import and duplicate merge, company calendars, "Suggest
    times", passkeys.
15. VM 106: stw-v016 is reset right before the e2e dispatch, after the
    coordinator log shows no sec agent running on 0.16 (their accounts are
    re-created with `ensure`). stw-rel stays on 1.0.1 until the 1.0.1
    sign-in fix is checked live there, then moves to 1.1.0 with
    rel_setup.sh and register-mobile-client.py fixed (backups kept).

Checked live before the build: on stw-rel (1.0.1) the live auth suite
passes 14 of 17 cases, and "a consentRequired answer is met with
authConsent" fails with `rejected`: a client registered with
STALWART_LOGIN_SCOPE (the 1.0.3 scopes) is refused by 1.0.1. That is the
two-factor sign-in P1 above. Sign-in through bulwark-mobile still works
there, because stw-rel has a first-party bulwark-mobile.
