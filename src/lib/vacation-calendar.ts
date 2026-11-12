/**
 * Out-of-office blocks the calendar. Ported from the webmail's
 * lib/vacation-calendar.ts (the decision rules are the same, so both
 * clients keep one event between them).
 *
 * While an out-of-office reply with a start and an end is on, the app keeps
 * one busy event for it in the account's default calendar. The event is
 * found again by a fixed UID per account (`bulwark-ooo-<accountId>`). It is
 * timed, or all-day when both ends are midnight in the user's time zone;
 * busy, public, without participants, and never sends invitations.
 *
 * The event is the app's while its times are the ones the app last wrote
 * (kept per login and account) or the reply's dates before the change at
 * hand; it also carries the keyword OOO_KEYWORD, so on a device with no
 * record a marked event found when the reply is loaded counts as the app's.
 * When none of these hold, someone edited it, and it is left alone.
 * Switching the reply or the block off removes an event that hasn't started
 * and ends one that has at once; a reply that simply ran out leaves its past
 * event in place.
 */
import { jmapClient } from '../api/jmap-client';
import { createEvent, deleteEvents, getCalendars, updateEvent } from '../api/calendar';
import type { Calendar, CalendarEvent } from '../api/types';
import { getEffectiveTimeZone, getWallClock, localDateTimeToInstant } from './calendar-timezone';
import { parseDurationSeconds } from './recurrence-instances';
import { servedLoginOf } from './draft-login';
import { usePolicyStore } from '../stores/policy-store';
import { useVacationCalendarStore, type WrittenBlock } from '../stores/vacation-calendar-store';

export const OOO_UID_PREFIX = 'bulwark-ooo-';
export const SYNC_DEBOUNCE_MS = 1500;
/** The keyword (iCalendar CATEGORIES) on the busy event. */
export const OOO_KEYWORD = 'bulwark-out-of-office';
/**
 * The event title when the reply has no subject. In English: the event is
 * seen by colleagues in any language, and a server-side copy can't follow
 * the reader's locale.
 */
export const OUT_OF_OFFICE_TITLE = 'Out of office';

export function oooUid(accountId: string): string {
  return `${OOO_UID_PREFIX}${accountId}`;
}

/** What the vacation response says, as far as the block cares. */
export interface ReplyState {
  isEnabled: boolean;
  fromDate: string | null;
  toDate: string | null;
  subject: string;
}

export type BlockDecision =
  | { action: 'none' }
  | { action: 'create'; start: Date; end: Date }
  | { action: 'update'; start: Date; end: Date }
  | { action: 'destroy' }
  | { action: 'end-now'; end: Date };

export interface DecisionInput {
  block: boolean;
  reply: ReplyState;
  /** The event with our UID, as instants; null when there is none. */
  event: { start: Date; end: Date } | null;
  last: WrittenBlock | null;
  /** The reply's dates before the change being synced; null when unknown (a load). */
  previous?: Pick<ReplyState, 'fromDate' | 'toDate'> | null;
  /** The event carries OOO_KEYWORD. */
  marked?: boolean;
  now: Date;
  /** `save`: the reply or the block just changed here. `load`: the reply was read. */
  trigger: 'save' | 'load';
}

const same = (a: Date, b: string | Date) => a.getTime() === (typeof b === 'string' ? Date.parse(b) : b.getTime());

/** What to do with the busy event, by the rules in the module comment. */
export function decideBlock(input: DecisionInput): BlockDecision {
  const { reply, event, last, now } = input;
  const from = reply.fromDate ? new Date(reply.fromDate) : null;
  const to = reply.toDate ? new Date(reply.toDate) : null;
  const datesUsable = !!from && !!to && !Number.isNaN(from.getTime()) && !Number.isNaN(to.getTime()) && to > from;
  const wanted = input.block && reply.isEnabled && datesUsable;
  const ranOut = reply.isEnabled && !!to && to <= now;

  if (event) {
    const matchesLast = !!last && same(event.start, last.start) && same(event.end, last.end);
    const matchesPrevious = !!input.previous?.fromDate && !!input.previous.toDate
      && same(event.start, input.previous.fromDate) && same(event.end, input.previous.toDate);
    const markedOnLoad = !last && !!input.marked && input.trigger === 'load';
    // Set up or changed by someone else: left alone.
    if (!matchesLast && !matchesPrevious && !markedOnLoad) return { action: 'none' };
    if (wanted) {
      if (ranOut) return { action: 'none' };
      if (same(event.start, from!) && same(event.end, to!)) return { action: 'none' };
      return { action: 'update', start: from!, end: to! };
    }
    // A reply that ran out leaves its past event; so does any past event.
    if (ranOut || event.end <= now) return { action: 'none' };
    if (event.start > now) return { action: 'destroy' };
    return { action: 'end-now', end: now };
  }

  if (!wanted || ranOut) return { action: 'none' };
  // It was there for these dates and someone deleted it: that sticks.
  if (input.trigger === 'load' && last && same(from!, last.start) && same(to!, last.end)) return { action: 'none' };
  return { action: 'create', start: from!, end: to! };
}

/** ISO 8601 duration of a span, in days, hours and minutes. */
export function isoDuration(ms: number): string {
  const totalMinutes = Math.max(0, Math.round(ms / 60000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const time = `${hours ? `${hours}H` : ''}${minutes ? `${minutes}M` : ''}`;
  if (!days && !time) return 'PT0S';
  return `P${days ? `${days}D` : ''}${time ? `T${time}` : ''}`;
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * The event's time fields for a span: all-day when both ends are midnight in
 * `timeZone`, timed in the zone otherwise.
 */
export function blockTimes(
  start: Date, end: Date, timeZone: string,
): Pick<CalendarEvent, 'start' | 'duration' | 'showWithoutTime'> & { timeZone: string | null } {
  const a = getWallClock(start, timeZone);
  const b = getWallClock(end, timeZone);
  const midnight = (w: typeof a) => w.hour === 0 && w.minute === 0 && w.second === 0;
  if (midnight(a) && midnight(b)) {
    const days = Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86400000);
    return { start: `${a.year}-${pad(a.month)}-${pad(a.day)}T00:00:00`, duration: `P${days}D`, timeZone: null, showWithoutTime: true };
  }
  return {
    start: `${a.year}-${pad(a.month)}-${pad(a.day)}T${pad(a.hour)}:${pad(a.minute)}:${pad(a.second)}`,
    duration: isoDuration(end.getTime() - start.getTime()),
    timeZone,
    showWithoutTime: false,
  };
}

/** The instants an event covers, read the way blockTimes writes them. */
export function eventSpan(
  event: { start?: string; duration?: string | null; timeZone?: string | null; showWithoutTime?: boolean },
  timeZone: string,
): { start: Date; end: Date } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(event.start ?? '');
  if (!m) return null;
  const zone = event.showWithoutTime ? timeZone : event.timeZone || timeZone;
  const seconds = parseDurationSeconds(event.duration ?? 'PT0S') ?? 0;
  if (event.showWithoutTime) {
    const start = localDateTimeToInstant(`${m[1]}-${m[2]}-${m[3]}T00:00:00`, zone);
    // Whole days in the zone, across a DST change too.
    const endDay = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + Math.round(seconds / 86400)));
    const end = localDateTimeToInstant(
      `${endDay.getUTCFullYear()}-${pad(endDay.getUTCMonth() + 1)}-${pad(endDay.getUTCDate())}T00:00:00`, zone,
    );
    return start && end ? { start, end } : null;
  }
  const start = localDateTimeToInstant(event.start!, zone);
  return start ? { start, end: new Date(start.getTime() + seconds * 1000) } : null;
}

/** The calendar of the account a block goes into: its default, if the user may add events there. */
export function blockCalendar(calendars: Calendar[], accountId: string, primaryAccountId: string): Calendar | null {
  const own = calendars.filter((c) => (accountId === primaryAccountId ? !c.isShared : c.accountId === accountId));
  const calendar = own.find((c) => c.isDefault) ?? own[0] ?? null;
  if (!calendar) return null;
  const rights = calendar.myRights;
  return !rights || rights.mayWriteAll || rights.mayWriteOwn ? calendar : null;
}

/**
 * The block setting as it applies: locked, the organisation's value (the
 * lock's value, else the policy default, else on); hidden, the policy default
 * (else on), the user can't see the choice; otherwise the user's choice.
 */
export function resolveBlockSetting(
  restriction: { locked?: boolean; hidden?: boolean; value?: unknown } | undefined,
  policyDefault: unknown,
  userSetting: unknown,
): { value: boolean; locked: boolean; hidden: boolean } {
  const orgValue = (v: unknown) => (typeof v === 'boolean' ? v : typeof policyDefault === 'boolean' ? policyDefault : true);
  if (restriction?.locked === true) return { value: orgValue('value' in restriction ? restriction.value : undefined), locked: true, hidden: false };
  if (restriction?.hidden === true) return { value: orgValue(undefined), locked: false, hidden: true };
  return { value: userSetting !== false, locked: false, hidden: false };
}

/** The organisation's rule for the block, by the webmail's key. */
export function blockPolicy(): { restriction: { locked?: boolean; hidden?: boolean; value?: unknown } | undefined; policyDefault: unknown } {
  const effective = usePolicyStore.getState().effective;
  return {
    restriction: effective?.restrictions?.vacationBlockCalendar as { locked?: boolean; hidden?: boolean; value?: unknown } | undefined,
    policyDefault: effective?.defaults?.vacationBlockCalendar,
  };
}

export function effectiveBlockSetting(): boolean {
  const { restriction, policyDefault } = blockPolicy();
  return resolveBlockSetting(restriction, policyDefault, useVacationCalendarStore.getState().block).value;
}

function recordKey(accountId: string): string {
  return `${servedLoginOf(jmapClient) ?? ''}|${accountId}`;
}

const BLOCK_EVENT_PROPERTIES = ['id', 'uid', 'start', 'duration', 'timeZone', 'showWithoutTime', 'keywords'];

/** The event with our UID in `accountId`, with what the decision reads. */
async function findBlockEvent(accountId: string): Promise<(Partial<CalendarEvent> & { id: string; keywords?: Record<string, boolean> }) | null> {
  const using = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:calendars'];
  const res = await jmapClient.request([
    ['CalendarEvent/query', { accountId, filter: { uid: oooUid(accountId) }, limit: 1 }, '0'],
    ['CalendarEvent/get', {
      accountId, '#ids': { resultOf: '0', name: 'CalendarEvent/query', path: '/ids' }, properties: BLOCK_EVENT_PROPERTIES,
    }, '1'],
  ], using);
  const [queryName, query] = res.methodResponses[0] ?? [];
  if (queryName !== 'CalendarEvent/query') throw new Error(String((query as Record<string, unknown>)?.description ?? 'CalendarEvent/query failed'));
  const [getName, got] = res.methodResponses[1] ?? [];
  if (getName !== 'CalendarEvent/get') throw new Error(String((got as Record<string, unknown>)?.description ?? 'CalendarEvent/get failed'));
  const list = ((got as { list?: Array<Partial<CalendarEvent> & { id: string }> }).list) ?? [];
  return list[0] ?? null;
}

/** The end as eventSpan will read it back after blockTimes wrote it. */
function blockEnd(start: Date, end: Date, zone: string): Date {
  return eventSpan(blockTimes(start, end, zone), zone)?.end ?? end;
}

/**
 * Bring the busy event of one account in line with the reply. Returns what
 * it did; never throws (a failure is logged and tried again next time).
 */
export async function syncVacationBlock(
  accountId: string | undefined,
  reply: ReplyState,
  trigger: 'save' | 'load',
  now = new Date(),
  previous: Pick<ReplyState, 'fromDate' | 'toDate'> | null = null,
): Promise<BlockDecision['action'] | 'no-calendar' | 'failed' | 'unsupported'> {
  if (!jmapClient.hasCapability('urn:ietf:params:jmap:calendars')) return 'unsupported';
  const primary = jmapClient.accountId;
  const account = accountId ?? primary;
  const target = account === primary ? undefined : account;
  const zone = getEffectiveTimeZone();
  const key = recordKey(account);
  const store = useVacationCalendarStore.getState();
  try {
    const found = await findBlockEvent(account);
    const span = found ? eventSpan(found, zone) : null;
    const last = store.written[key] ?? null;
    const marked = !!found?.keywords?.[OOO_KEYWORD];
    const block = effectiveBlockSetting();
    const decision = decideBlock({ block, reply, event: span, last, previous, marked, now, trigger });
    const title = reply.subject.trim() || OUT_OF_OFFICE_TITLE;
    switch (decision.action) {
      case 'none':
        // A record of an event that is gone and not wanted any more is dropped.
        if (!found && last && !(reply.isEnabled && block)) store.remember(key, null);
        return 'none';
      case 'create': {
        const calendar = blockCalendar(await getCalendars(), account, primary);
        if (!calendar) return 'no-calendar';
        await createEvent({
          '@type': 'Event',
          uid: oooUid(account),
          title,
          ...blockTimes(decision.start, decision.end, zone),
          freeBusyStatus: 'busy',
          privacy: 'public',
          status: 'confirmed',
          keywords: { [OOO_KEYWORD]: true },
        } as Partial<CalendarEvent>, calendar.originalId ?? calendar.id, false, target);
        store.remember(key, { start: decision.start.toISOString(), end: decision.end.toISOString() });
        return 'create';
      }
      case 'update':
        await updateEvent(found!.id, {
          ...blockTimes(decision.start, decision.end, zone),
          title,
          [`keywords/${OOO_KEYWORD}`]: true,
        }, false, target);
        store.remember(key, { start: decision.start.toISOString(), end: decision.end.toISOString() });
        return 'update';
      case 'end-now': {
        const start = span!.start;
        // Whole minutes: Stalwart stores the duration in them.
        const end = new Date(Math.max(start.getTime() + 60000, Math.ceil(decision.end.getTime() / 60000) * 60000));
        await updateEvent(found!.id, blockTimes(start, end, zone), false, target);
        store.remember(key, { start: start.toISOString(), end: blockEnd(start, end, zone).toISOString() });
        return 'end-now';
      }
      case 'destroy':
        await deleteEvents([found!.id], false, target);
        store.remember(key, null);
        return 'destroy';
    }
  } catch (error) {
    console.warn('[vacation] Out-of-office calendar block failed:', error);
    return 'failed';
  }
}

function relevant(reply: ReplyState): string {
  return JSON.stringify([reply.isEnabled, reply.fromDate, reply.toDate, reply.subject]);
}

interface Pending {
  accountId: string | undefined;
  reply: ReplyState;
  previous: Pick<ReplyState, 'fromDate' | 'toDate'> | null;
  trigger: 'save' | 'load';
}

// Per account: one job waiting, one timer, one sync running.
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const pending = new Map<string, Pending>();
const running = new Map<string, Promise<unknown>>();
const loaded = new Set<string>();

function run(key: string): void {
  timers.delete(key);
  const job = pending.get(key);
  if (running.has(key) || !job) return;
  pending.delete(key);
  running.set(key, syncVacationBlock(job.accountId, job.reply, job.trigger, new Date(), job.previous)
    .catch(() => undefined)
    .finally(() => {
      running.delete(key);
      if (pending.has(key) && !timers.has(key)) run(key);
    }));
}

function schedule(job: Pending): void {
  const key = recordKey(job.accountId ?? jmapClient.accountId);
  const waiting = pending.get(key);
  // A save outranks a load that waits; the latest reply wins, with the
  // dates from before the first change it replaces.
  if (waiting?.trigger === 'save' && job.trigger === 'load') return;
  pending.set(key, waiting?.trigger === 'save' ? { ...job, previous: waiting.previous } : job);
  const timer = timers.get(key);
  if (timer) clearTimeout(timer);
  timers.set(key, setTimeout(() => run(key), SYNC_DEBOUNCE_MS));
}

/** Scheduling the calendar sync must never break saving or loading the reply. */
function safely(fn: () => void): void {
  try {
    fn();
  } catch (error) {
    console.warn('[vacation] Out-of-office calendar sync not scheduled:', error);
  }
}

/** After a saved reply: sync when the switch, the dates or the subject changed. */
export function vacationReplySaved(accountId: string | undefined, before: ReplyState, after: ReplyState): void {
  if (relevant(before) === relevant(after)) return;
  safely(() => schedule({ accountId, reply: after, previous: { fromDate: before.fromDate, toDate: before.toDate }, trigger: 'save' }));
}

/** The user changed the block setting: sync with the reply as it is. */
export function vacationBlockChanged(accountId: string | undefined, reply: ReplyState): void {
  safely(() => schedule({ accountId, reply, previous: { fromDate: reply.fromDate, toDate: reply.toDate }, trigger: 'save' }));
}

/** After the reply was loaded: once per app run, login and account. */
export function vacationReplyLoaded(accountId: string | undefined, reply: ReplyState): void {
  safely(() => {
    const key = recordKey(accountId ?? jmapClient.accountId);
    if (loaded.has(key)) return;
    loaded.add(key);
    schedule({ accountId, reply, previous: null, trigger: 'load' });
  });
}

/** For tests: drop what the scheduler holds. */
export function resetVacationCalendarSync(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  pending.clear();
  running.clear();
  loaded.clear();
}
