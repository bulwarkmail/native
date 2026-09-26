// Board 3, "Invites, tasks and free time": things you act on from the home
// screen - the invitation banner with its RSVP buttons, the working week as
// busy bars, the task list with working tick boxes, task progress, a
// countdown to the next all-day event and upcoming birthdays.

import React from 'react';
import { FlexWidget, OverlapWidget, SvgWidget } from 'react-native-android-widget';
import { action, links, open } from '../clicks';
import {
  busyBlocks,
  countdownTarget,
  daysUntil,
  eventsOnDay,
  freeTime,
  sortTasks,
  startOfWeek,
  tasksDueNow,
  upcomingBirthdays,
  type BusyBlock,
} from '../derive';
import { addDays, sameDay, startOfDay, type Fmt } from '../format';
import { ring, type IconName } from '../icons';
import { TASK_ROW_HEIGHT, TaskRow } from '../parts';
import {
  Avatar,
  Button,
  Dot,
  Fab,
  Header,
  Icon,
  Placeholder,
  Spacer,
  Surface,
  Txt,
} from '../primitives';
import type { EventItem, TaskItem } from '../snapshot';
import { normalizeHex, type WidgetPalette } from '../theme';
import type { Layout } from './types';

const MINUTE = 60000;
const HOUR = 3600000;
/** Working hours the free-time bars cover. */
const WORK_START = 8;
const WORK_END = 18;
/** The Birthdays calendar colour the app gives the calendar it builds from contacts. */
const BIRTHDAY_COLOR = '#eab308';

function untitled(f: Fmt, title: string): string {
  return title || f.t('widgets.calendar.untitled', '(no title)');
}

/** "Thu, Oct 1 · 14:00 – 16:00", "Sun, Oct 4 · All day", or a range across days. */
function eventWhen(f: Fmt, e: EventItem): string {
  const allDay = f.t('widgets.calendar.all_day', 'All day');
  // An end at midnight (all-day events, or a timed one ending at 24:00) belongs to the day before.
  const last = Math.max(e.start, e.end - 1);
  if (e.allDay) {
    return sameDay(e.start, last)
      ? `${f.weekdayDayMonth(e.start)} · ${allDay}`
      : `${f.weekdayDayMonth(e.start)} – ${f.weekdayDayMonth(last)} · ${allDay}`;
  }
  if (sameDay(e.start, last)) return `${f.weekdayDayMonth(e.start)} · ${f.time(e.start)} – ${f.time(e.end)}`;
  return `${f.weekdayDayMonth(e.start)} ${f.time(e.start)} – ${f.weekdayDayMonth(e.end)} ${f.time(e.end)}`;
}

/** Muted icon + text line (`flex items-center gap-1.5 text-[13px] text-muted-foreground`). */
function MetaLine({ p, iconName, text }: { p: WidgetPalette; iconName: IconName; text: string }) {
  return (
    <FlexWidget style={{ flexDirection: 'row', alignItems: 'center', width: 'match_parent', marginTop: 1 }}>
      <Icon name={iconName} color={p.muted} size={14} />
      <Spacer size={6} horizontal />
      <FlexWidget style={{ flex: 1 }}>
        <Txt text={text} color={p.muted} size={13} />
      </FlexWidget>
    </FlexWidget>
  );
}

// ── Invitations ─────────────────────────────────────────────────────────────

export const InvitationsLayout: Layout = ({ s, p, f, height }) => {
  const invitations = s.calendar.invitations;
  const inv = invitations[0];
  if (!inv) {
    return (
      <Surface p={p}>
        <Placeholder
          p={p}
          iconName="calendar"
          title={f.t('widgets.invites.empty', 'No invitations waiting')}
          click={open(links.calendar())}
        />
      </Surface>
    );
  }
  // Natural height is ~139dp at 14dp padding; give up padding, then the people line, then button height.
  const pad = height < 140 ? 10 : 14;
  const showPeople = inv.participants.length > 0 && height >= 132;
  const buttonHeight = height < 116 ? 28 : 32;

  const label = (
    inv.organizerName
      ? f.t('widgets.invites.label', 'Invitation · {name}', { name: inv.organizerName })
      : f.t('widgets.invites.label_plain', 'Invitation')
  ).toUpperCase();
  const names = inv.participants.slice(0, 3).map((x) => x.name);
  const extra = inv.participants.length - names.length;
  const people = `${names.join(', ')}${extra > 0 ? ` +${extra}` : ''}`;
  const reply = (status: 'accepted' | 'tentative' | 'declined') => action('rsvp', { id: inv.id, status });

  return (
    <Surface p={p} style={{ padding: pad }}>
      <FlexWidget {...open(links.event(inv))} style={{ flexDirection: 'row', width: 'match_parent' }}>
        <FlexWidget
          style={{
            width: 40,
            height: 40,
            borderRadius: 20,
            backgroundColor: p.infoBg,
            justifyContent: 'center',
            alignItems: 'center',
          }}
        >
          <Icon name="calendar" color={p.info} size={20} />
        </FlexWidget>
        <Spacer size={12} horizontal />
        <FlexWidget style={{ flex: 1 }}>
          <FlexWidget style={{ flexDirection: 'row', alignItems: 'center', width: 'match_parent' }}>
            <FlexWidget style={{ flex: 1 }}>
              <Txt text={label} color={p.muted} size={10} weight="600" style={{ letterSpacing: 0.05 }} />
            </FlexWidget>
            {invitations.length > 1 ? <Spacer size={6} horizontal /> : null}
            {invitations.length > 1 ? (
              <Txt
                text={f.t('widgets.invites.position', '{index} of {count}', { index: 1, count: invitations.length })}
                color={p.muted}
                size={11}
              />
            ) : null}
          </FlexWidget>
          <Txt text={untitled(f, inv.title)} color={p.fg} size={15} weight="600" />
          <MetaLine p={p} iconName="clock" text={eventWhen(f, inv)} />
          {showPeople ? <MetaLine p={p} iconName="users" text={people} /> : null}
        </FlexWidget>
      </FlexWidget>
      <Spacer size={8} />
      <Spacer />
      <FlexWidget style={{ flexDirection: 'row', width: 'match_parent' }}>
        <Button
          p={p}
          variant="primary"
          label={f.t('widgets.invites.accept', 'Accept')}
          flex={1}
          height={buttonHeight}
          click={reply('accepted')}
        />
        <Spacer size={6} horizontal />
        <Button p={p} label={f.t('widgets.invites.maybe', 'Maybe')} flex={1} height={buttonHeight} click={reply('tentative')} />
        <Spacer size={6} horizontal />
        <Button p={p} label={f.t('widgets.invites.decline', 'Decline')} flex={1} height={buttonHeight} click={reply('declined')} />
      </FlexWidget>
    </Surface>
  );
};

// ── Free time ───────────────────────────────────────────────────────────────

/** Monday of the week the bars show; on a weekend that is next week's Monday. */
function barsMonday(now: number, weekStart: 0 | 1): number {
  const monday = addDays(startOfWeek(now, weekStart), weekStart === 0 ? 1 : 0);
  // Saturday 00:00 or later: this week's Mon-Fri is over, show the coming one.
  return now >= addDays(monday, 5) ? addDays(monday, 7) : monday;
}

/** End of the busy stretch running at `now` (back-to-back events chained). */
function busyUntil(events: EventItem[], now: number): number {
  const timed = eventsOnDay(events, startOfDay(now)).filter((e) => !e.allDay);
  let end = now;
  let grew = true;
  while (grew) {
    grew = false;
    for (const e of timed) {
      if (e.start <= end && e.end > end) {
        end = e.end;
        grew = true;
      }
    }
  }
  return end;
}

interface BarSegment {
  width: number;
  color?: string;
}

/**
 * Busy blocks as a left-to-right run of spacers and coloured segments in dp,
 * so the bar is a plain LinearLayout. Overlapping events continue in the later
 * event's colour; very short ones keep 2dp so they stay visible.
 */
function barSegments(blocks: BusyBlock[], trackWidth: number): BarSegment[] {
  const out: BarSegment[] = [];
  let cursor = 0;
  for (const b of [...blocks].sort((x, y) => x.from - y.from)) {
    const x0 = Math.max(cursor, Math.round(b.from * trackWidth));
    let x1 = Math.min(trackWidth, Math.round(b.to * trackWidth));
    if (x1 - x0 < 2) x1 = Math.min(trackWidth, x0 + 2);
    if (x1 <= x0) continue;
    if (x0 > cursor) out.push({ width: x0 - cursor });
    out.push({ width: x1 - x0, color: b.color });
    cursor = x1;
  }
  return out;
}

/** Free stretches of one day inside working hours, from the busy-block gaps ("10:00–12:00"). */
function freeSlots(f: Fmt, events: EventItem[], dayStart: number, now: number): string[] {
  const winStart = dayStart + WORK_START * HOUR;
  const winEnd = dayStart + WORK_END * HOUR;
  const span = winEnd - winStart;
  const quarter = 15 * MINUTE;
  // Fractions back to clock times, snapped to the minute so float error never shows as 09:59.
  const toMs = (frac: number) => Math.round((winStart + frac * span) / MINUTE) * MINUTE;
  const busy = busyBlocks(events, dayStart, WORK_START, WORK_END)
    .map((b) => ({ from: toMs(b.from), to: toMs(b.to) }))
    .sort((a, b) => a.from - b.from);
  const slots: string[] = [];
  const push = (from: number, to: number) => {
    if (to - from >= quarter) slots.push(`${f.time(from)}–${f.time(to)}`);
  };
  // Today starts at the next quarter hour; past days produce nothing.
  let cursor = Math.max(winStart, Math.ceil(now / quarter) * quarter);
  if (cursor >= winEnd) return slots;
  for (const b of busy) {
    if (b.from > cursor) push(cursor, Math.min(b.from, winEnd));
    cursor = Math.max(cursor, b.to);
    if (cursor >= winEnd) return slots;
  }
  push(cursor, winEnd);
  return slots;
}

/** "8:00" / "8 AM" for the axis under the bars. */
function hourLabel(hour: number, hour12: boolean): string {
  if (!hour12) return `${hour}:00`;
  return `${hour % 12 === 0 ? 12 : hour % 12} ${hour < 12 ? 'AM' : 'PM'}`;
}

interface FreeTier {
  /** Vertical padding. */
  pad: number;
  gap: number;
  rowHeight: number;
  axis: boolean;
  /** Button height; 0 hides the button. */
  button: number;
}

const FREE_HEADLINE_HEIGHT = 22;
const FREE_AXIS_HEIGHT = 13;
const FREE_LABEL_WIDTH = 28;
const FREE_LABEL_GAP = 8;
/** Roomiest first; the layout takes the first one that fits the widget height. */
const FREE_TIERS: FreeTier[] = [
  { pad: 10, gap: 6, rowHeight: 13, axis: true, button: 32 },
  { pad: 8, gap: 3, rowHeight: 12, axis: true, button: 30 },
  { pad: 8, gap: 3, rowHeight: 12, axis: false, button: 30 },
  { pad: 8, gap: 3, rowHeight: 11, axis: false, button: 28 },
  { pad: 8, gap: 3, rowHeight: 11, axis: false, button: 0 },
];

function freeTierHeight(t: FreeTier): number {
  return (
    2 +
    t.pad * 2 +
    FREE_HEADLINE_HEIGHT +
    t.gap +
    5 * t.rowHeight +
    (t.axis ? FREE_AXIS_HEIGHT : 0) +
    (t.button ? t.gap + t.button : 0)
  );
}

export const FreeTimeLayout: Layout = ({ s, p, f, now, width, height }) => {
  if (!s.calendar.supported) {
    return (
      <Surface p={p}>
        <Placeholder p={p} iconName="calendar" title={f.t('widgets.free.no_calendar', 'No calendar on this account')} />
      </Surface>
    );
  }
  // A declined invitation is not busy time.
  const events = s.calendar.events.filter((e) => e.myStatus !== 'declined');
  const tier = FREE_TIERS.find((t) => freeTierHeight(t) <= height) ?? FREE_TIERS[FREE_TIERS.length - 1];

  const ft = freeTime(events, now, WORK_START, WORK_END);
  let headline: string;
  let sub: string | null = null;
  if (ft.busyNow) {
    const until = busyUntil(events, now);
    headline = f.t('widgets.free.busy_until', 'Busy until {time}', { time: f.time(until) });
    const after = eventsOnDay(events, startOfDay(now)).find((e) => !e.allDay && e.start >= until);
    sub = after
      ? f.t('widgets.free.then', 'then {title}', { title: untitled(f, after.title) })
      : f.t('widgets.free.then_free', 'then free');
  } else if (ft.next) {
    headline = f.t('widgets.free.free_until', 'Free until {time}', { time: f.time(ft.next.start) });
    sub = f.t('widgets.free.then', 'then {title}', { title: untitled(f, ft.next.title) });
  } else {
    headline = f.t('widgets.free.free_rest', 'Free for the rest of the day');
  }

  const trackWidth = Math.max(40, Math.floor(width - 2 - 2 * 14 - FREE_LABEL_WIDTH - FREE_LABEL_GAP));
  const today = startOfDay(now);
  const monday = barsMonday(now, s.weekStart);
  const days = [0, 1, 2, 3, 4].map((i) => addDays(monday, i));
  const labelSize = tier.rowHeight >= 13 ? 11 : 10;

  const bodyLines = days
    .map((day) => {
      const slots = freeSlots(f, events, day, now);
      return slots.length > 0 ? `${f.weekdayDayMonth(day)}: ${slots.join(', ')}` : null;
    })
    .filter((line): line is string => line !== null);
  const mail = open(
    links.compose({
      subject: f.t('widgets.free.mail_subject', 'My free times this week'),
      body: bodyLines.length > 0 ? bodyLines.join('\n') : undefined,
    }),
  );

  const track = (day: number) => {
    const segments = barSegments(busyBlocks(events, day, WORK_START, WORK_END), trackWidth);
    return (
      <FlexWidget style={{ width: trackWidth, height: tier.rowHeight, justifyContent: 'center' }}>
        <FlexWidget
          style={{
            flexDirection: 'row',
            width: trackWidth,
            height: 8,
            borderRadius: 4,
            backgroundColor: p.mutedBg,
            overflow: 'hidden',
          }}
        >
          {segments.map((seg, i) => (
            <FlexWidget
              key={i}
              style={{ width: seg.width, height: 8, ...(seg.color ? { backgroundColor: normalizeHex(seg.color) } : {}) }}
            />
          ))}
        </FlexWidget>
      </FlexWidget>
    );
  };

  return (
    <Surface p={p} style={{ paddingHorizontal: 14, paddingVertical: tier.pad }}>
      <FlexWidget
        {...open(links.calendar())}
        style={{ flexDirection: 'row', alignItems: 'center', width: 'match_parent', height: FREE_HEADLINE_HEIGHT }}
      >
        <Txt text={headline} color={p.fg} size={16} weight="600" />
        {sub ? <Spacer size={8} horizontal /> : null}
        {sub ? (
          <FlexWidget style={{ flex: 1 }}>
            <Txt text={sub} color={p.muted} size={12} />
          </FlexWidget>
        ) : null}
      </FlexWidget>
      <Spacer size={tier.gap} />
      <FlexWidget {...open(links.calendar())} style={{ width: 'match_parent' }}>
        {days.map((day) => {
          const isToday = day === today;
          const nowFraction = (now - (day + WORK_START * HOUR)) / ((WORK_END - WORK_START) * HOUR);
          const marker = isToday && nowFraction >= 0 && nowFraction <= 1
            ? Math.max(0, Math.min(trackWidth - 2, Math.round(nowFraction * trackWidth) - 1))
            : null;
          return (
            <FlexWidget
              key={day}
              style={{ flexDirection: 'row', alignItems: 'center', width: 'match_parent', height: tier.rowHeight }}
            >
              <FlexWidget style={{ width: FREE_LABEL_WIDTH, height: tier.rowHeight, justifyContent: 'center' }}>
                <Txt
                  text={f.weekdayShort(day)}
                  color={isToday ? p.fg : p.muted}
                  size={labelSize}
                  weight={isToday ? '600' : '400'}
                />
              </FlexWidget>
              <Spacer size={FREE_LABEL_GAP} horizontal />
              {marker === null ? (
                track(day)
              ) : (
                <OverlapWidget style={{ width: trackWidth, height: tier.rowHeight }}>
                  {track(day)}
                  <FlexWidget style={{ flexDirection: 'row', width: trackWidth, height: tier.rowHeight }}>
                    <FlexWidget style={{ width: marker, height: 1 }} />
                    <FlexWidget style={{ width: 2, height: tier.rowHeight, backgroundColor: p.destructive }} />
                  </FlexWidget>
                </OverlapWidget>
              )}
            </FlexWidget>
          );
        })}
        {tier.axis ? (
          <FlexWidget
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              width: 'match_parent',
              height: FREE_AXIS_HEIGHT,
              paddingLeft: FREE_LABEL_WIDTH + FREE_LABEL_GAP,
            }}
          >
            <Txt text={hourLabel(WORK_START, f.hour12)} color={p.muted} size={10} />
            <Spacer />
            <Txt text={hourLabel(Math.round((WORK_START + WORK_END) / 2), f.hour12)} color={p.muted} size={10} />
            <Spacer />
            <Txt text={hourLabel(WORK_END, f.hour12)} color={p.muted} size={10} />
          </FlexWidget>
        ) : null}
      </FlexWidget>
      {tier.button ? <Spacer size={tier.gap} /> : null}
      <Spacer />
      {tier.button ? (
        <FlexWidget style={{ flexDirection: 'row', width: 'match_parent' }}>
          <Button
            p={p}
            iconName="mail"
            label={f.t('widgets.free.mail', 'Mail my free times')}
            flex={1}
            height={tier.button}
            click={mail}
          />
        </FlexWidget>
      ) : null}
    </Surface>
  );
};

// ── Tasks ───────────────────────────────────────────────────────────────────

function tasksOff(p: WidgetPalette, f: Fmt) {
  return (
    <Surface p={p}>
      <Placeholder
        p={p}
        iconName="checklist"
        title={f.t('widgets.tasks.off', 'Tasks are off')}
        body={f.t('widgets.tasks.off_body', "Turn on tasks in the app's calendar settings")}
        click={open(links.settings('calendar'))}
      />
    </Surface>
  );
}

export const TasksLayout: Layout = ({ s, p, f, now, height }) => {
  if (!s.tasks.supported) return tasksOff(p, f);
  const compact = height < 200;
  const headerHeight = compact ? 36 : 44;
  // Open tasks first; sortTasks puts the completed ones last, so they only fill leftover rows.
  const sorted = sortTasks(s.tasks.items, now);
  const openCount = sorted.filter((t) => !t.done).length;
  const fit = Math.max(1, Math.floor((height - 2 - headerHeight - 1) / TASK_ROW_HEIGHT));
  const rows = sorted.slice(0, fit);
  return (
    <Surface p={p}>
      <Header
        p={p}
        height={headerHeight}
        iconName="checklist"
        title={f.t('widgets.tasks.title', 'Tasks')}
        count={f.t('widgets.tasks.open_count', '{count} open', { count: openCount })}
        click={open(links.calendar())}
        trailing={<Fab p={p} iconName="plus" size={compact ? 28 : 32} click={open(links.calendar())} />}
      />
      {openCount === 0 ? (
        <Placeholder p={p} iconName="check" title={f.t('widgets.tasks.empty', 'No open tasks')} click={open(links.calendar())} />
      ) : (
        rows.map((task, i) => <TaskRow key={task.id} p={p} f={f} task={task} now={now} last={i === rows.length - 1} />)
      )}
    </Surface>
  );
};

export const TaskProgressLayout: Layout = ({ s, p, f, now, width, height }) => {
  if (!s.tasks.supported) return tasksOff(p, f);
  const items = s.tasks.items;
  // Today's work: what is overdue or due today, plus what has been ticked off.
  const counted = new Map<string, TaskItem>();
  for (const t of tasksDueNow(items, now)) counted.set(t.id, t);
  for (const t of items) if (t.done) counted.set(t.id, t);
  const set = counted.size > 0 ? Array.from(counted.values()) : items;
  if (set.length === 0) {
    return (
      <Surface p={p}>
        <Placeholder p={p} iconName="check" title={f.t('widgets.tasks.empty', 'No open tasks')} click={open(links.calendar())} />
      </Surface>
    );
  }
  const total = set.length;
  const done = set.filter((t) => t.done).length;
  const left = total - done;
  const pad = height < 130 ? 10 : height < 150 ? 12 : 14;
  // Title (~19dp) and status line (~16dp) plus two 6dp gaps around the ring.
  const ringSize = Math.max(
    32,
    Math.min(80, Math.floor(height - 2 - 2 * pad - 19 - 16 - 12), Math.floor(width - 2 - 2 * pad)),
  );
  const labelSize = ringSize >= 72 ? 20 : ringSize >= 60 ? 17 : ringSize >= 48 ? 14 : 11;
  return (
    <Surface p={p} style={{ padding: pad, alignItems: 'center' }} click={open(links.calendar())}>
      <FlexWidget style={{ width: 'match_parent' }}>
        <Txt text={f.t('widgets.tasks.title', 'Tasks')} color={p.fg} size={14} weight="500" />
      </FlexWidget>
      <Spacer size={6} />
      <OverlapWidget style={{ width: ringSize, height: ringSize }}>
        <SvgWidget svg={ring(done / total, p.mutedBg, p.success)} style={{ width: ringSize, height: ringSize }} />
        <FlexWidget style={{ width: ringSize, height: ringSize, justifyContent: 'center', alignItems: 'center' }}>
          <Txt text={`${done}/${total}`} color={p.fg} size={labelSize} weight="700" />
        </FlexWidget>
      </OverlapWidget>
      <Spacer size={6} />
      <Txt
        text={left > 0 ? f.t('widgets.tasks.still_open', '{count} still open', { count: left }) : f.t('widgets.tasks.all_done', 'All done')}
        color={p.muted}
        size={12}
      />
    </Surface>
  );
};

// ── Countdown ───────────────────────────────────────────────────────────────

export const CountdownLayout: Layout = ({ s, p, f, now, height }) => {
  const e = countdownTarget(s.calendar.events, now);
  if (!e) {
    return (
      <Surface p={p}>
        <Placeholder p={p} iconName="calendar" title={f.t('widgets.countdown.empty', 'No upcoming events')} click={open(links.calendar())} />
      </Surface>
    );
  }
  const days = Math.max(0, daysUntil(e.start, now));
  // ~133dp tall at 48sp; smaller launchers get a smaller number and padding.
  const bigSize = height >= 140 ? 48 : height >= 125 ? 40 : 34;
  const pad = height >= 125 ? 14 : 10;
  const word = days === 0 ? f.t('widgets.calendar.today', 'Today') : days === 1 ? f.t('widgets.calendar.tomorrow', 'Tomorrow') : null;
  const when = `${f.weekdayDayMonth(e.start)} · ${e.allDay ? f.t('widgets.calendar.all_day', 'All day') : f.time(e.start)}`;
  return (
    <Surface p={p} style={{ padding: pad }} click={open(links.event(e))}>
      <FlexWidget style={{ flexDirection: 'row', alignItems: 'center', width: 'match_parent' }}>
        <Dot color={normalizeHex(e.color)} size={8} />
        <Spacer size={6} horizontal />
        <FlexWidget style={{ flex: 1 }}>
          <Txt text={untitled(f, e.title)} color={p.fg} size={14} weight="500" />
        </FlexWidget>
      </FlexWidget>
      <Spacer />
      {word ? (
        <Txt text={word} color={p.fg} size={Math.round(bigSize * 0.55)} weight="700" />
      ) : (
        <FlexWidget style={{ flexDirection: 'row', alignItems: 'flex-end' }}>
          <Txt text={String(days)} color={p.fg} size={bigSize} weight="700" />
          <Spacer size={6} horizontal />
          {/* Bottom padding lines the unit up with the number's baseline (descent is ~0.27em). */}
          <Txt
            text={f.t('widgets.countdown.days', '{count, plural, one {day} other {days}}', { count: days })}
            color={p.muted}
            size={14}
            style={{ paddingBottom: Math.round((bigSize - 14) * 0.27) }}
          />
        </FlexWidget>
      )}
      <Txt text={when} color={p.muted} size={12} style={{ marginTop: 4 }} />
    </Surface>
  );
};

// ── Birthdays ───────────────────────────────────────────────────────────────

const BIRTHDAY_HEADER_HEIGHT = 38;
const BIRTHDAY_ROW_HEIGHT = 50;

export const BirthdaysLayout: Layout = ({ s, p, f, now, width, height }) => {
  const upcoming = upcomingBirthdays(s, now);
  const header = (
    <Header
      p={p}
      height={BIRTHDAY_HEADER_HEIGHT}
      iconName="cake"
      iconColor={BIRTHDAY_COLOR}
      title={f.t('widgets.birthdays.title', 'Birthdays')}
      click={open(links.calendar())}
    />
  );
  if (upcoming.length === 0) {
    return (
      <Surface p={p}>
        {header}
        <Placeholder
          p={p}
          iconName="cake"
          title={f.t('widgets.birthdays.empty', 'No birthdays coming up')}
          body={f.t('widgets.birthdays.empty_body', 'Birthdays come from your contacts.')}
          click={open(links.contacts())}
        />
      </Surface>
    );
  }
  const fit = Math.max(1, Math.floor((height - 2 - BIRTHDAY_HEADER_HEIGHT - 1) / BIRTHDAY_ROW_HEIGHT));
  const rows = upcoming.slice(0, fit);
  const wishTarget = rows.find((b) => b.email);
  // At 3 columns the labelled button would leave no room for the name.
  const narrow = width < 260;
  return (
    <Surface p={p}>
      {header}
      {rows.map((b, i) => {
        const days = daysUntil(b.date, now);
        const dateLine = days <= 0
          ? f.t('widgets.calendar.today', 'Today')
          : days === 1
            ? f.t('widgets.calendar.tomorrow', 'Tomorrow')
            : `${f.weekdayDayMonth(b.date)} · ${f.t('widgets.birthdays.in_days', '{count, plural, one {in # day} other {in # days}}', { count: days })}`;
        const wish = b === wishTarget && b.email;
        return (
          <FlexWidget
            key={`${b.name}-${b.date}`}
            {...open(links.contacts())}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              width: 'match_parent',
              height: BIRTHDAY_ROW_HEIGHT,
              paddingHorizontal: 14,
              borderBottomWidth: i === rows.length - 1 ? 0 : 1,
              borderBottomColor: p.border,
            }}
          >
            <Avatar initials={b.initials} color={b.color} size={32} />
            <Spacer size={10} horizontal />
            <FlexWidget style={{ flex: 1 }}>
              <Txt text={b.name || b.email || ''} color={p.fg} size={14} weight="600" />
              <Txt text={dateLine} color={p.muted} size={12} />
            </FlexWidget>
            {wish ? <Spacer size={8} horizontal /> : null}
            {wish ? (
              <Button
                p={p}
                variant="primary"
                iconName="send"
                label={narrow ? undefined : f.t('widgets.birthdays.send_wishes', 'Send wishes')}
                click={open(links.compose({ to: wish, subject: f.t('widgets.birthdays.wishes_subject', 'Happy birthday!') }))}
              />
            ) : null}
          </FlexWidget>
        );
      })}
    </Surface>
  );
};
