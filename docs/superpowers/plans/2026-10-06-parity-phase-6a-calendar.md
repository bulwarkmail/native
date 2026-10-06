# Parity Phase 6a: Calendar Sweep Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- Close the calendar follow-up that hardening pass 1 left open, which is a wrong-account write.
- Work through the open calendar parity items that need nothing outside this repo.

**Architecture:**
- Each task is one area of the calendar. As in the earlier phases, logic goes into pure `src/lib/*` helpers with tests, and screens stay thin.
- Account isolation follows hardening pass 1. Use the scope helpers in `src/stores/email-store.ts` (`requireShownAccountScope`, `isShownAccount`) and `src/lib/active-client-account.ts` (`clientServesAccount`), and the client's `requestContext()` / `request(…, { gen })`. Every write carries its own account.

**Tech Stack:** React Native / Expo, TypeScript, Zustand, vitest, JMAP Calendars (JSCalendar, `CalendarEvent`, `Principal/getAvailability`, `ParticipantIdentity`).

**Spec:**
- The open items in [05-calendar.md](../../parity/05-calendar.md).
- The "Hardening pass 1" follow-ups in [2026-10-04-webmail-parity-roadmap.md](2026-10-04-webmail-parity-roadmap.md) (the calendar event detail sheet).
- The webmail checkout at `7e1a659` is the authority for each feature.

## Global Constraints

- **Branch:** `parity/phase-6a-calendar`, from `main` at `e699fbf`.
- **Gate on every commit:** `npm run typecheck && npm test && npm run i18n:check`.
- **Strings:** use `t('key', 'English fallback')` with webmail's key. Harvest missing webmail keys into `locales/rn/en.json` with webmail's English.
- **Commits:** one per task, with the task's subject and the `Co-Authored-By:` and `Claude-Session:` trailers. Stage by explicit path.
- **Parity docs:** do not edit `docs/parity/*.md` or `PARITY_CHECKLIST.md` in a task.
- **Tests:** vitest in node, with no RN render harness. Write tests first and record RED.
- **Accounts:** every calendar write passes the event's own account explicitly. Any write that can outlive an account switch re-checks first that the account is served and shown.

## Review Focus

1. **An event opened in account A cannot be deleted, edited or answered (RSVP) in account B after a switch.** Owned by Task 1, test `a detail sheet opened in A refuses to write after a switch`.
2. **Duplicating an event, or adding a note to it, never changes the original event's id or its participants.** Owned by Task 2.
3. **A date deep link opens that date; an event deep link still opens the event.** Owned by Task 3.
4. **The organizer chosen for a new invitation is one of the user's own identities**, and existing events keep their organizer. Owned by Task 4.
5. **Free/busy shows only for participants the server answers for**, and a failed lookup never blocks saving. Owned by Task 5.

## Not in this phase

- **Pinning `supported-calendar-component-set` at creation (#760).** This needs a CalDAV client and calendar-home discovery.
- **The Jalali month grid.** This waits until the `fa` locale is added.
- **Calendar types in the background push subscription.** The item says to leave it unless a background refresh is needed.

---

### Task 1: Tie the event detail sheet to its account

**Closes:** the Hardening pass 1 follow-up, "CalendarScreen's event detail sheet isn't tied to an account".

**Files:**
- Modify: `src/screens/CalendarScreen.tsx` (`detailEvent` ~:254, and the delete/update/RSVP calls ~:615-652) and `src/stores/calendar-store.ts` (`resolveMutationTarget` and the write actions).
- Test: `src/stores/__tests__/calendar-store.test.ts`, plus a pure helper test.

**Interfaces:**
- When the sheet opens, capture `{ appAccountId, jmapAccountId }` for the event. `jmapAccountId` is the event's calendar account, or the primary account.
- Delete, update, RSVP, duplicate, export and the note action all pass that pair explicitly.
- The store refuses when the app account isn't the one shown and served. It shows the existing "switch back" text, and calls the API with an explicit account inside a scope.
- Close the sheet when the active account changes.

- [ ] **Step 1: Write the failing tests.**
  - `a detail sheet opened in A refuses to write after a switch` (Review Focus 1).
  - A write with an explicit shared calendar account goes to that account.
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to verify they pass.**
- [ ] **Step 5: Commit** `fix: keep the event detail sheet's actions to the account it opened in`

### Task 2: Copy the title and append a note

**Closes (05):** the rest of "Duplicate event, export .ics, copy meeting link / title, add note". Duplicate, export and copy link were done in 5fe8e40.

**Files:**
- Modify: `src/components/calendar/EventDetailSheet.tsx`
- Create: `src/lib/event-note.ts`, a pure `appendEventNote(description, note, now, locale)` modelled on WEB `components/calendar/calendar-app.tsx:1017-1125`.
- Test: `src/lib/__tests__/event-note.test.ts`

**Interfaces:**
- Copy title uses `expo-clipboard` and the existing toast pattern.
- Add note opens a small prompt and appends a timestamped line to the description, in WEB's format.
- It is saved with `updateEvent`, passing only `description` and the account from Task 1.
- Recurring events: ask "this occurrence / all" the same way other single-field edits do. Read the current code to see how.

- [ ] **Step 1: Write the failing tests.** The note format matches WEB's. An empty description gives just the note. Existing text is kept. The participants and id are untouched (Review Focus 2).
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to verify they pass.**
- [ ] **Step 5: Commit** `feat: copy an event's title and add a note to it`

### Task 3: Deep links to a calendar date

**Closes (05):** "Deep links to calendar/event". A date link currently only opens the Calendar tab.

**Files:**
- Modify: `src/navigation/types.ts` (`Calendar` params), `src/navigation/linking.ts` (`handleDeepLink`), `src/screens/CalendarScreen.tsx`, and `src/lib/pending-calendar-open.ts` (or wherever pending opens live).
- Test: the linking tests.

**Interfaces:**
- Port WEB `lib/deep-links.ts:272-300` (`parseCalendarPath`/`buildCalendarPath`): `/calendar/<view>/<date>?event=`.
- A date link opens that date in the given view. An event link keeps today's behaviour.
- An invalid date falls back to today without an error.

- [ ] **Step 1: Write the failing tests.** Parse view and date, view only, an invalid date, and an event link (Review Focus 3).
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to verify they pass.**
- [ ] **Step 5: Commit** `feat: open a calendar date from a link`

### Task 4: A default identity for organizing

**Closes (05):** "No default `ParticipantIdentity` for organizing".

**Files:**
- Modify: `src/stores/calendar-store.ts` (load `ParticipantIdentity`), `src/components/settings/CalendarSettings.tsx`, `src/components/calendar/EventModal.tsx` (~:330), and `src/api/calendar.ts`.
- Test: the store and helper tests.

**Interfaces:**
- WEB `stores/calendar-store.ts:577-660` and `components/settings/calendar-settings.tsx:23-104` are the reference.
- Load the `ParticipantIdentity` list (`ParticipantIdentity/get`) when the capability exists.
- A setting picks the default one. Store it in webmail's settings key if webmail has one, otherwise in an app-only key.
- New invitations use it as the organizer. Existing events keep theirs (Review Focus 4).
- With no capability, keep today's behaviour (`currentUserEmails[0]`).

- [ ] **Step 1: Write the failing tests.**
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to verify they pass.**
- [ ] **Step 5: Commit** `feat: choose the identity that organizes new invitations`

### Task 5: Attendee free/busy

**Closes (05):** "No attendee free/busy (`Principal/getAvailability`)".

**Files:**
- Create: `src/api/availability.ts` and a pure `src/lib/availability.ts` (the busy blocks merged over the event's range).
- Modify: `src/components/calendar/ParticipantInput.tsx` and `src/components/calendar/EventModal.tsx`.
- Test: both new modules.

**Interfaces:**
- WEB `components/calendar/participant-availability.tsx` is the reference.
- For each participant with a principal id (from the directory loaded in Phase 4a Task 7), call `Principal/getAvailability` over the event's day with an explicit account.
- Show free, busy or unknown per participant, and a small strip over the event's time.
- Request at most once per participant and range, and only when the editor is open.
- A failure shows "unknown" and never blocks saving (Review Focus 5).

- [ ] **Step 1: Write the failing tests.** Request shape, merging overlapping busy blocks, unknown on error, and no request without a principal.
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to verify they pass.**
- [ ] **Step 5: Commit** `feat: show attendees' free and busy times while planning an event`

### Task 6: Tasks in the month view and the all-day strip

**Closes (05):**
- "Tasks with a due date are not shown in the month view (#1107)". Due-dated tasks are already drawn as calendar items, so this task does the polish webmail has.
- The "no tasks in it" half of "The week view's all-day strip … (#1122)".

**Files:**
- Modify: `src/screens/CalendarScreen.tsx` (~:365-390), `src/components/calendar/MonthView.tsx`, `MonthScrollView.tsx` and `WeekView.tsx`, and the all-day strip in `TimeGridScrollView.tsx`.
- Create: `src/lib/calendar-tasks.ts`, a port of WEB `lib/calendar-tasks.ts`.
- Test: `src/lib/__tests__/calendar-tasks.test.ts`

**Interfaces:**
- Port WEB `lib/calendar-tasks.ts` and `task-chip.tsx`:
  - tasks follow calendar visibility;
  - completed tasks are struck through;
  - a completion circle toggles done through the existing task API, with an explicit account;
  - all-day or date-only tasks go in the week view's all-day strip and count toward its 3-row cap.

- [ ] **Step 1: Write the failing tests.** Port WEB's cases.
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to verify they pass.**
- [ ] **Step 5: Commit** `feat: show tasks in the month view and the all-day strip, as webmail does`

### Task 7: Birthday calendar colour

**Closes (05):** the birthday colour part of "No custom time-zone setting …; no birthday-calendar colour". The time zone part was done earlier.

**Files:**
- Modify: `src/stores/settings-store.ts` (`birthdayCalendarColor`, webmail's key, with its default and validator), `src/lib/birthday-calendar.ts` (~:7), and `src/components/settings/CalendarSettings.tsx`.
- Test: the settings and birthday-calendar tests.

**Interfaces:** WEB `settings-store.ts:377, 609` gives the key and default. Use the existing colour picker pattern.

- [ ] **Step 1: Write the failing tests.**
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to verify they pass.**
- [ ] **Step 5: Commit** `feat: choose the birthday calendar's colour`

### Task 8: Localize the remaining calendar screens

**Closes (05):** the rest of "Entire calendar UI is hard-coded English": `ICalSubscriptionSheet` and `RecurrenceEditor`.

**Files:**
- Modify: `src/components/calendar/ICalSubscriptionSheet.tsx` and `src/components/calendar/RecurrenceEditor.tsx`.
- Test: `npm run i18n:check` covers the keys. Any date formatting moved into a helper gets a unit test with a non-English locale.

**Interfaces:**
- Every string goes through `t()` with webmail's `calendar.*` keys.
- Dates use the locale store's date-fns locale.
- Recurrence summaries ("Every 2 weeks on Monday") match webmail's keys and plural forms.

- [ ] **Step 1: Write the failing tests** for any extracted helper.
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to verify they pass.** Then run `npm run i18n:check`.
- [ ] **Step 5: Commit, then close the phase.** Commit `feat: translate the subscription sheet and the recurrence editor`. After the final review, tick the parity items in one `docs:` commit.
