# React Native Calendar — Parity Plan

Bring `repos/react-native/` calendar to parity with the webmail calendar at
`components/calendar/`. Webmail totals ~5,940 lines across 19 components plus
utility libs; mobile port targets ~2,500 lines with feature parity on the
essentials and explicit deferrals for things that don't fit a phone UX.

## Current state

- `src/screens/CalendarScreenNew.tsx` — month grid + agenda-for-selected-day,
  all rendering `MOCK_EVENTS`. Doesn't touch the store.
- `src/stores/calendar-store.ts` — CRUD wiring exists (`fetchCalendars`,
  `fetchEvents`, `createEvent`, `updateEvent`, `deleteEvent`) but no
  `handleStateChange`, no per-calendar visibility, no range tracking.
- `src/api/calendar.ts` — JMAP methods wired (`Calendar/get`,
  `CalendarEvent/query`, `CalendarEvent/get`, `CalendarEvent/set`).
- `src/api/types.ts` — `CalendarEvent` and `Calendar` types match webmail.
- No event modal, no detail view, no week/day view, no sidebar, no recurrence.

## In scope

### Phase 1 — Data layer (foundation for everything else)

**`src/stores/calendar-store.ts`** — expand to match webmail's store semantics:
- `hiddenCalendarIds: Set<string>` persisted via AsyncStorage (matches webmail's
  `CalendarSidebar` toggle state).
- `loadedRange: { after: string; before: string } | null` — track what's fetched
  so view changes don't re-fetch unnecessarily.
- `ensureRange(after, before)` — fetch only if the requested window isn't
  covered by `loadedRange`; expand the loaded range in place instead of
  replacing events wholesale, so switching Month → Week doesn't drop data.
- `handleStateChange(change)` — subscribe to `Calendar` and `CalendarEvent`
  typeState keys; on push, refetch calendars and re-query the current window.
  Already referenced from `App.tsx` push handler — this finally implements it.
- `toggleCalendarVisibility(id)` / `setCalendarHidden(id, hidden)`.
- Selectors: `visibleCalendars`, `visibleEvents` (filtered by hidden set).

**`src/lib/calendar-utils.ts`** (new) — port from webmail's `lib/calendar-utils.ts`:
- `parseLocalDateTime(iso)` — JSCalendar start strings are floating local time
  (`2026-04-20T09:00:00`, no Z). Parse without timezone shifts.
- `parseDuration(iso8601)` — `PT1H30M` → milliseconds.
- `eventTimeRange(event)` — returns `{ start: Date, end: Date, allDay: boolean }`
  handling `showWithoutTime`.
- `eventsOnDay(events, day)` — day overlap check (not just start-matches-day).
- `getCalendarColor(cal)` — fallback to a deterministic palette when `color`
  is missing, matching `theme/tokens.ts` `colors.calendar.*`.

**`src/lib/recurrence-expansion.ts`** (new) — minimal port of webmail's RRULE
expander. Webmail's version supports `byDay`/`byMonth`/`byMonthDay`/`count`/`until`.
Mobile port: same surface, same tests. This is the hard part — allocate ~400
lines. Drives correct rendering of recurring events across the visible window.

### Phase 2 — Views

**`src/screens/CalendarScreenNew.tsx`** — replace mocks, gain view switching:
- On mount: `fetchCalendars()`, then `ensureRange` for visible window.
- View mode toggle → Month / Week / Agenda (Day view folded into Week for phone).
- Header shows month/week label; prev/next shifts by the current view's step.
- "Today" button resets both `currentDate` and `selectedDate`.
- FAB opens create modal with `start = selectedDate at next half hour`.

**`src/components/calendar/MonthView.tsx`** (extract from current screen,
~180 lines) — real events, up to 3 colored dots per day, "+N" indicator when
more. Tap day → selects + scrolls agenda below. Long-press day → opens create
modal with that date.

**`src/components/calendar/WeekView.tsx`** (new, ~350 lines) — port of
`calendar-week-view.tsx` (511 lines) trimmed for mobile:
- 7 day columns, hour rows from 6am–10pm scrollable to 0–24.
- All-day strip at top.
- Events positioned absolutely by `utcStart`/`utcEnd`, width shared among
  overlapping events (port webmail's stacking algorithm).
- Tap event → detail modal. Long-press empty slot → create modal pre-filled.
- Horizontal swipe → prev/next week (react-native-gesture-handler already
  available via react-navigation).
- *Deferred*: drag-to-reschedule, drag-to-resize. Phone targets are too small
  for it to be better than tap-edit.

**`src/components/calendar/AgendaView.tsx`** (new, ~120 lines) — port of
`calendar-agenda-view.tsx`. Flat list of upcoming events grouped by day, 30
days forward. Taps open detail modal.

### Phase 3 — Event interaction

**`src/components/calendar/EventDetailSheet.tsx`** (new, ~280 lines) — bottom
sheet presenting a single event, port of `event-detail-popover.tsx` (631 lines
on web — phone version drops the hover card chrome and the inline-edit fields):
- Header: calendar color bar, title, date/time range (or "All day"), calendar name.
- Sections: location, description (linkified), participants with RSVP status,
  recurrence summary (e.g. "Weekly on Mon, Wed — until 2026-06-01"), reminders.
- Actions row: Edit, Delete, Duplicate, "Open in email" if created from invite.
- If recurring: delete/edit prompts via `RecurrenceScopeDialog` ("This event
  only" / "This and following" / "All events").

**`src/components/calendar/EventModal.tsx`** (new, ~550 lines) — full-screen
modal for create + edit, port of `event-modal.tsx` (1,072 lines on web, trimmed):
- Title, calendar picker (color swatches), all-day toggle.
- Start/end date+time pickers (`@react-native-community/datetimepicker` — add dep).
- Location, description (multiline).
- Participant input with autocomplete from contacts store (port of
  `participant-input.tsx`, ~180 lines).
- Repeat picker: None / Daily / Weekly (weekday chips) / Monthly / Yearly,
  plus end: Never / After N / On date. Advanced iCal rules (BYSETPOS etc.)
  are deferred — covers the 95% case.
- Alerts: None / At start / 5m / 15m / 30m / 1h / 1d before, mapping to
  `Alert.trigger.offset`.
- Timezone: default to device TZ; optional override picker hidden behind
  "Advanced" disclosure.
- Save path handles "this instance only" override vs master update for
  recurring events (write to `recurrenceOverrides[recurrenceId]`).

**`src/components/calendar/RecurrenceScopeDialog.tsx`** (new, ~90 lines) —
direct port of `recurrence-scope-dialog.tsx`. Three-button picker before
edit/delete of a recurring instance.

### Phase 4 — Multi-calendar

**`src/components/calendar/CalendarSidebarDrawer.tsx`** (new, ~200 lines) —
port of `calendar-sidebar-panel.tsx` (273 lines). Slides in from the left
(reuses `SidebarDrawer.tsx`):
- List of calendars with color swatch + visibility toggle + name.
- "My calendars" vs "Subscribed" sections if `myRights` differs.
- Tap calendar → highlight; long-press → rename/color/hide (optional, phase 4.5).
- Footer: "Add calendar" (deferred to Phase 6).

**`src/theme/tokens.ts`** — audit `colors.calendar.*` palette against webmail's
calendar color constants (`lib/calendar-utils.ts` `CALENDAR_COLOR_PALETTE`);
add any missing shades.

### Phase 5 — Polish

- Pull-to-refresh on each view → forces re-fetch of current window.
- Empty states per view (no calendars yet / no events this month).
- Loading skeleton for month grid and week grid.
- Error banner when fetch fails (pattern from `EmailListScreen`).
- Respect `email-store` push via `handleStateChange` so events update live
  when another client creates one.

## Explicitly deferred (out of scope)

These are in the webmail but don't make sense for a first mobile pass:

- **iCal import/subscribe modals** (`ical-import-modal.tsx` 455 lines,
  `ical-subscription-modal.tsx` 220 lines) — file picker + URL subscription
  with auth flows. Better as a dedicated settings flow later.
- **Tasks module** (`task-list-view.tsx`, `task-modal.tsx`, `task-toolbar.tsx`) —
  JSCalendar `@type: 'Task'` is a separate surface from events; worth its own
  screen, not bolted onto calendar.
- **Drag to reschedule / resize** — mobile tap targets are too small for the
  fine-grained control the web drag gives; tap-edit is the mobile idiom.
- **Quick event input** (`quick-event-input.tsx`) — NLP parser ("Lunch tomorrow
  at noon"). Neat on desktop, marginal on phone where typing is already slow.
- **Event context menu** (`event-context-menu.tsx`) — right-click is desktop-
  only. Actions move into the detail sheet's action row.
- **Mini-calendar** (`mini-calendar.tsx`) — web uses it as a sidebar date
  picker. Mobile already has the main month view; redundant.
- **Birthday calendar auto-derived events** — lower priority; leave the
  contacts-store integration for a follow-up.

## Dependencies to add

- `@react-native-community/datetimepicker` — native date/time pickers.
- `react-native-reanimated` is already in (via react-navigation); reuse for
  bottom-sheet animations on `EventDetailSheet`.
- No new calendar library — reimplement RRULE expansion in ~400 lines rather
  than pulling in `rrule.js` (which adds ~180KB and expects browser APIs).

## File map (new / modified)

```
repos/react-native/src/
├── screens/
│   └── CalendarScreenNew.tsx                  [rewrite]
├── components/
│   └── calendar/                              [new directory]
│       ├── MonthView.tsx                      [new]
│       ├── WeekView.tsx                       [new]
│       ├── AgendaView.tsx                     [new]
│       ├── EventCard.tsx                      [new]
│       ├── EventDetailSheet.tsx               [new]
│       ├── EventModal.tsx                     [new]
│       ├── ParticipantInput.tsx               [new]
│       ├── RecurrenceScopeDialog.tsx          [new]
│       ├── CalendarSidebarDrawer.tsx          [new]
│       └── index.ts                           [new]
├── stores/
│   └── calendar-store.ts                      [extend]
├── lib/
│   ├── calendar-utils.ts                      [new]
│   └── recurrence-expansion.ts                [new]
└── theme/
    └── tokens.ts                              [audit calendar palette]
```

## Testing approach

- `vitest.config.ts` already exists. Unit tests for:
  - `recurrence-expansion` (daily/weekly/monthly, count+until, byDay).
  - `calendar-utils` (duration parse, all-day overlap, DST boundary).
  - Store: `ensureRange` dedup, `handleStateChange` refetch trigger.
- Manual emulator test matrix:
  - Create event (timed, all-day, recurring), verify server round-trip.
  - Edit recurring event via scope dialog.
  - Delete recurring instance vs series.
  - Toggle calendar visibility, confirm events disappear.
  - Push update from webmail, confirm mobile refreshes.

## Build order (suggested)

1. Phase 1 in full — nothing else works without real data.
2. MonthView + EventDetailSheet (read path) — first thing user sees.
3. EventModal create path — unblocks manual testing of write path.
4. AgendaView + CalendarSidebarDrawer — pulls the rest of month together.
5. WeekView — biggest UI, easiest to defer if time runs short.
6. EventModal edit + recurrence scope — finishes the edit surface.
7. Phase 5 polish.

Rough size estimate: ~2,500 lines of new RN code + ~300 lines of store/util
changes. Each phase is ship-safe on its own — the app stays functional even if
we stop at Phase 2.
