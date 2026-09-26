/**
 * Saving an event editor change made on one occurrence of a series for the
 * part of the series the user picks in the recurrence scope dialog - that
 * occurrence, it and the ones after it, or all of them - and deleting that
 * part. Port of the webmail's lib/recurrence-scope-edit.ts, on the calendar
 * store's actions.
 */

import { differenceInCalendarDays } from 'date-fns';
import type { CalendarEvent, RecurrenceRule } from '../api/types';
import type { RecurrenceEditScope } from '../components/calendar/RecurrenceScopeDialog';
import { getEventStartDate, getPrimaryCalendarId } from './calendar-utils';
import {
  hasAnsweredAttendees,
  participantsAskedAgain,
  seriesParticipantFields,
  userOrganizes,
  type Attendee,
  type ParticipantSaveContext,
} from './calendar-participants';
import { editorTimesChanged, type EditorTimes } from './event-editor-times';
import {
  buildFallbackExcludePatch,
  buildFallbackOverridePatch,
  buildOccurrencePatch,
  buildOverrideInTwoSteps,
  createsOverride,
  isBrowserExpandedOccurrence,
  isServerRecurrenceInstance,
  overrideContextOf,
  parseDurationSeconds,
  resolveOverrideKey,
  stableJson,
  withNewOverrideDetails,
} from './recurrence-instances';
import { occurrencesBefore, seriesOccursAt } from './recurrence-expansion';
import { recurrenceRulesEqual } from './recurrence';
import {
  formatWallClock,
  fromDisplayDate,
  getEffectiveTimeZone,
  getTimeZoneOffsetMs,
  isValidTimeZone,
  localDateTimeToInstant,
} from './calendar-timezone';
import { debug } from './debug';

/** What the event editor had when it saved, besides the event data it wrote. */
export interface SeriesEdit {
  /** The attendee rows the user left; the organizer is not among them. */
  attendees: Attendee[];
  /** When the event happens in the editor: display dates, the last day of an all-day event. */
  when: EditorTimes;
  /** The user changed the recurrence rule: a series then happens on other days. */
  ruleChanged?: boolean;
}

const WHEN_KEYS = ['start', 'duration', 'timeZone', 'showWithoutTime'] as const;
type SeriesWhen = Partial<Pick<CalendarEvent, typeof WHEN_KEYS[number]>>;

/** A display date's wall clock to the minute (the editor shows no seconds), as milliseconds. */
function wallClockMinutesMs(date: Date): number {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), date.getMinutes());
}

/** A LocalDateTime ("YYYY-MM-DDTHH:mm:ss") as its wall clock in milliseconds, read as UTC; null when it does not parse. */
function wallClockMs(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(value);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map((part) => Number(part ?? 0));
  const wall = new Date(0);
  wall.setUTCFullYear(year, month - 1, day);
  wall.setUTCHours(hour, minute, second, 0);
  return wall.getTime();
}

/** A LocalDateTime ("YYYY-MM-DDTHH:mm:ss") moved by `ms` on its own wall clock. */
function shiftLocalDateTime(value: string, ms: number): string {
  const wall = wallClockMs(value);
  return wall === null ? value : new Date(wall + ms).toISOString().slice(0, 19);
}

/** `value` moved on the wall clock by as much as `from` moved to `to`. */
function movedLike(value: string, from: string, to: string): string {
  const [before, after] = [wallClockMs(from), wallClockMs(to)];
  return before === null || after === null ? value : shiftLocalDateTime(value, after - before);
}

/** A LocalDateTime read as the wall clock in `fromZone`, as the wall clock in `toZone` at the same instant. */
function moveLocalDateTime(value: string, fromZone: string, toZone: string): string {
  if (fromZone === toZone || !isValidTimeZone(toZone)) return value;
  const instant = localDateTimeToInstant(value, fromZone);
  return instant ? formatWallClock(instant, toZone) : value;
}

type OverrideMap = NonNullable<CalendarEvent['recurrenceOverrides']>;
type OverrideEntry = Record<string, unknown>;

/** Where a series' occurrences are: what the keys of its overrides, their recurrence ids, are. */
interface SeriesFrame {
  start: string;
  timeZone?: string | null;
  showWithoutTime: boolean;
  recurrenceRules: CalendarEvent['recurrenceRules'];
}

/**
 * Whether `rules` name the days their occurrences fall on (BYDAY,
 * BYMONTHDAY, BYYEARDAY): a start moved by days does not take those
 * occurrences along.
 */
function namesItsDays(rules: CalendarEvent['recurrenceRules']): boolean {
  return (rules ?? []).some((rule) => !!rule.byDay?.length || !!rule.byMonthDay?.length || !!rule.byYearDay?.length);
}

/**
 * The key an override of the series `from` keeps in the series `to`, or
 * null when `to` has no such occurrence any more. It moves with its
 * occurrence, by as much as `anchor` - the series' start, or where a new
 * series takes over - moved to `to.start` (to the same day at the new time
 * when the series turns all-day or timed). A rule that pins the occurrence
 * where it was - a weekday rule the start moved away from - keeps the key,
 * and an occurrence the new rule does not give is gone. A date the override
 * adds to the series, which no rule gives, moves along.
 *
 * A rule that names its days keeps every occurrence but the anchor on its
 * day, at the series' new time: moved by a day, the Monday of a Monday and
 * Tuesday series is still that Monday. Moved along, its override landed on
 * the Tuesday's and took its place: a cancelled Tuesday came back with the
 * Monday's title, and the Monday lost its change (live on 1.0 and 0.16.23).
 */
function overrideKeyIn(key: string, from: SeriesFrame, to: SeriesFrame, anchor = from.start): string | null {
  const shifted = movedLike(key, anchor, to.start);
  const moved = to.showWithoutTime ? `${shifted.slice(0, 10)}T00:00:00` : shifted;
  if (!seriesOccursAt(from.start, from.recurrenceRules, key)) return moved;
  if (namesItsDays(to.recurrenceRules) && wallClockMs(key) !== wallClockMs(anchor)) {
    const sameDay = `${key.slice(0, 10)}${moved.slice(10)}`;
    return seriesOccursAt(to.start, to.recurrenceRules, sameDay) ? sameDay : null;
  }
  if (seriesOccursAt(to.start, to.recurrenceRules, moved)) return moved;
  if (moved !== key && seriesOccursAt(to.start, to.recurrenceRules, key)) return key;
  return null;
}

/**
 * `overrides` with the key each takes (keyOf), those without one left out,
 * and never two on one key: an override that stays where it is comes first,
 * and one that would land on a key already taken is left out and logged
 * rather than overwrite it. Two occurrences of one series never share a
 * recurrence id.
 */
function rekeyed(
  overrides: OverrideMap,
  keyOf: (key: string) => string | null,
): Array<{ key: string; target: string; override: OverrideMap[string] }> {
  const moves = Object.entries(overrides)
    .map(([key, override]) => ({ key, target: keyOf(key), override }))
    .filter((move): move is { key: string; target: string; override: OverrideMap[string] } => move.target !== null);
  moves.sort((a, b) => Number(b.target === b.key) - Number(a.target === a.key));
  const taken = new Set<string>();
  return moves.filter((move) => {
    if (!taken.has(move.target)) {
      taken.add(move.target);
      return true;
    }
    debug.warn('calendar', 'Two recurrence overrides map to one occurrence; keeping the first', move.target, move.key);
    return false;
  });
}

/**
 * `entry` with its attendees asked again (participantsAskedAgain): a whole
 * participants map (0.16) with their answers back at needs-action, a
 * pointer at one answer (1.0 returns an override as a PatchObject) left out,
 * so the series' answer - asked again - counts.
 */
function withAnswersAskedAgain(entry: OverrideEntry, series: CalendarEvent): OverrideEntry {
  const organizer = { organizerCalendarAddress: series.organizerCalendarAddress, replyTo: series.replyTo };
  const result: OverrideEntry = {};
  for (const [key, value] of Object.entries(entry)) {
    if (/^participants\/[^/]+\/participationStatus$/.test(key)) continue;
    const whole = key === 'participants' || /^participants\/[^/]+$/.test(key);
    if (whole && value && typeof value === 'object') {
      const participants = key === 'participants'
        ? value as CalendarEvent['participants']
        : { p: value } as unknown as CalendarEvent['participants'];
      const asked = participantsAskedAgain({ ...organizer, participants });
      result[key] = asked ? (key === 'participants' ? asked : asked.p) : value;
      continue;
    }
    result[key] = value;
  }
  return result;
}

/**
 * `entry` with the participants of a new series, `participants`: pointers
 * into the old ones (1.0 returns an override as a PatchObject) dropped, so
 * the series' count; a whole map (0.16) replaced by the series', or dropped
 * with them. 0.16 keeps an override as an event of its own - without a map
 * it has no attendees, and its occurrence goes to nobody.
 */
function withParticipantsOf(entry: OverrideEntry, participants: CalendarEvent['participants'] | undefined): OverrideEntry {
  const result = Object.fromEntries(Object.entries(entry).filter(([key]) => !key.startsWith('participants/')));
  if (!('participants' in result)) return result;
  if (participants && Object.keys(participants).length > 0) result.participants = participants;
  else delete result.participants;
  return result;
}

/** `date`, a display date in the calendar's zone, as the wall clock of `timeZone` to the minute, in milliseconds. */
function zonedMinutesMs(date: Date, timeZone: string): number {
  const wall = wallClockMs(formatWallClock(fromDisplayDate(date), timeZone)) ?? 0;
  return Math.floor(wall / 60_000) * 60_000;
}

/**
 * How far the editor moved an occurrence from `from` to `to` (display dates)
 * on the series' own clock: its zone's wall clock when it has one. Measured
 * on the calendar's clock, a move across a week in which only one of the two
 * zones changed to or from daylight saving time moved the series by an hour
 * more or less than the occurrence: from Saturday 10:00 in New York to
 * Monday 11:00 there (16:00 on both days for a user in Berlin) made it
 * Mondays at 10:00.
 */
function seriesClockDelta(from: Date, to: Date, series: CalendarEvent): number {
  const zone = !series.showWithoutTime && series.timeZone && isValidTimeZone(series.timeZone) ? series.timeZone : null;
  return zone
    ? zonedMinutesMs(to, zone) - zonedMinutesMs(from, zone)
    : wallClockMinutesMs(to) - wallClockMinutesMs(from);
}

/**
 * When the series happens after the editor moved one of its occurrences:
 * its own start moved by as much as the occurrence was, on its own date and
 * in its own zone (seriesClockDelta); the length only when the editor
 * changed it. Nothing when the occurrence did not move.
 */
function seriesWhen(
  occurrence: CalendarEvent,
  master: CalendarEvent,
  updates: Partial<CalendarEvent>,
  when: EditorTimes,
): SeriesWhen {
  if (!editorTimesChanged(when, occurrence)) return {};
  const result: SeriesWhen = {};
  const allDayChanged = !!master.showWithoutTime !== when.allDay;
  const from = getEventStartDate(occurrence);

  if (when.allDay) {
    // The series' first day as the calendar shows it, moved by the days the
    // occurrence moved.
    const first = !master.showWithoutTime && master.timeZone
      ? moveLocalDateTime(master.start, master.timeZone, getEffectiveTimeZone())
      : master.start;
    const days = differenceInCalendarDays(when.start, from);
    if (days !== 0 || allDayChanged) {
      result.start = `${shiftLocalDateTime(`${first.slice(0, 10)}T00:00:00`, days * 86_400_000).slice(0, 10)}T00:00:00`;
    }
  } else {
    const delta = seriesClockDelta(from, when.start, master);
    if (delta !== 0 || allDayChanged) result.start = shiftLocalDateTime(master.start, delta);
  }

  const seconds = parseDurationSeconds(occurrence.duration ?? master.duration);
  if (allDayChanged || parseDurationSeconds(updates.duration) !== seconds) {
    result.duration = updates.duration;
  }
  if (allDayChanged) {
    result.showWithoutTime = when.allDay;
    result.timeZone = updates.timeZone ?? null;
  }
  return result;
}

/** The editor's fields a save changes on its own: when (seriesWhen), who (seriesParticipantFields), which occurrence. */
const NOT_EDITOR_FIELDS = new Set<string>([...WHEN_KEYS, 'recurrenceId', 'participants', 'organizerCalendarAddress', 'replyTo']);

/** The first location's name, or virtual location's URI, as the editor shows it. */
const firstOf = (map: Record<string, { name?: string | null; uri?: string | null }> | null | undefined, field: 'name' | 'uri') =>
  (Object.values(map ?? {})[0]?.[field] ?? '').trim();

/**
 * The fields of `updates` - what the editor wrote for `occurrence` - that
 * the user changed there, compared the way the editor shows them. The
 * editor writes every field it shows, and on an occurrence with an override
 * of its own those are the occurrence's: its title, copied when it got the
 * override, or a room of its own. Written to the whole series, a new room
 * on such an occurrence also gave the series back that occurrence's old
 * title.
 */
export function changedEditorFields(
  occurrence: CalendarEvent,
  updates: Partial<CalendarEvent>,
  editor?: Pick<SeriesEdit, 'ruleChanged'>,
): Partial<CalendarEvent> {
  const ruleChanged = editor ? !!editor.ruleChanged : !recurrenceRulesEqual(occurrence.recurrenceRules, updates.recurrenceRules);
  const changed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(updates)) {
    if (NOT_EDITOR_FIELDS.has(key)) continue;
    let differs: boolean;
    switch (key) {
      case 'title':
        differs = (value ?? '') !== (occurrence.title ?? '');
        break;
      case 'description':
        differs = String(value ?? '').trim() !== (occurrence.description ?? '').trim();
        break;
      case 'locations':
        differs = firstOf(value as CalendarEvent['locations'], 'name') !== firstOf(occurrence.locations, 'name');
        break;
      case 'virtualLocations':
        differs = firstOf(value as CalendarEvent['virtualLocations'], 'uri') !== firstOf(occurrence.virtualLocations, 'uri');
        break;
      case 'calendarIds':
        differs = stableJson(Object.keys(value ?? {}).sort()) !== stableJson(Object.keys(occurrence.calendarIds ?? {}).sort());
        break;
      case 'recurrenceRules':
      case 'recurrenceOverrides':
      case 'excludedRecurrenceRules':
        differs = ruleChanged;
        break;
      default:
        differs = stableJson(value) !== stableJson((occurrence as unknown as Record<string, unknown>)[key]);
    }
    if (differs) changed[key] = value;
  }
  return changed as Partial<CalendarEvent>;
}

/**
 * `entry`, an override of `series`, with the editor's `changes` to the
 * series, where it holds a value of the field: the override of the
 * occurrence the editor was opened on takes them all - they were made on it
 * - any other one where it only held the series' old value (0.16 keeps a
 * copy of the title, place and details in every override the app writes:
 * without this, a renamed series kept its old name on those occurrences). A
 * value an override has of its own stays; one it does not hold comes from
 * the series.
 */
function withSeriesChanges(entry: OverrideEntry, changes: Partial<CalendarEvent>, series: CalendarEvent, opened: boolean): OverrideEntry {
  const result = { ...entry };
  // Only what one occurrence may carry (buildOccurrencePatch): not the
  // rule, the calendar or the default alerts switch.
  for (const [key, value] of Object.entries(buildOccurrencePatch(changes))) {
    // 1.0 returns an override as a PatchObject: a field of its own can be
    // pointers into it (`locations/loc1/name`), which would keep the old
    // value on the occurrence the change was made on.
    const pointers = Object.keys(result).filter((name) => name.startsWith(`${key}/`));
    if (opened && (key in result || pointers.length > 0)) {
      for (const name of pointers) delete result[name];
      result[key] = value;
    } else if (!opened && key in result && stableJson(result[key]) === stableJson((series as unknown as Record<string, unknown>)[key])) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Whether `entry`, the override under `key`, changes nothing about its
 * occurrence in `series`: each value it holds is the series' - its start the
 * occurrence's own. The server's bookkeeping in it does not count.
 */
function changesNothing(entry: OverrideEntry, key: string, series: Partial<CalendarEvent>): boolean {
  return !entry.excluded && Object.entries(entry).every(([name, value]) => {
    if (name === 'sequence' || name === 'updated') return true;
    if (name === 'start') return typeof value === 'string' && wallClockMs(value) === wallClockMs(key);
    return stableJson(value) === stableJson((series as unknown as Record<string, unknown>)[name]);
  });
}

/**
 * The series' recurrence overrides once `series` - its change - applies,
 * or undefined when they stay as they are.
 *
 * An override is keyed by its occurrence's recurrence id, where the rule
 * puts the occurrence. A series that moved kept them under the old ids: an
 * excluded occurrence came back, a changed one showed twice (as changed at
 * the old time, and as the series has it), in the attendees' copies too
 * (live on 1.0 and 0.16.23). Now each override goes with its occurrence
 * (overrideKeyIn), and an override of an occurrence the series no longer
 * has is dropped. An occurrence moved on its own keeps its time, as the
 * user placed it - but the one the editor was opened on takes the move the
 * user made there - while an override that only holds the time the
 * occurrence had moves with the series; so does the length. A series
 * turned all-day or timed takes every occurrence along. When the series'
 * attendees are asked again, so they are for each occurrence that moves.
 * What the user changed in the editor goes into the overrides as well
 * (withSeriesChanges).
 */
function seriesOverrides(
  occurrence: CalendarEvent,
  master: CalendarEvent,
  series: Partial<CalendarEvent>,
  options: { ruleChanged: boolean; askAgain: boolean; changes: Partial<CalendarEvent> },
): OverrideMap | null | undefined {
  const overrides = master.recurrenceOverrides;
  if (!overrides || Object.keys(overrides).length === 0) return undefined;
  const resized = series.duration !== undefined;
  const moves = series.start !== undefined || series.showWithoutTime !== undefined;
  const changes = Object.keys(buildOccurrencePatch(options.changes)).length > 0;
  if (!moves && !resized && !options.ruleChanged && !changes) return undefined;

  const from: SeriesFrame = { start: master.start, showWithoutTime: !!master.showWithoutTime, recurrenceRules: master.recurrenceRules };
  const to: SeriesFrame = {
    start: series.start ?? master.start,
    showWithoutTime: series.showWithoutTime ?? !!master.showWithoutTime,
    recurrenceRules: options.ruleChanged ? series.recurrenceRules ?? null : master.recurrenceRules,
  };
  // A series made single ("Repeat: none") keeps no overrides. Its start is
  // an occurrence of any rule (seriesOccursAt), so the first occurrence's
  // override stayed on the single event: cancelled, it hid the event from
  // every range query on 1.0 (still stored); retitled, 0.16.23 listed it
  // twice (live).
  if (options.ruleChanged && !to.recurrenceRules?.length) return null;
  const turned = from.showWithoutTime !== to.showWithoutTime;
  const opened = resolveOverrideKey({ start: occurrence.start, recurrenceId: occurrence.recurrenceId ?? master.start }, overrides);

  const result: OverrideMap = {};
  for (const { key, target, override } of rekeyed(overrides, (key) => overrideKeyIn(key, from, to))) {
    const { updated: _updated, ...rest } = override as OverrideEntry;
    let entry: OverrideEntry = rest;
    if (!entry.excluded) {
      let follows = true;
      if (turned) {
        for (const timing of WHEN_KEYS) delete entry[timing];
      } else {
        if (typeof entry.start === 'string') {
          const pinned = wallClockMs(entry.start) === wallClockMs(key)
            && (entry.timeZone === undefined || entry.timeZone === master.timeZone);
          follows = pinned || key === opened;
          // The time its occurrence had is the time it has now; one of its
          // own takes the editor's move when the editor was opened on it.
          if (pinned) entry.start = target;
          else if (follows) entry.start = movedLike(entry.start, from.start, to.start);
        }
        if (resized && typeof entry.duration === 'string'
          && (key === opened || parseDurationSeconds(entry.duration) === parseDurationSeconds(master.duration))) {
          entry.duration = series.duration;
        }
      }
      if (options.askAgain && follows) entry = withAnswersAskedAgain(entry, master);
      if (changes) entry = withSeriesChanges(entry, options.changes, master, key === opened);
      if (seriesOccursAt(to.start, to.recurrenceRules, target) && changesNothing(entry, target, { ...master, ...series })) continue;
    }
    result[target] = entry as OverrideMap[string];
  }
  // Nothing moved and no override took a change: they stay as they are.
  if (stableJson(result) === stableJson(withoutUpdated(overrides))) return undefined;
  return Object.keys(result).length > 0 ? result : null;
}

/** Overrides without the server's `updated` stamps, as a rewrite sends them. */
function withoutUpdated(overrides: OverrideMap): OverrideMap {
  return Object.fromEntries(Object.entries(overrides).map(([key, override]) => {
    const { updated: _updated, ...rest } = override as OverrideEntry;
    return [key, rest];
  })) as OverrideMap;
}

/**
 * The editor's `updates`, made on `occurrence`, as a change to its whole
 * series `master`.
 *
 * The editor shows one occurrence, so the dates and participants it writes
 * are that occurrence's. Written to the series as they are, the series
 * started on the occurrence's day - the occurrences before it gone, a
 * counted series running longer - and every occurrence got that one
 * occurrence's attendees and answers. The series keeps its own instead:
 * - its details, but for those the user changed (changedEditorFields);
 * - when it happens, unless the occurrence moved; then the series moves by
 *   as much from its own start (seriesWhen);
 * - its participants and their answers, with the attendees the user added
 *   or removed; when the series moves, the user as its organizer asks the
 *   attendees again (seriesParticipantFields);
 * - its overrides, each with its occurrence (seriesOverrides).
 */
export function seriesUpdatesFromOccurrence(
  occurrence: CalendarEvent,
  master: CalendarEvent,
  updates: Partial<CalendarEvent>,
  editor: SeriesEdit,
  context: Omit<ParticipantSaveContext, 'rescheduled'>,
): Partial<CalendarEvent> {
  const changes = changedEditorFields(occurrence, updates, editor);
  const series: Partial<CalendarEvent> = { ...changes };
  const when = seriesWhen(occurrence, master, updates, editor.when);
  Object.assign(series, when);
  const rescheduled = Object.keys(when).length > 0 || !!editor.ruleChanged;
  const participants = seriesParticipantFields(master, occurrence, editor.attendees, { ...context, rescheduled });
  Object.assign(series, participants);
  const overrides = seriesOverrides(occurrence, master, series, {
    ruleChanged: !!editor.ruleChanged,
    askAgain: rescheduled && !!participants.participants,
    changes,
  });
  if (overrides !== undefined) series.recurrenceOverrides = overrides;
  return series;
}

/** Changes of a series its attendees see - Stalwart announces them, and 1.0 raises the SEQUENCE for them. */
const ANNOUNCED_KEYS = [
  'title', 'description', 'locations', 'virtualLocations', 'status', 'participants', 'recurrenceRules',
  'excludedRecurrenceRules', 'recurrenceOverrides', ...WHEN_KEYS,
] as const;

/**
 * `series`, a change to the series `master` its attendees are told of, with
 * the SEQUENCE of the series and of each of its changed occurrences one up.
 *
 * 0.16 (0.16.6 to 0.16.23) sends the change of one occurrence with that
 * occurrence's SEQUENCE raised, but does not keep the raise itself (in
 * organizer.rs the list of components to raise is shadowed for such
 * changes). A later change of every occurrence that does not raise the
 * number again - a new title - then carried a lower SEQUENCE for that
 * occurrence than the attendee's copy has, and the attendee's server
 * refused the whole change as out of sequence: the mail arrived, the copy
 * stayed as it was (live on 0.16.23). One up from what the organizer's
 * copy holds is at least what the attendees got. 1.0 raises every
 * occurrence's SEQUENCE the same way itself for a change it announces, and
 * keeps a number it would have given (live: the same result with and
 * without). The app's update sends `sequence` as it is; nothing strips it.
 */
function withRaisedSequences(series: Partial<CalendarEvent>, master: CalendarEvent): Record<string, unknown> {
  const base = master.sequence ?? 0;
  const raised: Record<string, unknown> = { ...series, sequence: base + 1 };
  const raise = (entry: OverrideEntry) => (entry.excluded ? entry : { ...entry, sequence: Number(entry.sequence ?? base) + 1 });
  if (series.recurrenceOverrides !== undefined) {
    if (series.recurrenceOverrides) {
      raised.recurrenceOverrides = Object.fromEntries(Object.entries(series.recurrenceOverrides)
        .map(([key, entry]) => [key, raise(entry as OverrideEntry)]));
    }
  } else {
    for (const [key, entry] of Object.entries(master.recurrenceOverrides ?? {})) {
      if (!(entry as OverrideEntry).excluded) raised[`recurrenceOverrides/${key}/sequence`] = raise(entry as OverrideEntry).sequence;
    }
  }
  return raised;
}

/**
 * Whether saving `series` for every occurrence of `master` raises their
 * SEQUENCE (withRaisedSequences): the user organizes the series and tells
 * its attendees of a change they see, and it has occurrences of its own a
 * change of one of them may have left behind.
 */
function raisesSequences(series: Partial<CalendarEvent>, master: CalendarEvent, edit: OccurrenceEdit): boolean {
  return !!edit.sendScheduling
    && !!edit.editor
    && Object.keys(master.participants ?? {}).length > 0
    && userOrganizes(master, edit.userEmails)
    && Object.values(master.recurrenceOverrides ?? {}).some((entry) => !(entry as OverrideEntry).excluded)
    && ANNOUNCED_KEYS.some((key) => key in series);
}

/** The calendar store's scheduling switch for one write: true sends the attendees messages, false is quiet. */
interface SchedulingOptions {
  sendSchedulingMessages?: boolean;
}

/** What saving an occurrence edit works with: the calendar store's actions. */
export interface OccurrenceEditActions {
  updateEvent: (
    id: string,
    changes: Partial<CalendarEvent> | Record<string, unknown>,
    options?: SchedulingOptions,
  ) => Promise<void>;
  /** The created event; a store that answers a failure with nothing counts as failed. */
  createEvent: (
    event: Partial<CalendarEvent>,
    calendarId: string,
    options?: SchedulingOptions,
  ) => Promise<CalendarEvent | null | undefined>;
  /** The base event of a series, from one of its occurrences. */
  getMasterEvent: (occurrence: CalendarEvent) => Promise<CalendarEvent | null>;
}

export interface OccurrenceEdit {
  /** The occurrence the editor was opened on. */
  event: CalendarEvent;
  /** What the editor wrote for it. */
  updates: Partial<CalendarEvent>;
  /** What the editor had. Without it the updates go to the series as they are. */
  editor?: SeriesEdit;
  /** The calendar (store id) the editor saves to: where the rest of a split series goes. */
  calendarId?: string;
  /** The editor's "Send invitations": the organizer's messages to the attendees. */
  sendScheduling?: boolean;
  /** The user's calendar addresses; the first organizes new invitations. */
  userEmails: string[];
  /** A name for an address the event data carries none for. */
  resolveName?: (email: string) => string | undefined;
}

/**
 * An occurrence the server keeps as an event of its own - an invitation to
 * that occurrence alone - with no series to find: whatever the scope, it is
 * the one thing there is to change or delete.
 */
function isLoneOccurrence(event: CalendarEvent): boolean {
  return !!event.recurrenceId && !event.recurrenceRules?.length && !isServerRecurrenceInstance(event);
}

/**
 * The series `event` belongs to, or null. The store hands back the stored
 * event for an id it cannot place as a series; only one with a rule is one.
 */
async function seriesOf(event: CalendarEvent, actions: Pick<OccurrenceEditActions, 'getMasterEvent'>): Promise<CalendarEvent | null> {
  const master = await actions.getMasterEvent(event);
  return master && (master.recurrenceRules?.length ?? 0) > 0 ? master : null;
}

/** A series itself, not one of its occurrences: it has rules and no recurrence id. */
function isSeries(event: CalendarEvent): boolean {
  return (event.recurrenceRules?.length ?? 0) > 0 && !event.recurrenceId;
}

/**
 * `event` as an occurrence of `master`, to override or exclude on it: itself
 * when it is one, the series' first occurrence when it is the series itself.
 * The app shows a series it has not expanded - one opened from a reminder or
 * a link, one an edit just made recurring - as the series, once, at its
 * first occurrence; a change to "this occurrence" of it went to the series
 * and rewrote every occurrence, and deleting it deleted them all.
 */
function asOccurrenceOf(event: CalendarEvent, master: CalendarEvent): CalendarEvent {
  const occurrence = event.recurrenceId
    ? event
    : { ...event, recurrenceId: master.start, recurrenceIdTimeZone: master.timeZone ?? null };
  return overrideContextOf(occurrence, master);
}

/** Whether `event` is `master`'s first occurrence, or the series itself standing for it. */
function isFirstOccurrence(event: CalendarEvent, master: CalendarEvent): boolean {
  if (!event.recurrenceId) return true;
  return wallClockMs(event.recurrenceId) === wallClockMs(master.start);
}

/**
 * Change `occurrence` of `master`, which has no override yet, so that the
 * change reaches every attendee who has not declined - in the two steps the
 * calendar store takes for an occurrence of an expanded series
 * (updateOccurrenceInTwoSteps). Stalwart sends a new override only to
 * attendees who have not answered, a change to an existing one to all who
 * have not declined: the occurrence first gets its override as it is,
 * without messages, and the change then goes out as a change of it. This is
 * the series itself standing for its first occurrence, which changed in one
 * write that reached nobody who had answered. The override is written on
 * the series, under the key it keeps, so the second step needs no fresh
 * read.
 */
async function overrideForEveryone(
  occurrence: CalendarEvent,
  master: CalendarEvent,
  updates: Partial<CalendarEvent>,
  actions: Pick<OccurrenceEditActions, 'updateEvent'>,
): Promise<boolean> {
  const steps = buildOverrideInTwoSteps(occurrence, updates);
  if (!steps) return false;
  await actions.updateEvent(master.id, steps.quiet, { sendSchedulingMessages: false });
  await actions.updateEvent(master.id, steps.change, { sendSchedulingMessages: true });
  return true;
}

/** The recurrence id `occurrence` has in `master`, the key of its override there. */
function splitKeyOf(occurrence: CalendarEvent, master: CalendarEvent): string {
  return resolveOverrideKey(occurrence, master.recurrenceOverrides) ?? occurrence.recurrenceId ?? occurrence.start;
}

/**
 * End the series `master` just before `occurrence`. With `sendScheduling`,
 * when the user organizes the series, the attendees are told: Stalwart
 * sends them the shortened series, and their copies end there too (they
 * kept every occurrence before); anyone else ends their own copy quietly.
 * The overrides from `occurrence` on go as well, in the same update: a rule
 * that ends does not end them, and each kept its occurrence - a changed one
 * showed on in the old series, next to the new one (live on 1.0 and
 * 0.16.23). Resolves to what puts the series back, for a rollback - its
 * rules as they were and those overrides - whether the attendees were told,
 * and the overrides, for the new series.
 */
async function truncateSeries(
  master: CalendarEvent,
  occurrence: CalendarEvent,
  actions: Pick<OccurrenceEditActions, 'updateEvent'>,
  scheduling: { sendScheduling?: boolean; userEmails: string[] },
): Promise<{ restore: Partial<CalendarEvent>; announced: boolean; removed: OverrideMap }> {
  const originalRules: RecurrenceRule[] | null = master.recurrenceRules
    ? JSON.parse(JSON.stringify(master.recurrenceRules))
    : null;
  const splitKey = splitKeyOf(occurrence, master);
  const until = untilBefore(splitKey, master);
  const truncatedRules = (master.recurrenceRules || []).map((rule) => ({
    ...rule,
    until,
    count: null,
  }));
  const patch: Record<string, unknown> = { recurrenceRules: truncatedRules };
  const restore: Partial<CalendarEvent> = { recurrenceRules: originalRules };
  const removed: OverrideMap = {};
  const split = wallClockMs(splitKey);
  for (const [key, override] of Object.entries(master.recurrenceOverrides ?? {})) {
    const at = wallClockMs(key);
    if (at === null || split === null || at < split) continue;
    removed[key] = override;
    patch[`recurrenceOverrides/${key}`] = null;
  }
  // Put back as the whole map: a pointer into it fails while the series has
  // no overrides at all, which the truncation may just have left it with.
  if (Object.keys(removed).length > 0) restore.recurrenceOverrides = withoutUpdated(master.recurrenceOverrides!);
  const announced = !!scheduling.sendScheduling && userOrganizes(master, scheduling.userEmails);
  await actions.updateEvent(master.id, patch, { sendSchedulingMessages: announced });
  return { restore, announced, removed };
}

/**
 * The UNTIL that ends `series` just before its occurrence at `splitKey`: a
 * second before it, on the series' own clock - and earlier by as much as the
 * series' zone is behind UTC. 0.16 (0.16.23 checked) takes the UNTIL for
 * the series' wall clock, turns it into UTC and compares that with the
 * wall clock of each occurrence: in New York "until 09:59:59" kept the
 * 10:00 occurrence it was to end before, "until 04:59:59" ends before it.
 * 1.0 reads the UNTIL on the series' clock, and ends it there either way as
 * long as its occurrences are further apart than that - hours, for a daily
 * or weekly series never. The offset is the larger of the split's day and
 * the day before, for a change of daylight saving time between them.
 */
function untilBefore(splitKey: string, series: CalendarEvent): string {
  let back = 1000;
  const zone = !series.showWithoutTime && series.timeZone && isValidTimeZone(series.timeZone) ? series.timeZone : null;
  if (zone) {
    const instant = localDateTimeToInstant(splitKey.slice(0, 19), zone);
    if (instant) {
      const offsets = [instant, new Date(instant.getTime() - 86_400_000)].map((at) => getTimeZoneOffsetMs(at, zone));
      back += Math.max(0, -Math.min(...offsets));
    }
  }
  return shiftLocalDateTime(splitKey, -back);
}

/**
 * The rules of the series "this and the following occurrences" becomes:
 * the old ones, each with what is left of its COUNT - the occurrences
 * before `splitKey` stay with the old series. Copied as they were, the new
 * series ran the whole count again from the split. An UNTIL stays.
 */
function remainingRules(
  rules: CalendarEvent['recurrenceRules'],
  seriesStart: string,
  splitKey: string,
): CalendarEvent['recurrenceRules'] {
  if (!rules) return rules;
  return rules.map((rule) => (rule.count
    ? { ...rule, count: Math.max(1, rule.count - occurrencesBefore(seriesStart, rule, splitKey)) }
    : rule));
}

/**
 * The overrides of the new series "this and the following occurrences"
 * becomes: those the old series had from the split on (truncateSeries),
 * each with its occurrence (overrideKeyIn). They keep what the organizer
 * changed - an exclusion, a title, a time of their own - but take the new
 * series' participants (withParticipantsOf): it asks every attendee again,
 * for each occurrence, and an attendee's answer to one occurrence of the old
 * series (Stalwart keeps it as an override holding that attendee) would
 * leave the others out of it. They take what the user changed in the editor
 * as `series`, the old series, took it (withSeriesChanges). The occurrence
 * the editor was opened on is the new series' first: moved on its own, it
 * stays off the new series' rhythm by as much as before, plus the editor's
 * move.
 */
function followingOverrides(
  overrides: OverrideMap | undefined,
  splitKey: string,
  from: SeriesFrame,
  to: SeriesFrame & { participants?: CalendarEvent['participants']; duration?: string },
  series: CalendarEvent,
  changes: Partial<CalendarEvent>,
  newSeries: Partial<CalendarEvent>,
): OverrideMap | undefined {
  if (!overrides || Object.keys(overrides).length === 0 || !to.recurrenceRules?.length) return undefined;
  const turned = from.showWithoutTime !== to.showWithoutTime;
  const resized = parseDurationSeconds(to.duration) !== parseDurationSeconds(series.duration);
  const result: OverrideMap = {};
  for (const { key, target, override } of rekeyed(overrides, (key) => overrideKeyIn(key, from, to, splitKey))) {
    const opened = key === splitKey;
    // The new series starts at a SEQUENCE of its own; 0.16 lists an
    // occurrence whose override holds another number twice - the old
    // series' number came along, and the new series showed that occurrence
    // as changed and as the series has it (live on 0.16.23).
    const { updated: _updated, sequence: _sequence, ...rest } = override as OverrideEntry;
    let entry = withParticipantsOf(rest, to.participants);
    if (!entry.excluded) {
      if (turned) {
        for (const timing of WHEN_KEYS) delete entry[timing];
      } else if (typeof entry.start === 'string') {
        if (wallClockMs(entry.start) === wallClockMs(key)) {
          entry.start = target;
        } else if (opened) {
          entry.start = movedLike(entry.start, splitKey, to.start);
        } else if (entry.timeZone === undefined && (from.timeZone ?? null) !== (to.timeZone ?? null)) {
          // A time of its own, on the old series' clock.
          entry.timeZone = from.timeZone ?? null;
        }
      }
      if (!turned && resized && typeof entry.duration === 'string'
        && (opened || parseDurationSeconds(entry.duration) === parseDurationSeconds(series.duration))) {
        entry.duration = to.duration;
      }
      entry = withSeriesChanges(entry, changes, series, opened);
      if (seriesOccursAt(to.start, to.recurrenceRules, target) && changesNothing(entry, target, newSeries)) continue;
    }
    result[target] = entry as OverrideMap[string];
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** What of the old series a new one made from it keeps: its details, where and when, and its reminders. */
const FOLLOWING_SERIES_KEYS = [
  'title', 'description', 'descriptionContentType', 'locations', 'virtualLocations', 'links', 'keywords',
  'categories', 'color', 'locale', 'status', 'freeBusyStatus', 'privacy', 'calendarIds', 'useDefaultAlerts',
  'duration', 'timeZone', 'showWithoutTime',
] as const;

/**
 * The new series "this and the following occurrences" becomes: the old
 * series with what the user changed in the editor, from `occurrence` on,
 * with what is left of its COUNT and the overrides it takes over
 * (`overrides`, from truncateSeries). It is a new event with a UID of its
 * own, so every attendee is asked (participantsAskedAgain): Stalwart invites
 * to a new event only attendees who have not answered, and with the answers
 * the old series had, those who had answered never got the new one.
 *
 * It goes on where the old series would have: from the split occurrence's
 * recurrence id, on the old series' clock and in its zone, moved only as far
 * as the editor moved the occurrence (seriesWhen). It started at the
 * occurrence's own time, in the calendar's zone: a Monday meeting in New York
 * whose one occurrence had moved to Tuesday became a Tuesday series in
 * Berlin from there on. What the editor showed of that occurrence alone -
 * its own time, a title of its own - stays with it (followingOverrides).
 * Without the editor's state the updates are the new series as they are.
 */
export function followingSeriesData(
  occurrence: CalendarEvent,
  master: CalendarEvent,
  updates: Partial<CalendarEvent>,
  originalRules: CalendarEvent['recurrenceRules'],
  options: { editor?: SeriesEdit; overrides?: OverrideMap } = {},
): Partial<CalendarEvent> {
  const { editor } = options;
  const splitKey = splitKeyOf(occurrence, master);
  // A rule the user changed in the editor is the new series' own, its COUNT
  // included; one the user left alone continues the old series.
  const ruleChanged = editor
    ? !!editor.ruleChanged
    : updates.recurrenceRules !== undefined && !recurrenceRulesEqual(updates.recurrenceRules, originalRules);
  const changes = editor ? changedEditorFields(occurrence, updates, editor) : updates;
  const { recurrenceRules: editorRules, ...changed } = changes;

  const data: Partial<CalendarEvent> = {};
  const source = master as unknown as Record<string, unknown>;
  for (const key of FOLLOWING_SERIES_KEYS) {
    if (source[key] !== undefined) (data as Record<string, unknown>)[key] = source[key];
  }
  data.calendarIds = { ...master.calendarIds };
  // While the calendar's default reminders are on, 1.0 lists them as the
  // series' own: they come with the switch, not as copies.
  if (!master.useDefaultAlerts && master.alerts) data.alerts = master.alerts;
  Object.assign(data, changed);
  data.recurrenceRules = ruleChanged && editorRules !== undefined ? editorRules : remainingRules(originalRules, master.start, splitKey);
  if (editor) {
    Object.assign(data, seriesWhen(occurrence, { ...master, start: splitKey }, updates, editor.when));
    data.start ??= splitKey;
    for (const key of ['participants', 'organizerCalendarAddress'] as const) {
      if (updates[key] !== undefined) (data as Record<string, unknown>)[key] = updates[key];
    }
  } else {
    data.start = updates.start || occurrence.recurrenceId || occurrence.start;
  }
  const raw = data as Record<string, unknown>;
  delete raw.id;
  delete raw.uid;
  delete raw.recurrenceId;
  delete raw.recurrenceOverrides;
  if (data.participants) {
    // The series' organizer, by the exact address it is organized under:
    // the editor writes one only for an event that had none. Created
    // without it, 0.16.23 made the user who created the rest the organizer
    // (a sharee changing the owner's meeting, a series organized under an
    // alias), whatever the owner participant says; 1.0 takes the owner
    // participant (live).
    data.organizerCalendarAddress ??= master.organizerCalendarAddress;
    data.participants = participantsAskedAgain({
      participants: data.participants,
      organizerCalendarAddress: data.organizerCalendarAddress,
    }) ?? data.participants;
  }
  const overrides = followingOverrides(
    options.overrides, splitKey,
    { start: master.start, timeZone: master.timeZone, showWithoutTime: !!master.showWithoutTime, recurrenceRules: originalRules },
    {
      start: data.start!, timeZone: data.timeZone, showWithoutTime: !!data.showWithoutTime,
      recurrenceRules: data.recurrenceRules ?? null, participants: data.participants ?? undefined, duration: data.duration,
    },
    master, editor ? changed : {}, data,
  );
  if (overrides) data.recurrenceOverrides = overrides;
  return data;
}

/**
 * Save the editor's change to one occurrence for `scope`. Resolves to false
 * when the series the occurrence belongs to cannot be found.
 */
export async function saveOccurrenceEdit(
  scope: RecurrenceEditScope,
  edit: OccurrenceEdit,
  actions: OccurrenceEditActions,
): Promise<boolean> {
  const { updateEvent, createEvent } = actions;
  const { event, updates, sendScheduling } = edit;
  const scheduling = { sendSchedulingMessages: sendScheduling };
  if (scope === 'this') {
    if (isServerRecurrenceInstance(event) || isBrowserExpandedOccurrence(event)) {
      // The store keeps the change on this occurrence: through its own
      // (synthetic) id, or as a recurrence override on the event it was
      // expanded from.
      await updateEvent(event.id, updates, scheduling);
      return true;
    }
    // The series itself standing for its first occurrence: override that
    // occurrence on the series, never write it to the series itself.
    const master = await seriesOf(event, actions);
    if (master) {
      const occurrence = asOccurrenceOf(event, master);
      const participants = updates.participants === undefined ? occurrence.participants : updates.participants;
      if (sendScheduling && createsOverride(occurrence) && userOrganizes({ ...occurrence, participants }, edit.userEmails)
        && hasAnsweredAttendees(participants)) {
        return overrideForEveryone(occurrence, master, updates, actions);
      }
      const overridePatch = buildFallbackOverridePatch(occurrence, withNewOverrideDetails(occurrence, updates, { seriesKeys: true }));
      if (!overridePatch) return false;
      await updateEvent(master.id, overridePatch, scheduling);
      return true;
    }
    // An occurrence the server keeps as an event of its own (an invitation
    // to that occurrence alone) is itself what changes; a series that
    // cannot be found is not.
    if (isSeries(event)) return false;
    await updateEvent(event.id, updates, scheduling);
    return true;
  }
  if (isLoneOccurrence(event)) {
    await updateEvent(event.id, updates, scheduling);
    return true;
  }
  const master = await seriesOf(event, actions);
  if (!master) return false;
  // From the first occurrence on is the whole series; ended before its first
  // occurrence, the series would be left with none.
  if (scope === 'this_and_future' && isFirstOccurrence(event, master)) return saveOccurrenceEdit('all', edit, actions);
  if (scope === 'this_and_future') {
    const { restore, announced, removed } = await truncateSeries(master, event, actions, {
      sendScheduling, userEmails: edit.userEmails,
    });
    const newEventData = followingSeriesData(event, master, updates, restore.recurrenceRules ?? null, {
      editor: edit.editor,
      overrides: removed,
    });
    // The calendar is the one the editor saves to; the store routes it.
    delete newEventData.calendarIds;
    const calendarId = edit.calendarId || getPrimaryCalendarId(master) || '';
    try {
      const created = await createEvent(newEventData, calendarId, scheduling);
      if (!created) throw new Error('Failed to create the rest of the series');
    } catch (createError) {
      // Put the series back as it was, telling whoever the truncation told.
      try {
        await updateEvent(master.id, restore, { sendSchedulingMessages: announced });
      } catch {
        // The rollback failing is reported through the original error.
      }
      throw createError;
    }
    return true;
  }
  let seriesUpdates: Partial<CalendarEvent>;
  if (edit.editor) {
    seriesUpdates = seriesUpdatesFromOccurrence(event, master, updates, edit.editor, {
      userEmail: edit.userEmails[0],
      userEmails: edit.userEmails,
      resolveName: edit.resolveName,
    });
  } else {
    seriesUpdates = { ...updates };
    delete seriesUpdates.recurrenceId;
  }
  const write = raisesSequences(seriesUpdates, master, edit) ? withRaisedSequences(seriesUpdates, master) : seriesUpdates;
  await updateEvent(master.id, write, scheduling);
  return true;
}

/** What deleting part of a series works with: the calendar store's actions. */
export interface OccurrenceDeleteActions extends Pick<OccurrenceEditActions, 'updateEvent' | 'getMasterEvent'> {
  deleteEvent: (id: string) => Promise<void>;
}

/**
 * Delete the part of a series `scope` names, from `event`, the occurrence
 * the user picked it on. Resolves to false when the series cannot be found.
 * The store tells the attendees of what it destroys itself; ending a series
 * tells them when the user organizes it.
 */
export async function deleteOccurrence(
  scope: RecurrenceEditScope,
  deletion: { event: CalendarEvent; userEmails: string[] },
  actions: OccurrenceDeleteActions,
): Promise<boolean> {
  const { event } = deletion;
  if (scope === 'this') {
    if (isServerRecurrenceInstance(event) || isBrowserExpandedOccurrence(event)) {
      // The store destroys a server occurrence, or excludes one the device
      // expanded on its base event.
      await actions.deleteEvent(event.id);
      return true;
    }
    // The series itself standing for its first occurrence: exclude that
    // occurrence on the series, never delete the series. The store tells
    // the attendees as it does for its own deletes.
    const master = await seriesOf(event, actions);
    if (master) {
      const excludePatch = buildFallbackExcludePatch(asOccurrenceOf(event, master));
      if (!excludePatch) return false;
      await actions.updateEvent(master.id, excludePatch);
      return true;
    }
    if (isSeries(event)) return false;
    await actions.deleteEvent(event.id);
    return true;
  }
  if (isLoneOccurrence(event)) {
    await actions.deleteEvent(event.id);
    return true;
  }
  const master = await seriesOf(event, actions);
  if (!master) return false;
  if (scope === 'this_and_future' && !isFirstOccurrence(event, master)) {
    await truncateSeries(master, event, actions, { sendScheduling: true, userEmails: deletion.userEmails });
    return true;
  }
  await actions.deleteEvent(master.id);
  return true;
}
