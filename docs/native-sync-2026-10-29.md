# Native sync with webmail 1.18.0 and Stalwart 1.0.0 (2026-10-29)

Branch `feat/stalwart-1.0`: native main (f358d605) merged in, then the 1.0.0
release check, the webmail 1.10-1.18 parity fixes and the open native issues.
It is 200 commits ahead of main (181 without merges) and 0 behind. Nothing is
pushed.

At 595df26e (the last code change; only docs follow): `tsc` clean, vitest 323 files / 4911 tests pass
(113 skipped are the opt-in live suites), `i18n:check` passes. The app has no
lint script.

## What landed

Merge of main into the branch: f1db6b48 (19 conflicted files). Main's later
work won (iOS push and its notification extension, SafeAreaModal, file
preview, restyle and Tabler icons, token sign-in, notification mutes, device
sync); the branch's per-account routing, session epochs and refusal handling
were carried onto it. Notable calls: jmap-client keeps the branch's
epoch-safe credential writes plus main's shared-keychain writes and
`adoptStoredTokens`; auth-store keeps the branch's `signIn` helper and routes
main's token sign-in through it; push keeps the branch's SetError-only
narrowing plus main's device-sync types and mutes.

### Stalwart 1.0.0 (step 1)

- Sign-in: password + TOTP on 1.0 (96ef8515: one `/api/auth` body for both
  versions, RFC 7591 public client registered per server, redirect
  `org.bulwarkmail.mobile:/auth/callback` because 1.0 wants a dot in the
  scheme); browser sign-in with the registered client and Stalwart's data
  scopes (6ffd0473, a2caa4cc); refresh-token rotation (1456e15d, 28d928f6,
  cfd81737); no secret follows a redirect to another host (2c05e7bd,
  06d68d73, fe4f9211, 61654d7c); account security explains a limited client
  (c6eb02d4).
- Files: draft-18 `@type`/`mediaType` (174c3fc8), listing past
  maxObjectsInGet #1385 (7d8e0735), shared-folder writes per account
  (18b8aa09, 7c495d03).
- Mail: inline images that 1.0 lists only in the body parts (d2bb479a),
  quoted inline images in replies and forwards (913b3766), part names that
  are paths (4d545f8f), scheduled mail of own and group accounts with equal
  ids (15171637), bulk delete with partial refusals (547d9e59).
- Calendar #89: the branch's split CalendarEvent/get (28ade775) holds on the
  release; plus mail-only shares (f3e11d4c), 0.16 loads at DST changes
  (7c775571), account-switch races (1f190c94, e993540a, 41e8f005, 98dc13fe).
- Push: device-sync types retry only on a type refusal (20be1105), refused
  non-public relay explained and rolled back (4ec2ccac, 90e250d3), Android
  extends subscriptions in the background because both servers clamp expiry
  to 7 days (9804b499, ce47c73f), subscription id reuse (77327ea8), renewal
  for every account (d92a2ca8), logins sharing a JMAP account id
  (9ccb6228, b352e470), removed-account teardown (152f3089).

### Webmail parity 1.10-1.18 (step 2)

The inventory is docs/parity/10-webmail-1.10-to-1.18.md (ec7e8e05): 112 rows,
10 P1, 40 P2. 52 are ticked with their commits (fe33dfc5); every P1 and every
P2 that doesn't need the org policy is done. Highlights:

- Security (P1): HTML sanitizer rebuilt on a tokenizer, reader CSP
  `script-src 'none'`, composer script under a nonce (f5e997ba, 07679cbf,
  47a1d249, 440a2e7a, 4e3da668); forged DMARC/DKIM chips (ef9561f1,
  8adef1e1); mailto unsubscribe (942f4517, 918571c3); winmail.dat freeze
  (855d304b).
- Wrong-account writes (P1): composer pinned to its login (9daa3441,
  388f46b5, 4e57b191), undo/Send now per login (e81f0071), calendar and
  contacts switch guards (see above, 6b9552fc).
- Sieve interop (P1): webmail metadata v2, address/domain rules, elsif
  chains (2167a9d7, fc9c164d), plus forwarding, audience and periods
  (df1a5ab4).
- P2 features: scheduled message view #84 (14d009de), group identity send
  (31d8e4a4, 893f40a2), reschedule cancel-first #1308 (22f2ac5b,
  fdf8eece), unconfirmed send #1019 (3eac700a), Files trash (7c914183 and
  be04fcb1..946304ab), attach from and save to Files (8e07b7d8, 39e82f99),
  templates in account metadata and team templates (fac318dc), shared tags
  (b7b9c7e0), verification-code chip (b1550f14), unverified sender
  (cc21317b), search without Spam/Trash (a412b516, 2b5257bf), calendar
  search (b50270d8) and default reminders (9b87100a), feed changes reach
  imported events (8a71495e, 47f29718), directory browser (0fd14a83),
  rules from a message (d546d509), contact links and vCard (32f70c10,
  07fd03e2, 3c156673), placeholder warning (a8e7a3f4).

### Issues (step 3)

#80 96c7c045, #81 01983a38, #82 7a1031a9, #83 6f475c0c, #84 14d009de,
#86 65f00640, #87 e47c05c5, #89 (branch 28ade775, checked on the release).
#85 needs a decision (below). No issue was commented on or closed.

Every group got a separate review agent; review findings were fixed in a
follow-up round on each branch (two HIGHs in the composer, two pre-existing
HIGHs in the HTML handling, one in calendar feed sync).

## Verified live

Opt-in suites in src/api/__tests__/live-stalwart*.test.ts, run at the tip
against Stalwart 1.0.0 (stw-rel, :8120) and 0.16.27 (:8016), each with its
own e2e account. All pass on both: base 17, mail 14, compose 10, files 16,
push 11, contacts 9, calendar 22, auth 14 (with a TOTP account). The base
suite now imports its own mail, so it runs on any account.

Android emulator (Pixel 7 API 34, release build of the tip):

- 1.0.0: browser sign-in (consent page, registered client, new redirect
  scheme) as usera; reader with the new CSP (height, links open in the
  browser); reply composer loads, draft saved; push enabled through the
  hosted relay, a mail sent by userb arrived as a notification; calendar
  loads with series (#89); Files shows the trash.
- 1.0.0 and 0.16: password + TOTP sign-in for e2e-totp-phone (the 1.0
  `invalid_client` bug is gone); send from the 1.0 TOTP account.
- Unified inbox across the logins.

Not covered on the emulator: series edits, contact photos and
reschedule/undo (covered by the live suites only), and anything iOS.

## Open

- iOS, needs a CI run: reader CSP and composer nonce assume injected scripts
  ignore page CSP and the editor loads as about:blank; the notification
  extension's label check (b352e470, Swift); `target=_blank` link taps;
  #81 keyboard. iOS push still lapses after 7 days without opening the app
  (the extension can't extend it).
- Blocked on the webmail: org policy (locked settings, session length,
  external sender label and recipient confirm, org signature and
  disclaimer, template library). The policy route only takes the webmail
  session cookie, and the app doesn't keep the paired webmail URL. Also the
  hand-off still returns the password in the `bulwarkmobile://` fragment.
- Not done: the 60 P3 rows in the parity file; P3 bugs in Sieve (forward
  limit, vacation length, editor losing text); device DST in other-zone
  daily expansion keeps a wrong recurrenceId for that one day; a login
  switch from a deep link doesn't reset the navigation stack, so a thread
  left below can act through the new login.
- New strings are English-only except where the webmail already had
  translations.
- The `C:\ns` junction (to the worktree, used for the emulator build) is
  still there; removing it was blocked by the permission settings.

## Bugs that also live in the webmail

Not fixed there in this run:

- Inline images of drafts and sent mail on 1.0.0 come only from
  `attachments` (components/email/email-viewer.tsx:2518, email-composer.tsx
  :905, :1391, :2647).
- Save to Files on 0.16 stores the whole message (save-to-files-dialog.tsx
  :79-84); Blob/copy without the blob capability (lib/jmap/client.ts:9985).
- Reschedule after a lost answer: cancel (client.ts:11619) and create
  (:11643) can strand or double-send.
- Default alert ids `alert1…` reused across calendars and lists; 1.0
  refuses them (lib/calendar-alerts.ts:206, calendar-management-settings.tsx
  :200).
- Sieve parser drops `elsif`/`else` and trailing comments, which breaks the
  category-tabs section (lib/sieve/parser.ts:251); generator falls back to
  `header :contains` (lib/sieve/generator.ts:126).
- Vacation turned on with a failed filter re-include only logs
  (stores/vacation-store.ts:210).
- Feed sync: no END:VCALENDAR check, no mass-deletion guard
  (stores/calendar-store.ts:1978); invitation trust lets a failing DKIM
  signature beat dmarc=pass (lib/calendar-invitation.ts:219); a HELO SPF
  pass counts as aligned (lib/email-headers.ts:64).
- Files trash: purge without a fresh read (stores/file-store.ts:1947),
  restore with its folder lands at the root (:1914), no `.Trash` name check.
- Push: no device client id check (lib/web-push.ts:786), cap path destroys
  first (:852), refused relay URL shown raw (notification-settings.tsx:173).
- Probably: decoded CSS put back into STYLE (lib/email-sanitization.ts:733),
  untested; Lite refresh follows redirects (lib/auth/lite-tokens.ts:533).

## Questions

1. #85: the notification Delete action requires unlock (#68), which is why
   Android closes the shade. Drop the requirement (Delete then works from the
   lock screen, it only moves to Trash) or keep it?
2. Org policy on the phone: add a webmail route that accepts a JMAP bearer
   token, and keep the paired webmail URL in the app?
3. Full account security on 1.0 needs a first-party client for the app. Add
   an admin-registered `bulwark-mobile` client to the OAuth setup?
4. MIG-02 on native: after a 0.16 to 1.0 migration every token account fails
   to refresh and is removed with "Your session has expired". Keep it as
   "sign in again" instead? A pasted OAuth access token also drops after
   about an hour (no refresh token).
5. A password change from a TOTP account ends its grant on 0.16, so the app
   asks to sign in again. Fine?
6. Translate the new English-only strings into the other 26 locales now?
7. Reset the navigation stack when a deep link or notification switches the
   login?
8. Small ones: the feed mass-removal guard (keeps events when more than half
   of 10+ would go, no override); contact re-import marks same-UID cards as
   "update existing", unselected; team templates read-only; Delete
   permanently and Restore on stale trash rows refresh silently.
9. The account switcher shows `10.10.10.62` for both servers (port dropped),
   so two logins of the same user look identical. Show the port?
