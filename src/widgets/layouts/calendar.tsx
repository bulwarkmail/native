// Board "Calendar": the agenda, this week, the month grid, today, the next
// event, the date with the next two events and the up-next countdown. They
// copy the webmail's agenda, week and month views as the mockup drew them.
//
// RemoteViews have no absolute positioning, so everything that sits at a
// computed place (week blocks, the now line) is built from spacers whose dp
// heights come from the widget size the launcher reports.

import React from 'react';
import { FlexWidget, OverlapWidget, SvgWidget, TextWidget, type ColorProp } from 'react-native-android-widget';
import { links, open } from '../clicks';
import {
  agendaDays,
  busyBlocks,
  daysUntil,
  eventsOnDay,
  monthGrid,
  nextEvent,
  startOfWeek,
  type AgendaDay,
  type BusyBlock,
  type MonthCell,
} from '../derive';
import { addDays, sameDay, startOfDay, type Fmt } from '../format';
import { ring, type IconName } from '../icons';
import { AGENDA_ROW_HEIGHT, AgendaRow, DAY_BAND_HEIGHT, DayBand } from '../parts';
import { Avatar, Button, Dot, EventChip, Fab, Header, Icon, Placeholder, Spacer, Surface, Txt } from '../primitives';
import type { EventItem, WidgetSnapshot } from '../snapshot';
import { chipBackground, normalizeHex, type WidgetPalette } from '../theme';
import type { Layout } from './types';

/** Surface's 1dp frame; Android adds a border to the padding, so it eats space. */
const FRAME = 1;
const HOUR = 3600000;
const GRID_START_HOUR = 8;
const GRID_END_HOUR = 18;

// ---------------------------------------------------------------------------
// Shared helpers

function unsupportedText(f: Fmt): string {
  return f.t('widgets.calendar.unsupported', "Calendar isn't available on this server");
}

function nothingText(f: Fmt): string {
  return f.t('widgets.calendar.nothing_planned', 'Nothing on the calendar');
}

function Unsupported({ p, f }: { p: WidgetPalette; f: Fmt }) {
  return (
    <Surface p={p}>
      <Placeholder p={p} iconName="calendar" title={unsupportedText(f)} />
    </Surface>
  );
}

function NothingPlanned({ p, f }: { p: WidgetPalette; f: Fmt }) {
  return (
    <Surface p={p}>
      <Placeholder p={p} iconName="calendarPlain" title={nothingText(f)} click={open(links.calendar())} />
    </Surface>
  );
}

/** Appends an alpha byte to a `#rrggbb` palette colour; other forms pass through. */
function withAlpha(color: ColorProp, alpha: string): ColorProp {
  return /^#[0-9a-f]{6}$/i.test(color) ? (`${color}${alpha}` as ColorProp) : color;
}

function upper(text: string, locale: string): string {
  try {
    return text.toLocaleUpperCase(locale);
  } catch {
    return text.toUpperCase();
  }
}

function capitalize(text: string, locale: string): string {
  if (!text) return text;
  return upper(text.charAt(0), locale) + text.slice(1);
}

function eventTitle(f: Fmt, e: EventItem): string {
  return e.title || f.t('widgets.calendar.untitled', '(no title)');
}

function timeRange(f: Fmt, e: EventItem): string {
  return `${f.time(e.start)} – ${f.time(e.end)}`;
}

/** Nothing for today, the weekday for the coming six days, a date after that. */
function dayPrefix(f: Fmt, ms: number, now: number): string {
  const diff = daysUntil(ms, now);
  if (diff <= 0) return '';
  return diff < 7 ? f.weekdayShort(ms) : f.dayMonth(ms);
}

/** "Tue 09:30 – 10:00" for another day, the bare range for today. */
function whenRange(f: Fmt, e: EventItem, now: number): string {
  const prefix = dayPrefix(f, e.start, now);
  return prefix ? `${prefix} ${timeRange(f, e)}` : timeRange(f, e);
}

/** How the month view's chips label an event: "09:30", "Tue 10:00", "All day". */
function chipTime(f: Fmt, e: EventItem, now: number): string {
  const today = startOfDay(now);
  const prefix = dayPrefix(f, Math.max(e.start, today), now);
  if (e.allDay) return prefix || f.t('widgets.calendar.all_day', 'All day');
  if (e.start < today) return f.t('widgets.calendar.now', 'Now');
  return prefix ? `${prefix} ${f.time(e.start)}` : f.time(e.start);
}

/** "Today", "Tomorrow", the weekday this week, else weekday and date. */
function dayLabel(f: Fmt, dayStart: number, now: number): string {
  const diff = daysUntil(dayStart, now);
  if (diff === 0) return f.t('widgets.calendar.today', 'Today');
  if (diff === 1) return f.t('widgets.calendar.tomorrow', 'Tomorrow');
  return diff > 1 && diff < 7 ? f.weekdayLong(dayStart) : f.weekdayDayMonth(dayStart);
}

/**
 * Events still ahead or running, soonest first, all-day events leading their
 * day. An all-day event that began before today is not "next" any more, so a
 * week-long trip does not hold the top spot all week.
 */
function upcoming(events: EventItem[], now: number): EventItem[] {
  const today = startOfDay(now);
  const day = (e: EventItem) => startOfDay(Math.max(e.start, today));
  return events
    .filter((e) => (e.allDay ? e.start >= today : e.end > now))
    .sort((a, b) => day(a) - day(b) || (a.allDay === b.allDay ? a.start - b.start : a.allDay ? -1 : 1));
}

/** Video link or place, as the agenda row shows it. */
function placeOf(f: Fmt, e: EventItem): { icon: IconName; text: string } | null {
  if (e.videoUrl) return { icon: 'video', text: e.videoName || f.t('widgets.calendar.video_call', 'Video call') };
  if (e.location) return { icon: 'mapPin', text: e.location };
  return null;
}

/** The signed-in addresses, where an account label is one. */
function selfAddresses(s: WidgetSnapshot): Set<string> {
  return new Set(
    s.accounts.map((a) => a.label.trim().toLowerCase()).filter((label) => label.includes('@')),
  );
}

function monthYear(f: Fmt, ms: number): string {
  try {
    return new Intl.DateTimeFormat(f.locale, { month: 'long', year: 'numeric' }).format(new Date(ms));
  } catch {
    return `${f.monthLong(ms)} ${new Date(ms).getFullYear()}`;
  }
}

// ---------------------------------------------------------------------------
// Agenda (4x4, down to 3x2)

const AGENDA_FOOTER_HEIGHT = 30;

interface AgendaPlan {
  sections: AgendaDay[];
  /** The first day with rows that did not fit, summarised in the footer. */
  hidden: AgendaDay | null;
}

function planAgenda(days: AgendaDay[], room: number): AgendaPlan {
  const full = days.reduce((h, d) => h + DAY_BAND_HEIGHT + d.events.length * AGENDA_ROW_HEIGHT, 0);
  const budget = full <= room ? room : room - AGENDA_FOOTER_HEIGHT;
  const sections: AgendaDay[] = [];
  let used = 0;
  for (const day of days) {
    const fit = Math.floor((budget - used - DAY_BAND_HEIGHT) / AGENDA_ROW_HEIGHT);
    const take = Math.max(0, Math.min(day.events.length, fit));
    if (take > 0) {
      sections.push({ dayStart: day.dayStart, events: day.events.slice(0, take) });
      used += DAY_BAND_HEIGHT + take * AGENDA_ROW_HEIGHT;
    }
    if (take < day.events.length) {
      return { sections, hidden: { dayStart: day.dayStart, events: day.events.slice(take) } };
    }
  }
  return { sections, hidden: null };
}

export const AgendaLayout: Layout = ({ s, p, f, now, height }) => {
  if (!s.calendar.supported) return <Unsupported p={p} f={f} />;
  const compact = height < 220;
  const headerHeight = compact ? 38 : 44;
  const header = (
    <Header
      p={p}
      height={headerHeight}
      iconName="calendar"
      title={f.t('widgets.calendar.agenda', 'Agenda')}
      click={open(links.calendar())}
      trailing={<Fab p={p} iconName="plus" size={compact ? 28 : 32} click={open(links.calendar())} />}
    />
  );
  const days = agendaDays(s.calendar.events, now, 14);
  if (days.length === 0) {
    return (
      <Surface p={p}>
        {header}
        <Placeholder p={p} iconName="calendarPlain" title={nothingText(f)} click={open(links.calendar())} />
      </Surface>
    );
  }
  // Header bar plus its 1dp rule.
  const room = height - 2 * FRAME - headerHeight - 1;
  const { sections, hidden } = planAgenda(days, room);
  const rows: React.JSX.Element[] = [];
  sections.forEach((day, d) => {
    rows.push(<DayBand key={`band-${day.dayStart}`} p={p} f={f} dayStart={day.dayStart} now={now} />);
    day.events.forEach((e, i) => {
      const last = !hidden && d === sections.length - 1 && i === day.events.length - 1;
      rows.push(<AgendaRow key={`${day.dayStart}-${e.id}`} p={p} f={f} e={e} last={last} />);
    });
  });
  return (
    <Surface p={p}>
      {header}
      {rows}
      {hidden ? (
        <FlexWidget
          {...open(links.calendar())}
          style={{ width: 'match_parent', height: AGENDA_FOOTER_HEIGHT, justifyContent: 'center', paddingHorizontal: 14 }}
        >
          <Txt
            text={f.t('widgets.calendar.agenda_more', '{day}: {events}', {
              day: dayLabel(f, hidden.dayStart, now),
              events: hidden.events.map((e) => eventTitle(f, e)).join(', '),
            })}
            color={p.muted}
            size={13}
          />
        </FlexWidget>
      ) : null}
    </Surface>
  );
};

// ---------------------------------------------------------------------------
// This week (4x2)

const WEEK_PAD = 10;
const WEEK_LABEL_HEIGHT = 16;
const WEEK_DAY_SIZE = 24;
const WEEK_STRIP_HEIGHT = 20;
const WEEK_GAP = 4;
const WEEK_BLOCK_MIN = 4;
const WEEK_MAX_LANES = 3;
const WEEK_LANE_GAP = 1;

interface StripSegment {
  span: number;
  event: EventItem | null;
}

/** All-day events across the week; a multi-day event becomes one wide chip. */
function allDaySegments(events: EventItem[], days: number[]): StripSegment[] {
  const segments: StripSegment[] = [];
  let previousId: string | null = null;
  for (const day of days) {
    const list = eventsOnDay(events, day).filter((e) => e.allDay);
    const keepId: string | null = previousId;
    const event: EventItem | null = list.find((e) => e.id === keepId) ?? list[0] ?? null;
    const last = segments[segments.length - 1];
    if (last && (last.event?.id ?? null) === (event?.id ?? null)) last.span += 1;
    else segments.push({ span: 1, event });
    previousId = event?.id ?? null;
  }
  return segments;
}

interface PlacedBlock {
  /** dp from the top of the grid. */
  top: number;
  height: number;
  color: string;
}

/**
 * Stacks one day's busy blocks into side-by-side lanes, the way the week view
 * splits overlapping events. Once the lanes run out, a block starts where the
 * lane that frees up first ends.
 */
function laneBlocks(blocks: BusyBlock[], gridHeight: number): PlacedBlock[][] {
  const lanes: Array<{ end: number; items: PlacedBlock[] }> = [];
  for (const b of [...blocks].sort((x, y) => x.from - y.from || y.to - x.to)) {
    let top = b.from * gridHeight;
    let lane = lanes.find((l) => l.end <= top + 0.5);
    if (!lane && lanes.length < WEEK_MAX_LANES) {
      lane = { end: 0, items: [] };
      lanes.push(lane);
    }
    if (!lane) {
      lane = lanes.reduce((a, c) => (c.end < a.end ? c : a));
      top = lane.end;
    }
    top = Math.max(top, lane.end);
    const bottom = Math.min(gridHeight, Math.max(b.to * gridHeight, top + WEEK_BLOCK_MIN));
    if (bottom - top < WEEK_BLOCK_MIN) top = Math.max(lane.end, bottom - WEEK_BLOCK_MIN);
    if (bottom - top <= 0) continue;
    lane.items.push({ top, height: bottom - top, color: b.color });
    lane.end = bottom;
  }
  return lanes.map((l) => l.items);
}

function BlockLanes({ lanes, width, height }: { lanes: PlacedBlock[][]; width: number; height: number }) {
  const count = Math.max(1, lanes.length);
  const laneWidth = Math.max(1, (width - 4 - (count - 1) * WEEK_LANE_GAP) / count);
  const columns: React.JSX.Element[] = [];
  lanes.forEach((items, l) => {
    if (l > 0) columns.push(<Spacer key={`gap-${l}`} size={WEEK_LANE_GAP} horizontal />);
    const parts: React.JSX.Element[] = [];
    let cursor = 0;
    items.forEach((b, j) => {
      if (b.top > cursor) parts.push(<Spacer key={`s-${j}`} size={b.top - cursor} />);
      const color = normalizeHex(b.color);
      parts.push(
        <FlexWidget
          key={`b-${j}`}
          style={{
            width: laneWidth,
            height: b.height,
            borderRadius: 2,
            backgroundColor: chipBackground(color),
            borderLeftWidth: 3,
            borderLeftColor: color,
          }}
        />,
      );
      cursor = b.top + b.height;
    });
    columns.push(
      <FlexWidget key={`lane-${l}`} style={{ width: laneWidth, height }}>
        {parts}
      </FlexWidget>,
    );
  });
  return (
    <FlexWidget style={{ flexDirection: 'row', width, height, paddingHorizontal: 2 }}>
      {columns}
    </FlexWidget>
  );
}

/** The red now line with its dot, `top` dp down the grid. */
function NowLine({ p, top, width, height }: { p: WidgetPalette; top: number; width: number; height: number }) {
  const offset = Math.max(0, Math.min(height - 6, top - 3));
  return (
    <FlexWidget style={{ width, height }}>
      <Spacer size={offset} />
      <FlexWidget style={{ flexDirection: 'row', alignItems: 'center', width, height: 6 }}>
        <Dot color={p.destructive} size={6} />
        <FlexWidget style={{ width: Math.max(0, width - 6), height: 2, backgroundColor: p.destructive }} />
      </FlexWidget>
    </FlexWidget>
  );
}

export const WeekLayout: Layout = ({ s, p, f, now, width, height }) => {
  if (!s.calendar.supported) return <Unsupported p={p} f={f} />;
  const events = s.calendar.events;
  const first = startOfWeek(now, s.weekStart);
  const days = Array.from({ length: 7 }, (_, i) => addDays(first, i));
  const colWidth = (width - 2 * FRAME - 2 * WEEK_PAD) / 7;
  const segments = allDaySegments(events, days);
  const strip = segments.some((seg) => seg.event !== null);
  const gridHeight = Math.max(
    0,
    height - 2 * FRAME - WEEK_PAD - WEEK_LABEL_HEIGHT - 2 - WEEK_DAY_SIZE - WEEK_GAP
      - (strip ? WEEK_STRIP_HEIGHT + WEEK_GAP : 0) - 1,
  );
  const windowStart = startOfDay(now) + GRID_START_HOUR * HOUR;
  const nowFraction = (now - windowStart) / ((GRID_END_HOUR - GRID_START_HOUR) * HOUR);

  const headCells = days.map((day) => {
    const isToday = sameDay(day, now);
    return (
      <FlexWidget key={`head-${day}`} style={{ width: colWidth, alignItems: 'center' }}>
        <Txt
          text={upper(f.weekdayShort(day), f.locale)}
          color={isToday ? p.today : p.muted}
          size={11}
          weight={isToday ? '600' : '400'}
          style={{ height: WEEK_LABEL_HEIGHT }}
        />
        <Spacer size={2} />
        {isToday ? (
          <FlexWidget
            style={{
              width: WEEK_DAY_SIZE,
              height: WEEK_DAY_SIZE,
              borderRadius: WEEK_DAY_SIZE / 2,
              backgroundColor: p.primary,
              justifyContent: 'center',
              alignItems: 'center',
            }}
          >
            <TextWidget
              text={String(new Date(day).getDate())}
              allowFontScaling={false}
              style={{ color: p.primaryFg, fontSize: 13, fontWeight: '700' }}
            />
          </FlexWidget>
        ) : (
          <FlexWidget style={{ height: WEEK_DAY_SIZE, justifyContent: 'center', alignItems: 'center' }}>
            <TextWidget text={String(new Date(day).getDate())} allowFontScaling={false} style={{ color: p.fg, fontSize: 14 }} />
          </FlexWidget>
        )}
      </FlexWidget>
    );
  });

  const stripCells = segments.map((seg, i) => {
    const e = seg.event;
    const color = e ? normalizeHex(e.color) : null;
    return (
      <FlexWidget key={`strip-${i}`} style={{ width: seg.span * colWidth, height: WEEK_STRIP_HEIGHT, paddingRight: 2 }}>
        {e && color ? (
          <FlexWidget
            {...open(links.event(e))}
            style={{
              width: 'match_parent',
              height: WEEK_STRIP_HEIGHT,
              justifyContent: 'center',
              paddingLeft: 4,
              borderRadius: 3,
              backgroundColor: chipBackground(color),
              borderLeftWidth: 3,
              borderLeftColor: color,
            }}
          >
            <Txt text={eventTitle(f, e)} color={color} size={10} weight="500" />
          </FlexWidget>
        ) : null}
      </FlexWidget>
    );
  });

  const gridColumns = days.map((day, i) => {
    const ruled = i < days.length - 1;
    const inner = colWidth - (ruled ? 1 : 0);
    const lanes = laneBlocks(busyBlocks(events, day, GRID_START_HOUR, GRID_END_HOUR), gridHeight);
    const blocks = <BlockLanes lanes={lanes} width={inner} height={gridHeight} />;
    const showNow = sameDay(day, now) && nowFraction >= 0 && nowFraction <= 1;
    return (
      <FlexWidget
        key={`col-${day}`}
        style={{
          width: colWidth,
          height: gridHeight,
          ...(ruled ? { borderRightWidth: 1, borderRightColor: p.border } : {}),
        }}
      >
        {showNow ? (
          <OverlapWidget style={{ width: inner, height: gridHeight }}>
            {blocks}
            <NowLine p={p} top={nowFraction * gridHeight} width={inner} height={gridHeight} />
          </OverlapWidget>
        ) : blocks}
      </FlexWidget>
    );
  });

  return (
    <Surface p={p} style={{ paddingTop: WEEK_PAD, paddingHorizontal: WEEK_PAD }} click={open(links.calendar())}>
      <FlexWidget style={{ flexDirection: 'row', width: 'match_parent' }}>{headCells}</FlexWidget>
      <Spacer size={WEEK_GAP} />
      {strip ? (
        <FlexWidget style={{ flexDirection: 'row', width: 'match_parent', height: WEEK_STRIP_HEIGHT }}>{stripCells}</FlexWidget>
      ) : null}
      {strip ? <Spacer size={WEEK_GAP} /> : null}
      <FlexWidget
        style={{
          flexDirection: 'row',
          width: 'match_parent',
          height: gridHeight + 1,
          borderTopWidth: 1,
          borderTopColor: p.border,
        }}
      >
        {gridColumns}
      </FlexWidget>
    </Surface>
  );
};

// ---------------------------------------------------------------------------
// Month (4x4)

const MONTH_PAD = 8;
const MONTH_LABEL_HEIGHT = 18;
const MONTH_GRID_TOP = 4;
const MONTH_CHIP_HEIGHT = 24;
const MONTH_CELL_MIN = 30;
const MONTH_CELL_MAX = 48;
/** Rule above the chips: 6dp margin, 1dp border, 6dp padding. */
const MONTH_CHIPS_TOP = 13;
const MONTH_CHIPS_BOTTOM = 8;

function NavButton({ p, iconName }: { p: WidgetPalette; iconName: IconName }) {
  return (
    <FlexWidget
      {...open(links.calendar())}
      style={{ width: 32, height: 32, borderRadius: 6, justifyContent: 'center', alignItems: 'center' }}
    >
      <Icon name={iconName} color={p.fg} size={16} />
    </FlexWidget>
  );
}

function MonthDay({
  p,
  cell,
  width,
  height,
  circle,
  showDots,
}: {
  p: WidgetPalette;
  cell: MonthCell;
  width: number;
  height: number;
  circle: number;
  showDots: boolean;
}) {
  const color = cell.isToday ? p.primaryFg : cell.inMonth ? p.fg : withAlpha(p.muted, 'b3');
  const dots: React.JSX.Element[] = [];
  if (showDots) {
    cell.dots.forEach((c, i) => {
      if (i > 0) dots.push(<Spacer key={`g-${i}`} size={3} horizontal />);
      dots.push(<Dot key={`d-${i}`} color={normalizeHex(c)} size={6} />);
    });
  }
  return (
    <FlexWidget {...open(links.calendar())} style={{ width, height, alignItems: 'center' }}>
      <FlexWidget
        style={{
          width: circle,
          height: circle,
          borderRadius: circle / 2,
          justifyContent: 'center',
          alignItems: 'center',
          ...(cell.isToday ? { backgroundColor: p.primary } : {}),
        }}
      >
        <TextWidget
          text={String(cell.day)}
          maxLines={1}
          allowFontScaling={false}
          style={{ color, fontSize: circle >= 22 ? 14 : 13, fontWeight: cell.isToday ? '700' : '400' }}
        />
      </FlexWidget>
      {dots.length > 0 ? <Spacer size={3} /> : null}
      {dots.length > 0 ? <FlexWidget style={{ flexDirection: 'row' }}>{dots}</FlexWidget> : null}
    </FlexWidget>
  );
}

export const MonthLayout: Layout = ({ s, p, f, now, width, height }) => {
  if (!s.calendar.supported) return <Unsupported p={p} f={f} />;
  const weeks = monthGrid(s.calendar.events, now, s.weekStart);
  const next = upcoming(s.calendar.events, now);
  const headerHeight = height >= 340 ? 44 : 38;
  const cellWidth = (width - 2 * FRAME - 2 * MONTH_PAD) / 7;
  const chipsHeight = (n: number) =>
    n === 0 ? 0 : MONTH_CHIPS_TOP + n * MONTH_CHIP_HEIGHT + (n - 1) * 4 + MONTH_CHIPS_BOTTOM;
  const gridRoom = (n: number) =>
    height - 2 * FRAME - headerHeight - MONTH_LABEL_HEIGHT - MONTH_GRID_TOP - chipsHeight(n);
  // Two chips when the weeks still get a comfortable row, else one, else none.
  let chips = Math.min(2, next.length);
  while (chips > 0 && gridRoom(chips) / weeks.length < MONTH_CELL_MIN) chips -= 1;
  const cellHeight = Math.max(18, Math.min(MONTH_CELL_MAX, Math.floor(gridRoom(chips) / weeks.length)));
  const circle = Math.min(26, Math.max(16, cellHeight - 12));
  const showDots = cellHeight - circle >= 8;

  const chipRows: React.JSX.Element[] = [];
  next.slice(0, chips).forEach((e, i) => {
    if (i > 0) chipRows.push(<Spacer key={`g-${i}`} size={4} />);
    chipRows.push(
      <EventChip
        key={e.id}
        title={eventTitle(f, e)}
        time={chipTime(f, e, now)}
        color={e.color}
        height={MONTH_CHIP_HEIGHT}
        click={open(links.event(e))}
      />,
    );
  });

  return (
    <Surface p={p}>
      <FlexWidget
        {...open(links.calendar())}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          width: 'match_parent',
          height: headerHeight,
          paddingLeft: 16,
          paddingRight: 8,
        }}
      >
        <FlexWidget style={{ flex: 1 }}>
          <Txt text={monthYear(f, now)} color={p.fg} size={16} weight="600" />
        </FlexWidget>
        <NavButton p={p} iconName="chevronLeft" />
        <Spacer size={4} horizontal />
        <NavButton p={p} iconName="chevronRight" />
      </FlexWidget>
      <FlexWidget style={{ flexDirection: 'row', width: 'match_parent', height: MONTH_LABEL_HEIGHT, paddingHorizontal: MONTH_PAD }}>
        {weeks[0].map((cell) => (
          <FlexWidget
            key={`wd-${cell.dayStart}`}
            style={{ width: cellWidth, height: MONTH_LABEL_HEIGHT, justifyContent: 'center', alignItems: 'center' }}
          >
            <Txt text={f.weekdayShort(cell.dayStart)} color={p.muted} size={12} />
          </FlexWidget>
        ))}
      </FlexWidget>
      <Spacer size={MONTH_GRID_TOP} />
      {weeks.map((week) => (
        <FlexWidget
          key={`week-${week[0].dayStart}`}
          style={{ flexDirection: 'row', width: 'match_parent', height: cellHeight, paddingHorizontal: MONTH_PAD }}
        >
          {week.map((cell) => (
            <MonthDay
              key={`day-${cell.dayStart}`}
              p={p}
              cell={cell}
              width={cellWidth}
              height={cellHeight}
              circle={circle}
              showDots={showDots}
            />
          ))}
        </FlexWidget>
      ))}
      {chipRows.length > 0 ? (
        <FlexWidget
          style={{
            width: 'match_parent',
            marginTop: 6,
            borderTopWidth: 1,
            borderTopColor: p.border,
            paddingTop: 6,
            paddingHorizontal: 14,
          }}
        >
          {chipRows}
        </FlexWidget>
      ) : null}
    </Surface>
  );
};

// ---------------------------------------------------------------------------
// Today (4x2)

const TODAY_PAD = 14;
const TODAY_CHIP = 24;
const TODAY_GAP = 4;
const TODAY_LINE = 16;
/** 6dp extra space, the "Tomorrow" label and one chip, with their gaps. */
const TOMORROW_BLOCK = 6 + TODAY_GAP + TODAY_LINE + TODAY_GAP + TODAY_CHIP;

function chipLabel(f: Fmt, e: EventItem): string {
  return e.allDay ? f.t('widgets.calendar.all_day', 'All day') : f.time(e.start);
}

function TodayColumn({
  s,
  p,
  f,
  now,
  height,
}: {
  s: WidgetSnapshot;
  p: WidgetPalette;
  f: Fmt;
  now: number;
  height: number;
}) {
  if (!s.calendar.supported) {
    return (
      <FlexWidget style={{ flex: 1, height: 'match_parent' }}>
        <Placeholder p={p} iconName="calendar" title={unsupportedText(f)} />
      </FlexWidget>
    );
  }
  const events = s.calendar.events;
  const today = startOfDay(now);
  const todayList = eventsOnDay(events, today).filter((e) => e.allDay || e.end > now);
  const tomorrowList = eventsOnDay(events, addDays(today, 1));

  // The "N more this week" line is always reserved; chips share the rest.
  const room = height - 2 * FRAME - 2 * TODAY_PAD - TODAY_LINE;
  const row = TODAY_CHIP + TODAY_GAP;
  let withTomorrow = tomorrowList.length > 0;
  let slots = Math.floor((room - (withTomorrow ? TOMORROW_BLOCK : 0) + TODAY_GAP) / row);
  if (slots < 1 && withTomorrow && todayList.length > 0) {
    withTomorrow = false;
    slots = Math.floor((room + TODAY_GAP) / row);
  }
  const shown = todayList.slice(0, Math.max(1, slots));

  const shownIds = new Set(shown.map((e) => e.id));
  if (withTomorrow) shownIds.add(tomorrowList[0].id);
  const weekEnd = addDays(startOfWeek(now, s.weekStart), 7);
  const rest = new Set<string>();
  for (let day = today; day < weekEnd; day = addDays(day, 1)) {
    for (const e of eventsOnDay(events, day)) {
      if (day === today && !e.allDay && e.end <= now) continue;
      if (!shownIds.has(e.id)) rest.add(e.id);
    }
  }
  const more = rest.size;

  if (todayList.length === 0 && tomorrowList.length === 0 && more === 0) {
    return (
      <FlexWidget style={{ flex: 1, height: 'match_parent' }}>
        <Placeholder
          p={p}
          iconName="calendarPlain"
          title={f.t('widgets.calendar.no_more_today', 'No more events today')}
          click={open(links.calendar())}
        />
      </FlexWidget>
    );
  }

  const items: React.JSX.Element[] = [];
  if (shown.length === 0) {
    items.push(
      <Txt key="none" text={f.t('widgets.calendar.no_more_today', 'No more events today')} color={p.muted} size={12} />,
    );
  }
  shown.forEach((e, i) => {
    if (i > 0) items.push(<Spacer key={`g-${i}`} size={TODAY_GAP} />);
    items.push(
      <EventChip
        key={e.id}
        title={eventTitle(f, e)}
        time={chipLabel(f, e)}
        color={e.color}
        height={TODAY_CHIP}
        click={open(links.event(e))}
      />,
    );
  });
  if (withTomorrow) {
    const e = tomorrowList[0];
    items.push(<Spacer key="tomorrow-gap" size={6 + TODAY_GAP} />);
    items.push(
      <Txt key="tomorrow" text={f.t('widgets.calendar.tomorrow', 'Tomorrow')} color={p.fg} size={12} weight="600" />,
    );
    items.push(<Spacer key="tomorrow-gap-2" size={TODAY_GAP} />);
    items.push(
      <EventChip
        key={`tomorrow-${e.id}`}
        title={eventTitle(f, e)}
        time={chipLabel(f, e)}
        color={e.color}
        height={TODAY_CHIP}
        click={open(links.event(e))}
      />,
    );
  }
  return (
    <FlexWidget style={{ flex: 1, height: 'match_parent' }}>
      {items}
      <Spacer />
      {more > 0 ? (
        <Txt
          text={f.t('widgets.calendar.more_this_week', '{count, plural, one {# more this week} other {# more this week}}', {
            count: more,
          })}
          color={p.muted}
          size={12}
        />
      ) : null}
    </FlexWidget>
  );
}

export const TodayEventsLayout: Layout = ({ s, p, f, now, height }) => {
  // The date block is ~108dp tall at 40sp; a short 4x2 gets a smaller number
  // and, if still tight, loses the month line.
  const room = height - 2 * FRAME - 2 * TODAY_PAD;
  const big = room >= 108 ? 40 : 32;
  const showMonth = room >= 3 * 18 + Math.ceil(big * 1.33);
  return (
    <Surface p={p} style={{ padding: TODAY_PAD, flexDirection: 'row' }}>
      <FlexWidget {...open(links.calendar())} style={{ width: 76, height: 'match_parent' }}>
        <Txt text={f.t('widgets.calendar.today', 'Today')} color={p.today} size={13} weight="600" />
        <Txt text={String(new Date(now).getDate())} color={p.fg} size={big} weight="600" />
        <Txt text={f.weekdayLong(now)} color={p.muted} size={13} />
        {showMonth ? <Txt text={f.monthLong(now)} color={p.muted} size={13} /> : null}
      </FlexWidget>
      <Spacer size={14} horizontal />
      <TodayColumn s={s} p={p} f={f} now={now} height={height} />
    </Surface>
  );
};

// ---------------------------------------------------------------------------
// Next event (2x2)

export const NextEventLayout: Layout = ({ s, p, f, now, height }) => {
  if (!s.calendar.supported) return <Unsupported p={p} f={f} />;
  const next = nextEvent(s.calendar.events, now);
  if (!next) return <NothingPlanned p={p} f={f} />;
  const { event: e, running } = next;
  const when = running ? f.t('widgets.calendar.now', 'Now') : capitalize(f.relative(e.start, now), f.locale);
  // Status line, gap, one title line and the time range always show; then the
  // place, the calendar and a second title line, as long as they fit.
  const room = height - 2 * FRAME - 28;
  let used = 16 + 6 + 22 + 18;
  const place = placeOf(f, e);
  const showPlace = !!place && used + 16 <= room;
  if (showPlace) used += 16;
  const showCalendar = !!e.calendarName && used + 16 + (showPlace ? 2 : 0) <= room;
  if (showCalendar) used += 16 + (showPlace ? 2 : 0);
  const titleLines = used + 22 <= room ? 2 : 1;
  return (
    <Surface p={p} style={{ padding: 14 }} click={open(links.event(e))}>
      <FlexWidget style={{ flexDirection: 'row', alignItems: 'center' }}>
        <Icon name="clock" color={p.today} size={14} />
        <Spacer size={5} horizontal />
        <Txt text={when} color={p.today} size={12} weight="600" />
      </FlexWidget>
      <Spacer size={6} />
      <Txt text={eventTitle(f, e)} color={p.fg} size={16} weight="600" lines={titleLines} />
      <Txt text={whenRange(f, e, now)} color={p.muted} size={13} />
      <Spacer />
      {showPlace && place ? (
        <FlexWidget style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Icon name={place.icon} color={p.muted} size={12} />
          <Spacer size={4} horizontal />
          <Txt text={place.text} color={p.muted} size={12} />
        </FlexWidget>
      ) : null}
      {showPlace && showCalendar ? <Spacer size={2} /> : null}
      {showCalendar ? (
        <FlexWidget style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Dot color={normalizeHex(e.color)} size={8} />
          <Spacer size={6} horizontal />
          <Txt text={e.calendarName} color={p.muted} size={12} />
        </FlexWidget>
      ) : null}
    </Surface>
  );
};

// ---------------------------------------------------------------------------
// Date and next two (2x2)

const DATE_PAD = 12;
const DATE_CIRCLE = 36;
const DATE_CHIP = 36;

function TwoLineChip({ f, e, now }: { f: Fmt; e: EventItem; now: number }) {
  const color = normalizeHex(e.color);
  return (
    <FlexWidget
      {...open(links.event(e))}
      style={{
        width: 'match_parent',
        height: DATE_CHIP,
        justifyContent: 'center',
        paddingHorizontal: 6,
        borderRadius: 3,
        backgroundColor: chipBackground(color),
        borderLeftWidth: 3,
        borderLeftColor: color,
      }}
    >
      <Txt text={eventTitle(f, e)} color={color} size={12} weight="600" />
      <Txt text={chipTime(f, e, now)} color={`${color}cc` as ColorProp} size={11} />
    </FlexWidget>
  );
}

export const DateNextLayout: Layout = ({ s, p, f, now, height }) => {
  const room = height - 2 * FRAME - 2 * DATE_PAD - DATE_CIRCLE - 8;
  const count = room >= 2 * DATE_CHIP + 4 ? 2 : 1;
  const next = s.calendar.supported ? upcoming(s.calendar.events, now).slice(0, count) : [];
  const chips: React.JSX.Element[] = [];
  next.forEach((e, i) => {
    if (i > 0) chips.push(<Spacer key={`g-${i}`} size={4} />);
    chips.push(<TwoLineChip key={e.id} f={f} e={e} now={now} />);
  });
  return (
    <Surface p={p} style={{ padding: DATE_PAD }} click={open(links.calendar())}>
      <FlexWidget style={{ flexDirection: 'row', alignItems: 'center', width: 'match_parent' }}>
        <FlexWidget
          style={{
            width: DATE_CIRCLE,
            height: DATE_CIRCLE,
            borderRadius: DATE_CIRCLE / 2,
            backgroundColor: p.primary,
            justifyContent: 'center',
            alignItems: 'center',
          }}
        >
          <TextWidget
            text={String(new Date(now).getDate())}
            allowFontScaling={false}
            style={{ color: p.primaryFg, fontSize: 16, fontWeight: '700' }}
          />
        </FlexWidget>
        <Spacer size={8} horizontal />
        <FlexWidget style={{ flex: 1 }}>
          <Txt text={f.weekdayLong(now)} color={p.fg} size={13} weight="600" />
          <Txt text={f.monthLong(now)} color={p.muted} size={12} />
        </FlexWidget>
      </FlexWidget>
      <Spacer />
      {chips.length > 0 ? chips : (
        <Txt
          text={s.calendar.supported ? nothingText(f) : unsupportedText(f)}
          color={p.muted}
          size={12}
          lines={2}
        />
      )}
    </Surface>
  );
};

// ---------------------------------------------------------------------------
// Up next (4x2)

interface Countdown {
  value: string;
  unit: string;
  /** Share of the ring to fill: minutes to go out of an hour. */
  fraction: number;
}

function countdown(f: Fmt, e: EventItem, now: number, running: boolean): Countdown {
  const minutes = Math.round((e.start - now) / 60000);
  if (running || minutes <= 0) return { value: f.t('widgets.calendar.now', 'Now'), unit: '', fraction: 0 };
  if (minutes < 60) {
    return {
      value: String(minutes),
      unit: f.t('widgets.calendar.unit_minutes', '{count, plural, one {min} other {min}}', { count: minutes }),
      fraction: minutes / 60,
    };
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return {
      value: String(hours),
      unit: f.t('widgets.calendar.unit_hours', '{count, plural, one {hour} other {hours}}', { count: hours }),
      fraction: 1,
    };
  }
  const days = daysUntil(e.start, now);
  return {
    value: String(days),
    unit: f.t('widgets.calendar.unit_days', '{count, plural, one {day} other {days}}', { count: days }),
    fraction: 1,
  };
}

function People({ p, e }: { p: WidgetPalette; e: EventItem }) {
  const faces = e.participants.slice(0, 3);
  return (
    <FlexWidget style={{ flexDirection: 'row', alignItems: 'center' }}>
      {faces.map((person, i) => (
        <FlexWidget key={`${person.email}-${i}`} style={{ marginLeft: i === 0 ? 0 : -7 }}>
          <Avatar initials={person.initials} color={person.color} size={22} ring={p.bg} />
        </FlexWidget>
      ))}
      <Spacer size={6} horizontal />
      <Icon name="users" color={p.muted} size={13} />
      <Spacer size={3} horizontal />
      <Txt text={String(e.participants.length)} color={p.muted} size={12} />
    </FlexWidget>
  );
}

export const UpNextLayout: Layout = ({ s, p, f, now }) => {
  if (!s.calendar.supported) return <Unsupported p={p} f={f} />;
  const next = nextEvent(s.calendar.events, now);
  if (!next) return <NothingPlanned p={p} f={f} />;
  const { event: e, running } = next;
  const title = eventTitle(f, e);
  const left = countdown(f, e, now, running);
  const meta = [whenRange(f, e, now), e.calendarName].filter(Boolean).join(' · ');

  const self = selfAddresses(s);
  const recipients = Array.from(
    new Set(e.participants.map((x) => x.email.trim()).filter((x) => x && !self.has(x.toLowerCase()))),
  );
  const late = links.compose({
    to: recipients.length > 0 ? recipients.join(',') : undefined,
    subject: f.t('widgets.calendar.running_late_subject', 'Running late: {title}', { title }),
    body: f.t('widgets.calendar.running_late_body', "I'm running a few minutes late for {title}.", { title }),
  });
  const joinLabel = e.videoName && e.videoName.length <= 12
    ? f.t('widgets.calendar.join_named', 'Join {name}', { name: e.videoName })
    : f.t('widgets.calendar.join', 'Join');

  return (
    <Surface p={p} style={{ padding: 14 }}>
      <FlexWidget {...open(links.event(e))} style={{ flexDirection: 'row', alignItems: 'center', width: 'match_parent' }}>
        <OverlapWidget style={{ width: 64, height: 64 }}>
          <SvgWidget svg={ring(left.fraction, p.border, p.primary, 5)} style={{ width: 64, height: 64 }} />
          <FlexWidget style={{ width: 64, height: 64, justifyContent: 'center', alignItems: 'center' }}>
            <TextWidget
              text={left.value}
              maxLines={1}
              allowFontScaling={false}
              style={{ color: p.fg, fontSize: left.value.length > 3 ? 13 : 18, fontWeight: '700' }}
            />
            {left.unit ? (
              <TextWidget text={left.unit} maxLines={1} allowFontScaling={false} style={{ color: p.muted, fontSize: 11 }} />
            ) : null}
          </FlexWidget>
        </OverlapWidget>
        <Spacer size={14} horizontal />
        <FlexWidget style={{ flex: 1 }}>
          <Txt text={title} color={p.fg} size={16} weight="600" />
          <Spacer size={2} />
          <FlexWidget style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Dot color={normalizeHex(e.color)} size={8} />
            <Spacer size={6} horizontal />
            <Txt text={meta} color={p.muted} size={13} />
          </FlexWidget>
          {e.participants.length > 0 ? <Spacer size={6} /> : null}
          {e.participants.length > 0 ? <People p={p} e={e} /> : null}
        </FlexWidget>
      </FlexWidget>
      <Spacer />
      <FlexWidget style={{ flexDirection: 'row', width: 'match_parent' }}>
        {e.videoUrl ? (
          <Button p={p} variant="primary" iconName="video" label={joinLabel} height={36} flex={1} click={open(e.videoUrl)} />
        ) : (
          <Button p={p} iconName="calendar" label={f.t('widgets.calendar.open', 'Open')} height={36} flex={1} click={open(links.event(e))} />
        )}
        <Spacer size={8} horizontal />
        <Button
          p={p}
          iconName="send"
          label={f.t('widgets.calendar.running_late', 'Running late')}
          height={36}
          flex={1}
          click={open(late)}
        />
      </FlexWidget>
    </Surface>
  );
};
