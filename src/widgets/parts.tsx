// List rows reused across widgets: the message rows of the webmail list, the
// agenda's event rows and day bands, and the task list's rows.

import React from 'react';
import { FlexWidget, TextWidget } from 'react-native-android-widget';
import { action, links, open, type WidgetClick } from './clicks';
import { dueKind } from './derive';
import type { Fmt } from './format';
import { Avatar, ColorBar, Dot, FilledIcon, Icon, Spacer, Txt } from './primitives';
import type { EventItem, MailItem, TaskItem } from './snapshot';
import type { WidgetPalette } from './theme';

/** `bg-primary` pill with the message icon and the thread size, as in the list. */
export function ThreadBadge({ p, count }: { p: WidgetPalette; count: number }) {
  return (
    <FlexWidget
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        height: 18,
        paddingHorizontal: 6,
        borderRadius: 999,
        backgroundColor: p.primary,
      }}
    >
      <Icon name="message" color={p.primaryFg} size={11} />
      <Spacer size={3} horizontal />
      <TextWidget text={String(count)} style={{ color: p.primaryFg, fontSize: 11, fontWeight: '600' }} />
    </FlexWidget>
  );
}

/**
 * The webmail's message row. `compact` drops the avatar and preview (the
 * extra-compact density); otherwise avatar, sender/time, subject and one line
 * of preview. Unread rows get the accent tint and the unread dot.
 */
export function MailRow({
  p,
  f,
  m,
  now,
  compact,
  showAccountDot,
  accountColor,
  last,
}: {
  p: WidgetPalette;
  f: Fmt;
  m: MailItem;
  now: number;
  compact?: boolean;
  showAccountDot?: boolean;
  accountColor?: string;
  last?: boolean;
}) {
  const click = open(links.message(m));
  const senderColor = m.unread ? p.fg : p.muted;
  const header = (
    <FlexWidget style={{ flexDirection: 'row', alignItems: 'center', width: 'match_parent', height: 18 }}>
      {showAccountDot && accountColor ? <Dot color={accountColor as `#${string}`} size={8} /> : null}
      {showAccountDot && accountColor ? <Spacer size={6} horizontal /> : null}
      <FlexWidget style={{ flex: 1, flexDirection: 'row', alignItems: 'center' }}>
        <Txt text={m.fromName || m.fromEmail} color={senderColor} size={14} weight={m.unread ? '700' : '500'} />
        {!compact && m.threadSize > 1 ? <Spacer size={6} horizontal /> : null}
        {!compact && m.threadSize > 1 ? <ThreadBadge p={p} count={m.threadSize} /> : null}
        {!compact && m.hasAttachment ? <Spacer size={4} horizontal /> : null}
        {!compact && m.hasAttachment ? <Icon name="paperclip" color={p.muted} size={13} /> : null}
        {m.starred ? <Spacer size={4} horizontal /> : null}
        {m.starred ? <FilledIcon name="star" color={p.star} size={13} /> : null}
      </FlexWidget>
      <Spacer size={6} horizontal />
      <Txt text={f.listDate(m.receivedAt, now)} color={m.unread ? p.fg : p.muted} size={12} weight={m.unread ? '600' : '400'} />
    </FlexWidget>
  );
  const subject = (
    <Txt
      text={m.subject || f.t('widgets.mail.no_subject', '(no subject)')}
      color={m.unread ? p.fg : p.subjectRead}
      size={compact ? 13 : 14}
      weight={m.unread ? '600' : '400'}
    />
  );
  return (
    <FlexWidget
      {...click}
      style={{
        width: 'match_parent',
        flexDirection: 'row',
        backgroundColor: m.unread ? p.unreadRow : p.bg,
        borderBottomWidth: last ? 0 : 1,
        borderBottomColor: p.border,
        paddingLeft: 4,
        paddingRight: 12,
        paddingVertical: compact ? 4 : 8,
      }}
    >
      <FlexWidget style={{ width: 12, paddingTop: 5, alignItems: 'center' }}>
        {m.unread ? <Dot color={p.unreadDot} size={7} /> : null}
      </FlexWidget>
      {!compact ? <Avatar initials={m.initials} color={m.color} size={32} /> : null}
      {!compact ? <Spacer size={10} horizontal /> : null}
      <FlexWidget style={{ flex: 1 }}>
        {header}
        {subject}
        {!compact && m.preview ? <Txt text={m.preview} color={p.muted} size={13} /> : null}
      </FlexWidget>
    </FlexWidget>
  );
}

/** Row height used to decide how many rows fit. */
export const MAIL_ROW_HEIGHT = { compact: 45, full: 76 };

/** The agenda's day band: "Today" in the accent, other days in the foreground. */
export function DayBand({ p, f, dayStart, now }: { p: WidgetPalette; f: Fmt; dayStart: number; now: number }) {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((dayStart - today.getTime()) / 86400000);
  const label = diff === 0
    ? f.t('widgets.calendar.today', 'Today')
    : diff === 1
      ? f.t('widgets.calendar.tomorrow', 'Tomorrow')
      : f.weekdayLong(dayStart);
  return (
    <FlexWidget
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        width: 'match_parent',
        height: 28,
        paddingHorizontal: 14,
        backgroundColor: p.dayHeader,
        borderBottomWidth: 1,
        borderBottomColor: p.border,
      }}
    >
      <Txt text={label} color={diff === 0 ? p.today : p.fg} size={13} weight="600" />
      <Spacer size={8} horizontal />
      <Txt text={f.dayMonth(dayStart)} color={p.muted} size={12} />
    </FlexWidget>
  );
}

/** Agenda event row: start/end column, colour bar, title and place. */
export function AgendaRow({ p, f, e, last }: { p: WidgetPalette; f: Fmt; e: EventItem; last?: boolean }) {
  const meta = e.videoUrl
    ? { icon: 'video' as const, text: e.videoName || f.t('widgets.calendar.video_call', 'Video call') }
    : e.location
      ? { icon: 'mapPin' as const, text: e.location }
      : null;
  const sub = [meta?.text, e.calendarName].filter(Boolean).join(' · ');
  return (
    <FlexWidget
      {...open(links.event(e))}
      style={{
        flexDirection: 'row',
        width: 'match_parent',
        paddingHorizontal: 14,
        paddingVertical: 7,
        borderBottomWidth: last ? 0 : 1,
        borderBottomColor: p.border,
      }}
    >
      <FlexWidget style={{ width: 44, alignItems: 'center' }}>
        {e.allDay ? (
          <Txt text={f.t('widgets.calendar.all_day', 'All day')} color={p.muted} size={12} />
        ) : (
          <FlexWidget style={{ alignItems: 'center' }}>
            <Txt text={f.time(e.start)} color={p.fg} size={13} weight="600" />
            <Txt text={f.time(e.end)} color={p.muted} size={11} />
          </FlexWidget>
        )}
      </FlexWidget>
      <Spacer size={8} horizontal />
      <ColorBar color={e.color} height={34} />
      <Spacer size={10} horizontal />
      <FlexWidget style={{ flex: 1 }}>
        <Txt text={e.title || f.t('widgets.calendar.untitled', '(no title)')} color={p.fg} size={14} weight="500" />
        {sub ? (
          <FlexWidget style={{ flexDirection: 'row', alignItems: 'center' }}>
            {meta ? <Icon name={meta.icon} color={p.muted} size={12} /> : null}
            {meta ? <Spacer size={4} horizontal /> : null}
            <Txt text={sub} color={p.muted} size={12} />
          </FlexWidget>
        ) : null}
      </FlexWidget>
    </FlexWidget>
  );
}

export const AGENDA_ROW_HEIGHT = 50;
export const DAY_BAND_HEIGHT = 28;

/** Task list row: round tick box that works in place, title, due label, calendar. */
export function TaskRow({
  p,
  f,
  task,
  now,
  last,
}: {
  p: WidgetPalette;
  f: Fmt;
  task: TaskItem;
  now: number;
  last?: boolean;
}) {
  const kind = dueKind(task, now);
  const dueColor = task.done
    ? p.muted
    : kind === 'overdue'
      ? p.overdue
      : kind === 'today'
        ? p.dueToday
        : p.muted;
  const dueLabel = task.due === undefined
    ? ''
    : kind === 'overdue'
      ? f.t('widgets.tasks.overdue', 'Overdue')
      : kind === 'today'
        ? f.t('widgets.tasks.today', 'Today')
        : kind === 'tomorrow'
          ? f.t('widgets.tasks.tomorrow', 'Tomorrow')
          : f.weekdayDayMonth(task.due);
  const toggle: WidgetClick = action('toggleTask', { id: task.id });
  return (
    <FlexWidget
      style={{
        flexDirection: 'row',
        width: 'match_parent',
        paddingHorizontal: 14,
        paddingVertical: 8,
        borderBottomWidth: last ? 0 : 1,
        borderBottomColor: p.border,
      }}
    >
      <FlexWidget
        {...toggle}
        accessibilityLabel={task.done ? f.t('widgets.tasks.mark_incomplete', 'Mark as not done') : f.t('widgets.tasks.mark_complete', 'Mark as done')}
        style={{
          width: 22,
          height: 22,
          borderRadius: 11,
          borderWidth: 2,
          borderColor: task.done ? p.success : (`${p.muted}66` as `#${string}`),
          backgroundColor: task.done ? p.success : p.bg,
          justifyContent: 'center',
          alignItems: 'center',
        }}
      >
        {task.done ? <Icon name="check" color="#ffffff" size={13} /> : null}
      </FlexWidget>
      <Spacer size={12} horizontal />
      <FlexWidget style={{ flex: 1 }}>
        <TextWidget
          text={task.title || f.t('widgets.tasks.no_title', '(no title)')}
          maxLines={1}
          truncate="END"
          style={{ color: task.done ? p.muted : p.fg, fontSize: 14, fontWeight: '500' }}
        />
        <FlexWidget style={{ flexDirection: 'row', alignItems: 'center' }}>
          {dueLabel ? <Icon name="calendarPlain" color={dueColor} size={12} /> : null}
          {dueLabel ? <Spacer size={4} horizontal /> : null}
          {dueLabel ? <Txt text={dueLabel} color={dueColor} size={12} /> : null}
          {dueLabel && task.calendarName ? <Spacer size={8} horizontal /> : null}
          {task.calendarName ? <Dot color={task.color as `#${string}`} size={8} /> : null}
          {task.calendarName ? <Spacer size={4} horizontal /> : null}
          {task.calendarName ? <Txt text={task.calendarName} color={p.muted} size={12} /> : null}
        </FlexWidget>
      </FlexWidget>
    </FlexWidget>
  );
}

export const TASK_ROW_HEIGHT = 55;
