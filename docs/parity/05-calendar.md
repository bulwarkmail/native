# Calendar & tasks

## Summary
RN has a solid read path (month/week/agenda, shared-calendar namespacing, per-viewer colours, client-side recurrence expansion that is a faithful port of WEB's, birthday calendar, tasks-only calendar hiding, push-driven refresh) but the write path is far behind WEB and has several data-corrupting bugs: the recurrence scope dialog is a stub (every choice edits/deletes the whole series, and editing an occurrence moves the whole series), all-day events grow by one day on every create/edit, events are created without a `timeZone`, and invitations are never actually sent because RN builds participants with the retired `sendTo` and never sets `organizerCalendarAddress`. There is no calendar management UI (create/rename/colour/delete/clear/share), no rights-based editability, no reminders/alerts firing, no trust assessment on invitations, no custom time zone, no Jalali, and the whole calendar UI is unlocalized even though RN has an i18n layer. Roughly half of the WEB changelog fixes since 1.4.5 apply to RN and are not there.

## Findings

### Recurrence

- [x] **Recurrence scope dialog is a stub: "This event" / "This and following" behave as "All events"** — `P1` — `missing` — fixed in 161baf1
  - What WEB does: `handleScopeSelect` implements all three scopes: "this" writes a `recurrenceOverrides/<recurrenceId>` patch (or the synthetic id on Stalwart >= 0.16.20), "this_and_future" truncates the master with `until` and creates a new series, "all" patches the master; delete does the mirror (exclude / truncate / destroy) and refetches the range (ref `components/calendar/calendar-app.tsx:842-998`, `lib/recurrence-overrides.ts:21-32`, changelog 1.9.0 "Edit a single recurring occurrence via a one-shot override patch").
  - What RN does: `handleScopeSelect` ignores the chosen scope with a TODO ("treat all scopes as 'all'") and either opens the edit modal on the occurrence or deletes `action.event.id`, which the store resolves to the master via `originalId` (ref `src/screens/CalendarScreen.tsx:347-363`, `src/stores/calendar-store.ts:306-329`). Choosing "This event" on delete destroys the entire series.
  - Fix hint: port WEB's `handleScopeSelect`/`truncateRecurrenceAtEvent`/`findMasterEvent` into CalendarScreen; add `buildRecurrenceOverridePatch` (WEB `lib/recurrence-overrides.ts`; removed again in f397ee3, where "This event only" goes to `updateEvent`/`deleteEvent` with the occurrence's id) and `RECURRENCE_OVERRIDE_IMMUTABLE_KEYS`; for "this" write `{ [`recurrenceOverrides/${recurrenceId}`]: override }` on `originalId`; for delete-this write `{ excluded: true }`; refresh after.

- [x] **Editing an expanded occurrence rewrites the master's `start` to the occurrence date (series shifts / earlier occurrences vanish)** — `P1` — `bug` — fixed in 161baf1
  - What WEB does: for scope "all" the updates go to the master but `start` from an occurrence is never applied to the master unless the user changed it; scope "this" goes into an override (ref `components/calendar/calendar-app.tsx:930-943`).
  - What RN does: `EventModal` seeds `start` from the occurrence (`getEventStartDate(event)`, `src/components/calendar/EventModal.tsx:197`) and `handleSave` always sends `start` + `duration` (`EventModal.tsx:262-281`); `updateEvent` resolves the occurrence to `originalId` and PATCHes the master (`src/stores/calendar-store.ts:306-318`). Any occurrence edit moves the whole series to that occurrence's date.
  - Fix hint: part of the scope work above; when scope is "all", drop `start` from the patch unless the user actually changed the date/time relative to the occurrence, or compute the delta and apply it to the master's `start`.

- [x] **Store's optimistic merge after an occurrence edit only updates one occurrence** — `P2` — `bug` — fixed in 161baf1
  - What WEB does: after any occurrence or master mutation with expanded occurrences in view it refetches the visible range (`stores/calendar-store.ts:186-206, 749-751`).
  - What RN does: `updateEvent` maps only `e.id === id` (`src/stores/calendar-store.ts:315-317`), so sibling occurrences keep the old title/time until a pull-to-refresh; `deleteEvent` removes only the tapped occurrence from state while the server destroyed the master (`:320-329`).
  - Fix hint: after mutating a `recurrenceId`/`recurrenceRules` event call `get().refresh()` (RN already has it) like WEB's `refetchAfterOccurrenceMutation`.

- [x] **RSCALE=GREGORIAN;SKIP=OMIT still emitted by the custom recurrence editor (#805)** — `P2` — `bugfix-parity` — fixed in 58a6f45
  - What WEB does: `createRecurrenceRule` deliberately omits `rscale`/`skip` because Stalwart serialises them into the RRULE and DAVx5 rejects it (ref `lib/recurrence-rule.ts:5-33`, changelog 1.9.2 #805).
  - What RN does: `buildRuleFromEditorValue` sets `rscale: 'gregorian', skip: 'omit'` on every custom rule (ref `src/lib/recurrence.ts:220-221`). RN affected: any custom recurrence created on mobile breaks Android CalDAV sync.
  - Fix hint: delete the two properties in `buildRuleFromEditorValue`; the simple presets in `EventModal.tsx:143-146` are already clean.

- [x] **Synthetic occurrence ids / server-side expansion (Stalwart >= 0.16.20) not used** — `P3` — `missing` — done in 8454889 (server expansion when the probe finds synthetic ids, device-side expansion otherwise), f397ee3 (one occurrence changed or deleted through its own id) and 96c5a3f (RSVP to one occurrence)
  - What WEB does: probes `CalendarEvent/set` with `h333333` once, then queries with `expandRecurrences: true`, hydrates occurrences from base events and writes occurrence patches through the synthetic id with a fallback to base-event overrides (ref `lib/jmap/client.ts:5648-5680, 5747-5751, 5828-5868`, `lib/recurrence-instances.ts:35, 73, 208-232`, `stores/calendar-store.ts:82-184`).
  - What RN does: always fetches raw events and expands on the client (`src/stores/calendar-store.ts:228`, `src/lib/recurrence-expansion.ts`). Functionally fine on all server versions; RN's expansion file is a line-for-line port of WEB's (diffed: only comments, formatting and the `isServerRecurrenceInstance` pass-through differ).
  - Fix hint: optional. If adopted, port `recurrence-instances.ts` wholesale and the `isServerRecurrenceInstance` guard in `expandRecurringEvents`.

- [x] **Removing recurrence / participants / reminders / location on edit does not persist** — `P2` — `bug` — fixed in 58a6f45
  - What WEB does: sends explicit `null` for `recurrenceRules` (+ `recurrenceOverrides`, `excludedRecurrenceRules`), `alerts`, `participants` (+ `replyTo`, `organizerCalendarAddress`), `locations`, `virtualLocations` when the field was cleared (ref `components/calendar/event-modal.tsx:528-549, 560-563, 588-592`).
  - What RN does: `handleSave` emits `undefined` for cleared fields (`recurrenceRules: undefined`, `participants: undefined`, `alerts: remindersToAlerts([]) === undefined`, `locations: undefined`) which JSON serialisation drops, so the server keeps the old value (ref `src/components/calendar/EventModal.tsx:262-281`, `src/lib/calendar-alerts.ts:72-73`). Setting "Does not repeat" on a recurring event, removing all attendees, deleting the last reminder or clearing the location silently does nothing.
  - Fix hint: in edit mode compare against `event` and send `null` for fields that existed and are now empty; RN's `cleanRecurrenceRules` already turns `[]`/`null` into `recurrenceRule: null` (`src/api/calendar.ts:115-118`), so `recurrenceRules: []` works today for recurrence.

- [x] **`this_and_future` / huge-span RRULE (#735) — RN not affected** — `P3` — `bugfix-parity` — verified, nothing to fix (caps already in place; "this and following" truncates with `until` and drops `count`)
  - What WEB does: memory note on #735 (Stalwart u32 overflow for spans > 136 years). WEB's editor caps `until` to a picked date and `count` to 999.
  - What RN does: same caps (`src/lib/recurrence.ts:227-229`, `RecurrenceEditor.tsx:139-144, 244-249`), no alarms with absolute triggers far in the future. Not affected; noted so it isn't re-investigated.

### Events: create / edit

- [x] **All-day events are created and saved one day too long** — `P1` — `rn-only-bug` — fixed in 58a6f45
  - What WEB does: seeds the end field from `getEventDisplayEndDate` (inclusive, end - 1 ms) for all-day events and builds `buildAllDayDuration(start, inclusiveEnd)` (ref `components/calendar/event-modal.tsx:274-280, 471-477`).
  - What RN does: edit seeds `end` with `getEventEndDate(event)` which is the exclusive end (start + P1D = next day 00:00) (`src/components/calendar/EventModal.tsx:198`); the all-day toggle effect pushes `end` to the next day whenever `end <= start` (`:231-242`); `handleSave` then calls `buildAllDayDuration(start, end)` which is inclusive (`:269`, `src/lib/calendar-utils.ts:183-189`), yielding `P2D` for a one-day event. Every create-via-toggle and every re-save of an all-day event adds a day.
  - Fix hint: seed/display the inclusive end (`getEventDisplayEndDate`) for all-day events, and in the all-day effect set `e = s` (same day) when `end <= start`; keep `buildAllDayDuration` inclusive.

- [x] **Events created without `timeZone` (floating time)** — `P1` — `bug` — fixed in 58a6f45
  - What WEB does: every timed event carries `timeZone: getEffectiveTimeZone()` (all-day: `null`) so other clients and invitees resolve the wall-clock correctly (ref `components/calendar/event-modal.tsx:494-502`, `lib/timezone.ts:64-75`).
  - What RN does: `handleSave` never sets `timeZone` (`src/components/calendar/EventModal.tsx:262-281`) and `createEvent` does not add one (`src/api/calendar.ts:248-275`). Stalwart stores a floating DTSTART; attendees in other zones, CalDAV clients, and the user after travelling see wrong times; iMIP invites sent for such events are ambiguous.
  - Fix hint: set `timeZone: allDay ? null : Intl.DateTimeFormat().resolvedOptions().timeZone` (reuse `getUserTimeZone` from `src/api/calendar.ts:15`); once a custom time-zone setting exists (see below) use that.

- [x] **Changing the calendar in the edit modal is ignored (cannot move an event between calendars)** — `P2` — `rn-only-bug` — fixed in 161baf1 + 3fd5f10 (cross-account moves are not offered)
  - What WEB does: `calendarIds: { [calendarId]: true }` is part of the saved patch and the store remaps store ids to server ids (ref `components/calendar/event-modal.tsx:503`, `stores/calendar-store.ts:706-715`).
  - What RN does: `EventModal.handleSave` passes `calendarId` as the second argument, but `CalendarScreen.handleSave` only uses it on create (`src/screens/CalendarScreen.tsx:365-374`); the picker in edit mode is a no-op.
  - Fix hint: on update include `calendarIds: { [cal.originalId || calendarId]: true }` in the patch; for shared calendars the owning account differs, so either block cross-account moves or delete + recreate.

- [x] **Edit-modal calendar picker offers the Birthdays calendar, iCal-subscription calendars and read-only shared calendars (#762)** — `P2` — `bugfix-parity` — fixed in 3fd5f10
  - What WEB does: `canCreateEventsIn` excludes subscription calendars and calendars without `mayWriteAll`/`mayWriteOwn` (ref `lib/calendar-editability.ts:20-24`, changelog 1.9.0 #762).
  - What RN does: `EventModal` receives `eventCalendars`, which still contains the virtual birthday calendar (`src/screens/CalendarScreen.tsx:213-216, 227-231, 544-552`) and all shared calendars regardless of rights; picking Birthdays yields a server error, picking a subscription calendar lets the next feed sync delete the event (`src/stores/calendar-subscriptions-store.ts:58-74`).
  - Fix hint: filter with a RN `canCreateEventsIn(cal, isSubscriptionCalendar)` (subscriptions from `useCalendarSubscriptionsStore`), exclude `BIRTHDAY_CALENDAR_ID`.

- [x] **No rights-first editability (edit/delete offered on read-only and RSVP-only events)** — `P2` — `missing` — fixed in 3fd5f10
  - What WEB does: `getEventEditability` gates on calendar `myRights` first (`mayWriteAll`, `mayWriteOwn` + owner, `mayRSVP` + participant), subscription calendars are read-only, and the popover shows edit/delete vs. RSVP-only accordingly (ref `lib/calendar-editability.ts:47-76`, `components/calendar/event-detail-popover.tsx:161-171, 540-575`, changelog 1.9.0 "Rights-first event editability, including alias organizers").
  - What RN does: `EventDetailSheet` always renders Edit/Delete (`src/components/calendar/EventDetailSheet.tsx:328-351`); the only read-only guard is the birthday calendar (`src/screens/CalendarScreen.tsx:313-316`). The server rejects the write, but the user sees a generic error.
  - Fix hint: port `calendar-editability.ts`; pass `calendarsById`, the user's addresses (identities + aliases) and `isSubscriptionCalendar` into the sheet; hide Edit/Delete for `read-only`, show only RSVP for `rsvp-only`.

- [x] **`myRights.mayWrite` (non-existent JMAP property) used for writability everywhere** — `P2` — `rn-only-bug` — fixed in 3fd5f10
  - What WEB does: uses `mayWriteAll`/`mayWriteOwn`/`mayDelete` from RFC-style `CalendarRights` (ref `lib/calendar-editability.ts:20-24`, `components/calendar/calendar-sidebar-panel.tsx:328-334`).
  - What RN does: `CalendarRights.mayWrite` is documented as a "legacy short flag" (`src/api/types.ts:~507`) and is what `CalendarSidebarDrawer` (`:92-98`), `TasksSheet` (`:84-87`), `ICalImportSheet` (`:51-54`) and `CalendarInvitationBanner` (`:96`) test. Stalwart never sends it, so every calendar counts as writable and the "Subscribed" section can never populate.
  - Fix hint: replace with `!r || r.mayWriteAll || r.mayWriteOwn` and drop `mayWrite` from the type.

- [x] **No "send invitations" toggle in the editor** — `P3` — `missing` — fixed in 2abea97
  - What WEB does: `sendInvitations` checkbox (default on) decides `sendSchedulingMessages` (ref `components/calendar/event-modal.tsx:409, 594, 1333-1338`).
  - What RN does: always sends when participants exist (`src/stores/calendar-store.ts:22-24, 293-297`).
  - Fix hint: add a switch in the Participants section and thread it through `onSave`.

- [x] **Reminder picker is presets-only** — `P3` — `partial` — fixed in 2abea97 (custom amount + unit row; absolute / end-relative / non-display alerts survive a save)
  - What WEB does: alert rows with a number + unit (minutes/hours/days/weeks/at time), multiple rows, preserving exotic alerts (ref `components/calendar/event-modal.tsx:101-135, 358-386`, changelog 1.6.x #170).
  - What RN does: fixed preset list, multiple allowed, non-offset alerts are dropped from the UI but kept until save (`src/components/calendar/EventModal.tsx:299-312`, `src/lib/calendar-alerts.ts:51-70`). Note the "kept until save" comment is wrong: `remindersToAlerts` rebuilds the map from presets only, so an absolute-trigger alert is lost on the next save.
  - Fix hint: add a custom value+unit row; when rebuilding alerts, carry over alerts whose trigger has no `offset`.

- [ ] **Duplicate event, export .ics, copy meeting link / title, add note** — `P3` — `missing` — duplicate (+1 day, opens editor), share as .ics (`eventToICS` port + expo-sharing) and copy meeting link done in 5fe8e40; deferred: copy title, append-a-note
  - What WEB does: popover/context-menu actions duplicate (+1 day, opens editor), export via `downloadEventICS`, copy meeting link, copy title, append a timestamped note to the description (ref `components/calendar/calendar-app.tsx:1017-1125`, `lib/calendar-ics-export.ts:96, 176`).
  - What RN does: `EventDetailSheet` has an `onDuplicate` prop that `CalendarScreen` never passes (`src/components/calendar/EventDetailSheet.tsx:59, 336-342`); no export/copy/note.
  - Fix hint: wire `onDuplicate` (clone like WEB `handleDuplicateFromDetail`), add "Share .ics" via `expo-sharing` + a port of `eventToICS`, add "Copy link" with `Clipboard`.

### Invitations / scheduling

- [x] **Invitations are never sent: participants built with retired `sendTo`, no organizer, no `organizerCalendarAddress`** — `P1` — `bugfix-parity` — fixed in 5dc4070
  - What WEB does: `buildParticipantMap` emits an owner-only organizer participant with `calendarAddress`, attendees with `calendarAddress` + `scheduleAgent: 'server'`, and the modal sets `organizerCalendarAddress: mailto:<user>` — without it Stalwart emits no ORGANIZER and silently skips iTIP (ref `lib/calendar-participants.ts:164-214`, `components/calendar/event-modal.tsx:573-586`, changelog 1.7.0 "Send calendar invites by setting organizerCalendarAddress", 1.7.2 #500 "Use calendarAddress, drop retired sendTo", 1.8.1 #731).
  - What RN does: `ParticipantInput.addParticipant` writes `{ email, sendTo: { imip }, roles: { attendee } }` (`src/components/calendar/ParticipantInput.tsx:71-92`), no organizer participant and no `organizerCalendarAddress` anywhere in `EventModal.handleSave` (`:262-281`). `sendSchedulingMessages: true` is passed (`src/stores/calendar-store.ts:293-297`) but Stalwart has nothing to schedule with. On Stalwart the attendee's `sendTo` is stored as an inert JSPROP.
  - Fix hint: port `buildParticipantMap` + `collectUserCalendarAddresses`; on save with attendees set `participants = buildParticipantMap({name, email: activeAccount.email}, attendees)` and `organizerCalendarAddress = mailto:<email>`; on edit keep existing participant ids and never re-add the organizer (#731).

- [x] **RSVP matches only the active account e-mail (no identities / aliases)** — `P2` — `missing` — fixed in 5dc4070
  - What WEB does: `currentUserEmails` = identities + account aliases via `collectUserCalendarAddresses`, used for `getUserParticipantId`, organizer detection and editability (ref `lib/calendar-participants.ts:71-112`, changelog 1.9.0 "including alias organizers").
  - What RN does: `findParticipantByEmail(event, [activeEmail])` with the single login address (`src/components/calendar/EventDetailSheet.tsx:115, 173`, `src/components/email/CalendarInvitationBanner.tsx:98`). Invitations addressed to an alias show no RSVP buttons.
  - Fix hint: RN already loads identities for the composer; collect their emails (+ aliases from `x:Account/get` if available) and pass the array.

- [x] **RSVP writes `replyTo` instead of repairing `organizerCalendarAddress`** — `P3` — `partial` — fixed in 5dc4070
  - What WEB does: only when the event lacks `organizerCalendarAddress` it sets it from `replyTo.imip`; never sends `replyTo` (retired) (ref `stores/calendar-store.ts:782-789`).
  - What RN does: `rsvpEvent` sets `patch.replyTo = replyTo` whenever `buildReplyTo` returns something (`src/api/calendar.ts:344`, `src/lib/calendar-invitation.ts:74-83`). Harmless on Stalwart (ignored) but the repair path for imported invites lacking an organizer is missing, so those REPLYs are not routed.
  - Fix hint: mirror WEB: `if (replyTo?.imip && !storeEvent.organizerCalendarAddress) patch.organizerCalendarAddress = replyTo.imip`.

- [x] **Store rejects participant ids containing `..`** — `P3` — `rn-only-bug` — fixed in 5dc4070
  - What WEB does: participant ids are opaque and RFC 6901-escaped; only empty ids are rejected (ref `stores/calendar-store.ts:763-770`).
  - What RN does: `if (!participantId || participantId.includes('..')) throw` (`src/stores/calendar-store.ts:332-334`); a server-generated id like `a..b` cannot RSVP.
  - Fix hint: drop the `..` check.

- [x] **Invitation banner: no trust assessment, no METHOD from Content-Type / raw ICS, no inline body-part detection** — `P2` — `partial` — fixed in 8206893 (auth results parsed from `email.headers`)
  - What WEB does: `getInvitationTrustAssessment` (DMARC/DKIM/SPF + sender/organizer mismatch -> trusted/caution/warning banner), `getInvitationMethod` reads `method=` from the attachment/body Content-Type, then `extractMethodFromRawIcs`, then infers; `findCalendarAttachment` also walks `textBody`/`htmlBody` sub-parts (ref `lib/calendar-invitation.ts:341-446`, changelog 1.6.x "RSVP with trust assessment").
  - What RN does: `inferInvitationMethod(parsed)` only (`src/components/email/CalendarInvitationBanner.tsx:62`; `extractMethodFromRawIcs` exists at `src/lib/calendar-invitation.ts:103-106` but is unused); `findCalendarAttachment` checks `email.attachments` only (`:139-148`); no trust UI. A spoofed invitation from an unauthenticated sender looks identical to a real one, and a REPLY/CANCEL whose ICS carries no participants is treated as `unknown` and offered "Add to calendar".
  - Fix hint: port `getInvitationTrustAssessment` (RN `Email` has `authenticationResults`?; if not, add to the fetched properties) and show a coloured banner + reason; read `attachment.type` params and fall back to downloading the blob text for `METHOD:`.

- [x] **Invitation banner imports into the first writable calendar, not the default calendar, and parses against the primary account** — `P3` — `partial` — fixed in 3fd5f10 + 8206893
  - What WEB does: imports into the default calendar of the account that owns the email; shared-folder emails are parsed against the folder owner (#867) and multi-account lookups are routed by source account (#847) (changelog 1.9.0).
  - What RN does: `calendars.find(cal => !cal.myRights || cal.myRights.mayWrite !== false)` (`src/components/email/CalendarInvitationBanner.tsx:96`) and `parseCalendarBlob(attachment.blobId)` on `jmapClient.accountId` (`:59`, `src/api/calendar.ts:355-372`). RN shows only the active account's mailboxes, so #847/#867 are largely N/A; the "first writable" pick is wrong when a subscription calendar sorts first.
  - Fix hint: prefer `cal.isDefault && !cal.isShared`, exclude subscription/birthday calendars; pass `email.accountId` (if RN exposes shared mailboxes later) to `parseCalendarBlob`.

- [x] **Organizer not identified in the participant list; no "invited by", status counts or cancelled/tentative rendering** — `P3` — `partial` — fixed in 5dc4070 + 0f80e98 (organizer label, cancelled strike-through in sheet/card/month chips, tentative badge on cards; week-view blocks are untouched)
  - What WEB does: `getParticipantList` marks the organizer (also via `organizerCalendarAddress`, #731), the popover shows "(organizer)", strikes through `status === 'cancelled'` and badges `tentative` (ref `lib/calendar-participants.ts:126-157`, `components/calendar/event-detail-popover.tsx:299-312, 445-449`, changelog 1.7.2 #572).
  - What RN does: participants listed with status dots only (`src/components/calendar/EventDetailSheet.tsx:298-325`); no cancelled/tentative styling in sheet, `EventCard` or views.
  - Fix hint: port `getParticipantList`/`getStatusCounts`; add `line-through` when `event.status === 'cancelled'` in `EventCard`, `WeekView`, `EventDetailSheet`.

### Calendars

- [x] **No calendar management UI: create, rename, colour, description, delete, clear events, copy CalDAV URL** — `P2` — `missing` — fixed in dae5700 (no CalDAV URL copy: RN has no DAV base URL)
  - What WEB does: sidebar context menu + settings section with create (with kind picker), edit name/colour/description, clear all events (unlink-aware), delete, share, copy URL (ref `components/calendar/calendar-sidebar-panel.tsx:328-395`, `components/settings/calendar-management-settings.tsx`, `stores/calendar-store.ts:1028-1206`).
  - What RN does: `createCalendar` exists in the store but is only reachable through the subscription sheet (`src/stores/calendar-store.ts:378-382`, `src/stores/calendar-subscriptions-store.ts:82-84`); there is no `updateCalendar`/`removeCalendar`/`clearCalendarEvents` API or UI (`src/api/calendar.ts` has `deleteCalendar` at 417 but nothing calls it for own calendars). Long-press only offers set-default and shared-calendar recolour (`src/components/calendar/CalendarSidebarDrawer.tsx:208-211`).
  - Fix hint: add `Calendar/set` update + destroy (`onDestroyRemoveEvents`) to `src/api/calendar.ts`, expose in the store, and add "New calendar" + long-press "Rename / Colour / Delete / Clear" in the drawer. Deleting must be blocked for `isDefault` and shared calendars like WEB.

- [x] **Own-calendar colour cannot be changed (only shared calendars are recolourable)** — `P3` — `partial` — fixed in dae5700
  - What WEB does: colour picker writes `Calendar/set { color }` for own calendars and a local override for shared ones (ref `calendar-sidebar-panel.tsx:330, 366`, `lib/shared-calendar-colors.ts:33-40`).
  - What RN does: `canRecolor = !!onSetColor && !!cal.isShared` (`CalendarSidebarDrawer.tsx:209`).
  - Fix hint: for `!cal.isShared` call the new `updateCalendar(id, { color })`.

- [x] **Shared-calendar colour key differs from WEB (not portable, but internally consistent)** — `P3` — `partial` — fixed in 0f80e98
  - What WEB does: key = `${localAccountId}|${accountId}|${originalId}` (ref `lib/shared-calendar-colors.ts:33-40`).
  - What RN does: key = `${accountId}|${id}` where `id` is already the namespaced `${accountId}:${raw}` (`src/lib/calendar-utils.ts:474-478`). Works, but the account id is duplicated in the key and would break if the namespacing format changes.
  - Fix hint: use `cal.originalId ?? cal.id` like WEB.

- [ ] **Calendar creation does not pin `supported-calendar-component-set` (#760)** — `P3` — `bugfix-parity` — deferred: the drawer now creates calendars over `Calendar/set` (dae5700); MKCALENDAR against Stalwart's `/dav/` endpoint needs a CalDAV client + calendar-home discovery that RN does not have
  - What WEB does: MKCALENDAR through the WebDAV proxy with `VEVENT`/`VTODO`/both, then finishes over JMAP; falls back to `Calendar/set` (ref `lib/jmap/client.ts:5366-5400, 5436-5485`, `components/calendar/calendar-kind-picker.tsx:16-18`, changelog 1.9.0 #760).
  - What RN does: plain `Calendar/set` (`src/api/calendar.ts:374-396`). Only matters once RN gains a create-calendar UI; RN has no WebDAV proxy, but it can talk to Stalwart's CalDAV endpoint directly (the same host serves `/dav/`).
  - Fix hint: when adding calendar creation, issue `MKCALENDAR` against the account's calendar-home with `supported-calendar-component-set`, then `Calendar/get` to find the new id.

- [x] **No first-touch gate: duplicate default calendars on clustered Stalwart (#907)** — `P2` — `bugfix-parity` — fixed in 58e3ef6 (in-flight dedupe of fetchCalendars/fetchTasks; ensureRange awaits it)
  - What WEB does: `FirstTouchGate` serialises the first `Calendar/*`/`CalendarEvent/*` request per account so concurrent first-touch requests cannot each create a default calendar (ref `lib/jmap/first-touch-gate.ts:56-101`, `lib/jmap/client.ts:678, 1129`, changelog 1.9.0 #907).
  - What RN does: `CalendarScreen` fires `fetchCalendars()` on mount and, in a second effect, `ensureRange()` which sees `calendars.length === 0` and calls `fetchCalendars()` again then `CalendarEvent/query` (`src/screens/CalendarScreen.tsx:261-269`, `src/stores/calendar-store.ts:235-251`); `auth-store` also kicks `fetchCalendars`/`refresh` after login (`src/stores/auth-store.ts:92-98`). Two to three concurrent first-touch calls — exactly the #907 race. RN affected.
  - Fix hint: port `FirstTouchGate` into `src/api/jmap-client.ts` `request()`, or at minimum dedupe in-flight `fetchCalendars` and make `ensureRange` await the mount fetch.

- [x] **Tasks-only calendar detection misses CalDAV tasks without `@type`** — `P2` — `bugfix-parity` — fixed in 58e3ef6
  - What WEB does: `isTaskLikeObject` treats `@type: Task` OR presence of `due`/`progress`/`percentComplete` (and `@type !== 'Event'`) as a task, both for the tasks list and for hiding tasks-only calendars (ref `lib/calendar-component-detection.ts:30-58`, `lib/jmap/client.ts:6300-6316`, changelog 1.5.x #84 "Detect tasks created by external CalDAV clients such as Thunderbird").
  - What RN does: `fetchEvents` classifies solely on `'@type' === 'Task'` (`src/stores/calendar-store.ts:208-227`); Thunderbird/Todoist VTODOs that Stalwart returns without `@type` are neither shown as tasks nor counted for `taskOnlyCalendarIds` (they fall through as start-less "events" and are dropped by `!!e.start`).
  - Fix hint: port `isTaskLikeObject` and use it in both filters.

- [x] **Shared accounts without calendar access are re-probed on every fetch** — `P3` — `bugfix-parity` — fixed in 58e3ef6
  - What WEB does: remembers `forbidden`/`accountNotFound` per account in `calendarAccessDenied` and skips it (ref `lib/jmap/client.ts:5806-5813`, changelog 1.8.1 "Stop re-probing shared accounts that have no calendar access").
  - What RN does: `getCalendars` and `fetchEvents` try every calendar-capable session account each time and swallow errors (`src/api/calendar.ts:140-186`, `src/stores/calendar-store.ts:194-204`).
  - Fix hint: keep a module-level `Set` of denied account ids, reset on reconnect.

- [x] **Calendar sharing (JMAP `shareWith`) not available for calendars** — `P2` — `missing` — fixed in dae5700
  - What WEB does: `shareCalendar` via `Calendar/set shareWith/<principal>` with a principal picker and share indicators (ref `stores/calendar-store.ts:1078-1100`, `lib/jmap/client.ts:4921`, changelog 1.6.x "JMAP sharing for calendars and address books", #244, #257).
  - What RN does: sharing exists only for Files (`src/api/files.ts:229-241`, `src/components/files/ShareSheet.tsx`); nothing for calendars (also likely nothing for address books — that belongs to the contacts audit).
  - Fix hint: reuse `ShareSheet` + the principal picker with a `Calendar/set` `shareWith/{principalId}` patch; request `shareWith`/`myRights` in `Calendar/get` properties.

### Views / navigation / locale

- [ ] **Entire calendar UI is hard-coded English although RN has i18n** — `P2` — `missing` — partial in 0f80e98: screen, month/week/agenda views, event card/sheet/modal, drawer, scope dialog, settings, banner and calendar/share sheets use `t()` + date-fns locales; TasksSheet (09c24fa), `formatReminder` (2abea97) and ICalImportSheet (b7f7110) localized too; deferred: ICalSubscriptionSheet and RecurrenceEditor still hard-code English
  - What WEB does: everything through `next-intl` (`t('calendar.*')`), month/day names and popover dates localized (changelog 1.6.x "Localize event start date in detail popover and event modal").
  - What RN does: `src/i18n/index.ts` + `useLocaleStore` are used by 18 other files, but none of `src/components/calendar/*`, `src/screens/CalendarScreen.tsx` or `CalendarSettings.tsx` import it; all labels ("Today", "No events", "Does not repeat", "Going?", RSVP labels, drawer titles, etc.) and `date-fns` `format()` calls without a `locale` are English (`CalendarScreen.tsx:408, 448, 504, 640-641`, `EventModal.tsx:60-67, 326, ...`, `MonthView.tsx:25-26`, `AgendaView.tsx:33-37`).
  - Fix hint: add a `calendar.*` namespace to `locales/*.json` (WEB's keys can be copied) and pass a date-fns locale from the locale store into `format()`.

- [ ] **First day of week limited to Monday/Sunday; no Saturday, no Jalali (#490)** — `P3` — `missing` — Saturday (0|1|6) done in 0f80e98; deferred: Jalali month grid needs a port of `lib/jalali-utils.ts` + `useCalendarLocale`
  - What WEB does: `firstDayOfWeek` 0/1/6 with Saturday default for Persian and a full Jalali month grid / headers (ref `hooks/use-calendar-locale.ts:35-120`, `lib/jalali-utils.ts:161-169`, changelog 1.8.0 #490).
  - What RN does: `FirstDayOfWeek = 0 | 1` (`src/stores/settings-store.ts:76`), `MonthView`/`WeekView` typed `0 | 1` (`MonthView.tsx:34`, `WeekView.tsx:40`), no Jalali.
  - Fix hint: widen the type to `0|1|6`, add Saturday to `CalendarSettings`; Jalali is a larger port of `jalali-utils.ts` + a `useCalendarLocale` equivalent (only if the fa locale is added to RN).

- [x] **Week numbers are not ISO when the week starts on Monday; no week numbers in week view** — `P3` — `rn-only-bug` — fixed in 0f80e98 (month view; the week view header has no room for it)
  - What WEB does: `getISOWeek` when `weekStartsOn === 1`, else `getWeek(..., { weekStartsOn: 0 })` (ref `components/calendar/mini-calendar.tsx:74-79`).
  - What RN does: `getWeek(row[0], { weekStartsOn })` (`src/components/calendar/MonthView.tsx:137`) — without `firstWeekContainsDate: 4` this is not ISO numbering and can be off by one around New Year. WeekView has no week number.
  - Fix hint: use `getISOWeek` for Monday start; optionally show the number in the WeekView header row.

- [x] **"Show time in month view" setting is ignored (#666)** — `P3` — `bugfix-parity` — fixed in 0f80e98
  - What WEB does: on mobile, `showChips = !isMobile || showTimeInMonthView` renders event chips with times instead of dots (ref `components/calendar/calendar-month-view.tsx:49-52`, `event-card.tsx:80, 178`, changelog 1.8.0 #666).
  - What RN does: setting exists (`src/stores/settings-store.ts:169`, `CalendarSettings.tsx:435-443`) but `MonthView` always draws up to 3 dots (`src/components/calendar/MonthView.tsx:83-86`). RN affected.
  - Fix hint: pass the setting into `MonthView` and render a compact chip (title + start time) per event when on.

- [x] **Hover-preview setting exposed on mobile** — `P3` — `rn-only-bug` — fixed in 0f80e98 (store key kept for settings-sync compatibility)
  - What WEB does: hover preview is a desktop pointer feature.
  - What RN does: `CalendarSettings` shows "Hover preview" with delay options and nothing consumes `calendarHoverPreview` (`src/components/settings/CalendarSettings.tsx:87-102`; no other reference in `src/`).
  - Fix hint: remove the setting row (keep the store key for settings-sync compatibility or drop it).

- [x] **No day view (falls back to agenda); tapping a month day does not open the day** — `P3` — `partial` — fixed in 0f80e98 ("Day" hidden from the mobile default-view options; a synced "day" shows as Agenda); a real day view is back since de3d697, with the week and month views scrolling freely (de3d697, caf61ec, #759) and an endless agenda (71522b9)
  - What WEB does: day view with time grid; on mobile, tapping a date in month view switches to day view and offers "back to month" (ref `components/calendar/calendar-app.tsx:461-470`, `calendar-day-view.tsx`).
  - What RN does: `calendarDefaultView === 'day'` maps to agenda (`src/screens/CalendarScreen.tsx:131-137`); month view shows a list below the grid instead. Acceptable UX, but the settings option "Day" is misleading.
  - Fix hint: either reuse `WeekView` with a single-day `weekDays` array as a day grid, or hide "Day" from the RN default-view options.

- [x] **Week view: event block time label ignores 12h setting; timed grid has no long-press-at-minute precision** — `P3` — `partial` — fixed in 0f80e98
  - What WEB does: `formatSnapTime(minutes, timeFormat)` (ref `lib/calendar-utils.ts:278`).
  - What RN does: `minutesToTimeLabel` always `HH:mm` (`src/components/calendar/WeekView.tsx:315-319`) while the gutter honours 12h (`:229-231`). Long-press creates at the whole hour (`:123-128`), fine for mobile.
  - Fix hint: use `timePattern(timeFormat)` with `format()`.

- [x] **EventCard shows the description under a location (MapPin) icon and never shows the location** — `P3` — `rn-only-bug` — fixed in 0f80e98
  - What WEB does: card shows time, location and calendar (ref `components/calendar/event-card.tsx`).
  - What RN does: `event.description` rendered with `<MapPin/>` (`src/components/calendar/EventCard.tsx:65-72`); `locations` is not read.
  - Fix hint: show `Object.values(event.locations)[0]?.name` with MapPin; drop or move the description.

- [x] **Detail sheet shows exclusive end date for all-day events (#318 off-by-one)** — `P2` — `rn-only-bug` — fixed in 5dc4070
  - What WEB does: multi-day all-day events show the inclusive end date (changelog 1.6.x #318, `getEventDisplayEndDate`).
  - What RN does: `formatRange` uses `eventTimeRange` -> `getEventEndDate` (exclusive), so a single-day all-day event on Mar 1 prints "Mar 1 – Mar 2" and a two-day one "Mar 1 – Mar 3" (`src/components/calendar/EventDetailSheet.tsx:63-74`, `src/lib/calendar-utils.ts:84-90`).
  - Fix hint: for `allDay` use `getEventDisplayEndDate(event)` before comparing/formatting.

- [ ] **Deep links to calendar/event** — `P3` — `missing` — partly: incoming links are parsed since 5802cae (`src/navigation/linking.ts`), and an event link opens the event since 9282ee6; a date link only opens the Calendar tab
  - What WEB does: `parseCalendarPath`/`buildCalendarPath` handle `/calendar/<view>/<date>?event=` (ref `lib/deep-links.ts:272-300`, changelog 1.8.3 "Deep links for mail, calendar, contacts, files").
  - What RN does: `Calendar: undefined` route params (`src/navigation/types.ts:33`); `handleDeepLink` hands an event to the Calendar tab through `pending-calendar-open`, the same path a tapped reminder takes, but ignores the date.
  - Fix hint: accept `{ date?, eventId? }` params on the Calendar route and open the detail sheet.

### Data loading / sync

- [x] **Range queries fetch every event in the account (no `after`/`before`), capped at 1000** — `P2` — `bug` — fixed in 58e3ef6
  - What WEB does: `CalendarEvent/query` with `{ after, before }` + `timeZone` (changelog 1.7.0 "timezone-aware calendar queries", 1.7.1 "Stalwart-compatible calendar filters") (ref `lib/jmap/client.ts:5722-5745`).
  - What RN does: `queryEvents` ignores its `_after`/`_before` arguments citing "Stalwart rejects after/before filters" (outdated) and uses `limit: 1000` (`src/api/calendar.ts:188-208`); `fetchEvents` then re-fetches everything whenever `ensureRange` widens the union (`src/stores/calendar-store.ts:235-251`). Accounts with more than 1000 objects silently lose events; every navigation past the loaded range re-downloads all events.
  - Fix hint: send `filter: { after, before, inCalendar... }` as WEB does (`{ operator: 'AND', conditions: [...] }` when combined), keep `timeZone`; then `loadedRange` can be the requested window rather than a growing union.

- [x] **iCal import passes raw parsed objects to `CalendarEvent/set`; existing UIDs are skipped instead of linked (#113)** — `P2` — `partial` — fixed in 5fe8e40
  - What WEB does: whitelists the JSCalendar properties it sends (drops server-computed `utcStart`/`utcEnd`/`isOrigin`/`created`/`updated`, rewrites participants to `calendarAddress`, normalises all-day duration/timeZone) and links UIDs that exist in another calendar by adding the target calendar to `calendarIds` (ref `stores/calendar-store.ts:822-958`, changelog 1.5.x #113).
  - What RN does: `importEvents` skips existing UIDs and batch-creates `{ ...parsed, calendarIds }` untouched (`src/stores/calendar-store.ts:352-376`, `src/api/calendar.ts:278-297`). Whether Stalwart rejects computed properties on create depends on the parse output; WEB chose to whitelist after hitting failures ("Deduplicate UIDs during iCal import to prevent mass failures").
  - Fix hint: port WEB's `prepared` mapping (`stores/calendar-store.ts:885-957`) and the link-by-`calendarIds` branch.

- [x] **iCal subscriptions: no per-account scoping, no edit, no auto-refresh/interval, no rollback, `webcals://`, basic-auth URLs** — `P2` — `partial` — fixed in dae5700
  - What WEB does: subscriptions carry `accountId` and are skipped for other accounts (`stores/calendar-store.ts:1360-1363, 1468-1472`), editable name/colour/url/interval (`:1294-1329`), refreshed every 5 min per interval (`components/calendar/calendar-app.tsx:320-324`), rolled back when the first fetch fails (`:1274-1289`), `webcals?://` normalised (`:1240`), basic auth in the URL supported server-side (#275), stale events unlinked rather than deleted when also in another calendar (`:1401-1427`).
  - What RN does: `calendar-subscriptions-store` persists `{ id, name, url, color, calendarId }` globally (`src/stores/calendar-subscriptions-store.ts:16-24, 162-166`) — after switching accounts the list still shows and `syncSubscription` imports into a calendar id of the other account (or a colliding raw id); `syncAll` is never called (`:155-160`); no edit UI (`ICalSubscriptionSheet.tsx`); a failed first sync leaves the empty calendar + sub with `lastError` (`:82-116`); only `webcal://` is rewritten (`:38-40`); `fetch('https://user:pass@host')` throws in RN's WHATWG fetch so #275 URLs fail; stale events are deleted outright (`:58-74`).
  - Fix hint: add `accountId: jmapClient.accountId` to each sub and filter by it; call `syncAll` on calendar mount + `AppState` foreground with a per-sub interval; add an edit sheet; on first-sync failure delete the calendar; regex `/^webcals?:\/\//i`; parse credentials out of the URL into an `Authorization` header.

- [x] **Subscription feeds are fetched on-device (security note, not a gap)** — `P3` — `partial` — fixed in dae5700 (10 MB cap)
  - What WEB does: `/api/fetch-ical` server-side with an SSRF guard, DNS pinning and redirect validation (GHSA-24w9, changelog 1.9.2).
  - What RN does: `fetch(url)` from the phone (`src/stores/calendar-subscriptions-store.ts:42-53`). No server is exposed, so the SSRF class does not apply; the device can be pointed at LAN hosts, which is the user's own network. Redirects are followed by `fetch` without validation (fine). N/A for the advisory; worth a 10 MB size cap and a `text/calendar`-ish content check (already checks `BEGIN:VCALENDAR`).
  - Fix hint: optional size cap.

- [x] **Created recurring event appears as a single instance until refresh; created event lacks `utcStart`/`utcEnd`** — `P3` — `partial` — fixed in 58e3ef6
  - What WEB does: `createCalendarEvent` refetches the created event with full properties (`lib/jmap/client.ts:5942-5960`) and the store refetches when occurrences are in view.
  - What RN does: `createEvent` merges the `/set` echo over the payload (`src/api/calendar.ts:272-274`) and appends without expansion (`src/stores/calendar-store.ts:286-304`).
  - Fix hint: after create, `CalendarEvent/get` the id (RN `getEvents([id])`) and, if `recurrenceRules` is set, run `expandRecurringEvents` for `loadedRange` or call `refresh()`.

- [ ] **Push: FCM subscription excludes `CalendarEvent`/`Calendar` types** — `P3` — `partial` — deferred: local reminders (8e1d03c) are resynced at launch, on `Calendar`/`CalendarEvent` state changes and on return to the foreground (4b903ed), but nothing refreshes them in the background; adding the calendar types to the push subscription lives in `src/lib/push-notifications.ts` (push area) and would need a background refresh + reschedule hook
  - What WEB does: push subscription covers calendar types so the sidebar refreshes on external changes (FEATURES.md "JMAP push keeps everything in sync").
  - What RN does: foreground EventSource/polling dispatches to `useCalendarStore.handleStateChange` (`App.tsx:390-397`, `src/stores/calendar-store.ts:261-284`) — at parity while the app is open; the background push subscription carries only `['EmailDelivery']` since 00faceb (`src/lib/push-notifications.ts`), so calendar changes never wake the app.
  - Fix hint: leave as is unless background calendar refresh becomes needed.

### Alerts / notifications

- [x] **Reminders never fire on mobile (no alert scheduler, no local notifications)** — `P2` — `missing` — fixed in 8e1d03c (expo-notifications local notifications scheduled from the store for the next 7 days, calendar default alerts honoured, cancelled events / completed tasks / acknowledged alerts skipped); moving the calendar view cancelled them until 4b903ed (audit B17), and a tapped reminder opens its event since 83db70a
  - What WEB does: `useCalendarAlerts` polls every 60 s, proactively fetches the next 24 h, computes fire times from `alerts` (offset relative to start/end, absolute triggers, calendar default alerts via `useDefaultAlerts`), dedupes through a persisted acknowledged store, plays a sound and toasts; task due alerts too; cancelled events muted (#572) (ref `lib/calendar-alerts.ts:39-201`, `hooks/use-calendar-alerts.ts:21-158`, `stores/calendar-notification-store.ts`).
  - What RN does: `src/lib/calendar-alerts.ts` only converts offsets <-> reminder presets (1-103); the `calendarNotificationsEnabled`/`calendarNotificationSound` settings are shown in `NotificationSettings.tsx:52-53, 235-240` but nothing reads them; `package.json` has no `expo-notifications`. Users who set "15 minutes before" get nothing.
  - Fix hint: add `expo-notifications`, port `computeFireTime`/`getPendingAlerts`, and schedule local notifications for the next N days on every `fetchEvents` (cancel + reschedule by event id); honour `useDefaultAlerts` via `Calendar.defaultAlertsWithTime/WithoutTime` (add those to `Calendar/get` properties).

### Tasks

- [x] **Task sheet supports only title + due date; no edit, description, priority, due time, progress states, alerts, filters, "show on calendar"** — `P2` — `partial` — fixed in 09c24fa (edit, description, priority, due date + time, calendar move, all/pending/completed/overdue filters, overdue-first sort, `needs-action` <-> `completed` with `progressUpdated`, due tasks overlaid on the grid; task alerts still come only from the server data); completing failed on Stalwart, which rejects `progressUpdated`, until dcdda5e (audit B12, #958)
  - What WEB does: task modal with description, due date + optional time, priority (none/high/medium/low -> 1-9), progress, calendar, alert; list filters all/pending/completed/overdue, overdue-first sort, `showTasksOnCalendar` overlays due tasks on the grid; completion toggles `needs-action` <-> `completed` with `progressUpdated` (ref `components/calendar/task-modal.tsx:55-140`, `task-list-view.tsx:80-110`, `stores/task-store.ts:366, 442-452`).
  - What RN does: `TasksSheet` creates `{ title, progress, due }` only, no tap-to-edit, delete + toggle only (`src/components/calendar/TasksSheet.tsx:117-135, 210-235`); un-completing sets `in-process` (`src/stores/calendar-store.ts:418-426`); `showTasksOnCalendar` (`settings-store.ts:174`) is unused; tasks are never drawn in month/week/agenda.
  - Fix hint: add a task edit sheet mirroring `task-modal.tsx`, filter chips, and render due tasks as all-day chips when `showTasksOnCalendar`.

### Settings

- [ ] **No custom time-zone setting (#755); no birthday-calendar colour; no "Day" view on mobile (see above)** — `P3` — `missing` — time-zone setting (`calendarTimeZone`, used for saved events and JMAP queries) done in 58a6f45 + 0f80e98; the editors and views work in calendar-zone wall time since a8e6f6e and 8af163a, and floating task dues since 1a651a9; deferred: birthday-calendar colour setting
  - What WEB does: `timeZone: 'auto' | IANA` overriding browser detection, used for display (`displayNow`, `toDisplayDate`) and for the `timeZone` on saved events (ref `lib/timezone.ts:29-75`, `stores/settings-store.ts:317, 553`, changelog 1.9.2 #755); `birthdayCalendarColor` (`settings-store.ts:377, 609`).
  - What RN does: device zone only (`src/api/calendar.ts:15-21`); birthday colour fixed (`src/lib/birthday-calendar.ts:7`).
  - Fix hint: add `timeZone` to the settings store (synced with WEB's key so it round-trips through settings sync), pass it as the JMAP `timeZone` arg and into saved events; convert display via `Intl` like WEB's `getWallClock`.

## Verified at parity (brief list, so the fixer knows what NOT to redo)
- Client-side recurrence expansion: `src/lib/recurrence-expansion.ts` is a faithful port of `lib/recurrence-expansion.ts` (byX filtering, bySetPosition, RDATE overrides, fast-forward, per-occurrence `utcStart`/`utcEnd` #116); only the server-instance guard differs.
- Stalwart singular `recurrenceRule`/`excludedRecurrenceRule` normalisation on read and write (#13, JSCalendar 2.0) — `src/api/calendar.ts:64-126`.
- Singular `inCalendar` OR-filter, `timeZone` on query/get, batched `CalendarEvent/get` (#141) — `src/api/calendar.ts:30-38, 210-231`.
- Shared calendars via other session accounts, namespaced ids (`${accountId}:${id}`), `originalId`, event remapping, per-account query routing, best-effort failure isolation — `src/api/calendar.ts:140-186`, `src/stores/calendar-store.ts:35-58, 170-204`.
- Per-viewer colours for shared calendars with auto-assigned unused palette colour (#345) — `src/screens/CalendarScreen.tsx:181-211`, `src/lib/calendar-utils.ts:465-511`.
- Tasks-only calendars hidden from event UI and pickers (#28 / 9c084d9d) — `CalendarScreen.tsx:227-242`.
- Set default calendar via `onSuccessSetIsDefault` — `src/api/calendar.ts:403-413`.
- Malformed `utcStart`/`start` fallback (#316) — `src/lib/calendar-utils.ts:35-56`; undefined alert trigger guard (#143) — `src/lib/calendar-alerts.ts:57-60`.
- Multi-day all-day bars aligned across the week, timed full-day promotion, cluster-based overlap layout — `src/lib/calendar-utils.ts:240-420`, `WeekView.tsx:69-101`.
- Start move keeps duration (`EventModal.tsx:244-248`), Save disabled until title, long-press slot/day creates at the tapped time (7e9aeaf0 equivalent).
- Server-sent iMIP via `sendSchedulingMessages` only (no client-side duplicate emails); import uses no scheduling (#411) — `src/api/calendar.ts:233-297`.
- RSVP via RFC 6901-escaped `participants/<id>/participationStatus` — `src/api/calendar.ts:331-352`.
- Birthday calendar generation incl. Feb 29 clamp and age — identical to WEB (`diff` clean apart from the extra WEB null fields).
- iCal import with preview, select all/none, 5 MB cap, UID dedupe — `ICalImportSheet.tsx`.
- Push StateChange refresh for `Calendar`/`CalendarEvent` on primary + shared accounts — `App.tsx:390-397`, `src/stores/calendar-store.ts:261-284`.
- Calendar tab hidden when the account lacks the JMAP calendars capability — `App.tsx:95, 160`, `src/lib/capabilities.ts:25`.
- Week start setting, week numbers in month view, 12h/24h time format threaded through views.

## N/A on mobile
- Mouse drag to move/resize, click-drag create, 15-minute snapping, top-edge resize, hover preview (`hooks/use-time-grid-interactions.ts`) — long-press create is the mobile equivalent.
- Keyboard shortcuts (t/m/w/d/a/k/n, arrows), right-click context menus (long-press could carry the same actions, see "Duplicate/export" finding).
- Pro multi-account aggregation (`hooks/use-pro-multi-account-calendars.ts`, `localAccountId::` namespacing, `reconcileSelectedIds`) — RN is single-active-account.
- `/api/fetch-ical` server-side SSRF guard / DNS pinning (GHSA-24w9) — no server component in RN.
- `webcal:` / `mailto:` protocol-handler registration and import-or-subscribe prompt for detected webcal links.
- Agenda plugin sidecar, plugin event-action slot (Jitsi), Pro tab deep-link URL writing.
- Refresh-gesture interception (F5/Ctrl-R) — RN has pull-to-refresh.
- Quick natural-language event input: the webmail has no parser for it either (dropped from the findings by the 2026-09 audit).
