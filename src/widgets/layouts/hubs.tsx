// Board 4, "Hubs and account": the whole day in one tile, mail next to the
// next event, recent files and mail attachments, and account status (the
// vacation responder switch and the quota ring).

import React from 'react';
import { FlexWidget, SvgWidget, TextWidget } from 'react-native-android-widget';
import { action, links, open, type WidgetClick } from '../clicks';
import { dueKind, nextEvent, sortTasks, tasksDueNow, upcomingTimed } from '../derive';
import { addDays, sameDay, startOfDay, type Fmt } from '../format';
import { ring, type IconName } from '../icons';
import { AGENDA_ROW_HEIGHT, AgendaRow, MAIL_ROW_HEIGHT, MailRow } from '../parts';
import {
  Divider,
  EventChip,
  GhostIcon,
  Header,
  Icon,
  Overlay,
  Pill,
  Placeholder,
  SectionLabel,
  Spacer,
  Surface,
  Txt,
  WIDGET_RADIUS,
} from '../primitives';
import type { AttachmentGroup, EventItem, FileItem, TaskItem, WidgetSnapshot } from '../snapshot';
import type { WidgetPalette } from '../theme';
import type { Layout } from './types';

// File-type colours of the webmail's file list and attachment chips. They are
// the same in both themes, like the Tailwind classes they copy.
const TYPE_COLOR = {
  folder: '#3b82f6',
  spreadsheet: '#16a34a',
  presentation: '#ea580c',
  image: '#8b5cf6',
  pdf: '#ef4444',
} as const;

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp', 'bmp', 'ico', 'avif', 'heic', 'heif']);
const SPREADSHEET_EXTENSIONS = new Set(['xls', 'xlsx', 'ods', 'numbers', 'csv', 'tsv']);
const PRESENTATION_EXTENSIONS = new Set(['ppt', 'pptx', 'odp', 'key']);

function extension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function inboxUnread(s: WidgetSnapshot): number {
  return s.mail.folders.find((x) => x.role === 'inbox')?.unread ?? 0;
}

/** Rough rendered width of a single line, for deciding what fits in a row. */
function textWidth(text: string, size: number, factor = 0.56): number {
  return Math.ceil(text.length * size * factor);
}

/** f.bytes without a trailing ".0" ("5 GB", not "5.0 GB"), as the webmail prints sizes. */
function size(f: Fmt, n: number): string {
  return f.bytes(n).replace(/\.0 /, ' ');
}

function capitalize(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

/** "Monday, Sep 28, 2026" in the app's language. */
function longDate(f: Fmt, ms: number): string {
  try {
    return new Intl.DateTimeFormat(f.locale, { weekday: 'long', year: 'numeric', month: 'short', day: 'numeric' })
      .format(new Date(ms));
  } catch {
    return `${f.weekdayLong(ms)}, ${f.fullDate(ms)}`;
  }
}

/** Short date, with the year only when it is not this year. */
function shortDate(f: Fmt, ms: number, now: number): string {
  return new Date(ms).getFullYear() === new Date(now).getFullYear() ? f.dayMonth(ms) : f.fullDate(ms);
}

/** Start time of an event, prefixed with the weekday when it is not today ("Tue 10:00"). */
function startLabel(f: Fmt, e: EventItem, now: number): string {
  return sameDay(e.start, now) ? f.time(e.start) : `${f.weekdayShort(e.start)} ${f.time(e.start)}`;
}

/* ------------------------------------------------------------------------ */
/* Today hub                                                                */
/* ------------------------------------------------------------------------ */

const HUB_HEADER_HEIGHT = 44;
/** SectionLabel: 11sp line plus 8 + 4 padding. */
const SECTION_LABEL_HEIGHT = 28;
const HUB_TASK_HEIGHT = 32;

/**
 * Tasks for the hub: open tasks that are overdue or due today (sorted like the
 * task list), then tasks ticked off that were due today, so a tick made from
 * the widget stays visible until the day moves on.
 */
function hubTasks(items: TaskItem[], now: number): { list: TaskItem[]; open: number } {
  const open = sortTasks(tasksDueNow(items.filter((t) => !t.done), now), now);
  const doneToday = items.filter((t) => t.done && t.due !== undefined && sameDay(t.due, now));
  return { list: [...open, ...doneToday], open: open.length };
}

function HubTaskLine({ p, f, task, now }: { p: WidgetPalette; f: Fmt; task: TaskItem; now: number }) {
  const kind = task.done ? 'today' : dueKind(task, now);
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
        : '';
  return (
    <FlexWidget
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        width: 'match_parent',
        height: HUB_TASK_HEIGHT,
        paddingLeft: 8,
        paddingRight: 14,
      }}
    >
      {/* 32dp touch target around the 20dp box, which sits at the 14dp inset. */}
      <FlexWidget
        {...action('toggleTask', { id: task.id })}
        accessibilityLabel={task.done ? f.t('widgets.tasks.mark_incomplete', 'Mark as not done') : f.t('widgets.tasks.mark_complete', 'Mark as done')}
        style={{ width: 32, height: 32, justifyContent: 'center', alignItems: 'center' }}
      >
        <FlexWidget
          style={{
            width: 20,
            height: 20,
            borderRadius: 10,
            borderWidth: 2,
            borderColor: task.done ? p.success : (`${p.muted}66` as `#${string}`),
            backgroundColor: task.done ? p.success : p.bg,
            justifyContent: 'center',
            alignItems: 'center',
          }}
        >
          {task.done ? <Icon name="check" color="#ffffff" size={12} /> : null}
        </FlexWidget>
      </FlexWidget>
      <Spacer size={6} horizontal />
      <FlexWidget style={{ flex: 1 }}>
        <Txt text={task.title || f.t('widgets.tasks.no_title', '(no title)')} color={task.done ? p.muted : p.fg} size={14} weight="500" />
      </FlexWidget>
      {dueLabel ? <Spacer size={8} horizontal /> : null}
      {dueLabel ? <Txt text={dueLabel} color={dueColor} size={12} /> : null}
    </FlexWidget>
  );
}

export const TodayHubLayout: Layout = ({ s, p, f, now, height }) => {
  const next = s.calendar.supported ? nextEvent(s.calendar.events, now) : null;
  const unreadMail = s.mail.inbox.filter((m) => m.unread);
  const unreadCount = Math.max(inboxUnread(s), unreadMail.length);
  const tasks = s.tasks.supported ? hubTasks(s.tasks.items, now) : { list: [], open: 0 };

  // Each section first gets its label and one row, in order; what is left
  // then goes to a second message and more tasks in turn.
  let budget = height - 2 - HUB_HEADER_HEIGHT;
  const nextCost = SECTION_LABEL_HEIGHT + AGENDA_ROW_HEIGHT;
  const showNext = !!next && budget >= nextCost;
  if (showNext) budget -= nextCost;
  let mailRows = 0;
  const mailCost = SECTION_LABEL_HEIGHT + 1 + MAIL_ROW_HEIGHT.compact;
  if (unreadMail.length > 0 && budget >= mailCost) {
    mailRows = 1;
    budget -= mailCost;
  }
  let taskRows = 0;
  const taskCost = SECTION_LABEL_HEIGHT + HUB_TASK_HEIGHT;
  if (tasks.open > 0 && budget >= taskCost) {
    taskRows = 1;
    budget -= taskCost;
  }
  const mailMax = Math.min(2, unreadMail.length);
  const taskMax = Math.min(3, tasks.list.length);
  let grew = true;
  while (grew) {
    grew = false;
    if (mailRows > 0 && mailRows < mailMax && budget >= MAIL_ROW_HEIGHT.compact) {
      mailRows++;
      budget -= MAIL_ROW_HEIGHT.compact;
      grew = true;
    }
    if (taskRows > 0 && taskRows < taskMax && budget >= HUB_TASK_HEIGHT) {
      taskRows++;
      budget -= HUB_TASK_HEIGHT;
      grew = true;
    }
  }

  let nextLabel = '';
  if (next) {
    const start = next.event.start;
    const tomorrow = sameDay(start, addDays(startOfDay(now), 1));
    nextLabel = next.running
      ? f.t('widgets.hub.now', 'Now')
      : sameDay(start, now)
        ? f.t('widgets.hub.next', 'Next')
        : f.t('widgets.hub.next_on', 'Next · {day}', {
          day: tomorrow ? f.t('widgets.calendar.tomorrow', 'Tomorrow') : f.weekdayDayMonth(start),
        });
  }
  const mail = unreadMail.slice(0, mailRows);
  const taskList = tasks.list.slice(0, taskRows);
  const empty = !showNext && mailRows === 0 && taskRows === 0;

  return (
    <Surface p={p}>
      <FlexWidget {...open(links.calendar())} style={{ width: 'match_parent' }}>
        <FlexWidget
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            width: 'match_parent',
            height: HUB_HEADER_HEIGHT - 1,
            paddingHorizontal: 14,
          }}
        >
          <Txt text={f.t('widgets.calendar.today', 'Today')} color={p.today} size={14} weight="600" />
          <Spacer size={8} horizontal />
          <FlexWidget style={{ flex: 1 }}>
            <Txt text={longDate(f, now)} color={p.muted} size={12} />
          </FlexWidget>
        </FlexWidget>
        <Divider p={p} />
      </FlexWidget>
      {empty ? (
        <Placeholder p={p} iconName="check" title={f.t('widgets.hub.all_clear', "You're all caught up")} click={open(links.calendar())} />
      ) : null}
      {showNext && next ? (
        <FlexWidget style={{ width: 'match_parent' }}>
          <FlexWidget {...open(links.calendar())} style={{ width: 'match_parent' }}>
            <SectionLabel p={p} text={nextLabel} />
          </FlexWidget>
          <AgendaRow p={p} f={f} e={next.event} last={mailRows === 0 && taskRows === 0} />
        </FlexWidget>
      ) : null}
      {mailRows > 0 ? (
        <FlexWidget style={{ width: 'match_parent' }}>
          <FlexWidget {...open(links.inbox())} style={{ width: 'match_parent' }}>
            <SectionLabel p={p} text={f.t('widgets.hub.mail_unread', 'Mail · {count} unread', { count: unreadCount })} />
          </FlexWidget>
          <Divider p={p} />
          {mail.map((m, i) => (
            <MailRow key={m.id} p={p} f={f} m={m} now={now} compact last={taskRows === 0 && i === mail.length - 1} />
          ))}
        </FlexWidget>
      ) : null}
      {taskRows > 0 ? (
        <FlexWidget style={{ width: 'match_parent' }}>
          <SectionLabel p={p} text={f.t('widgets.hub.tasks_due', 'Tasks · {count} due', { count: tasks.open })} />
          {taskList.map((task) => (
            <HubTaskLine key={task.id} p={p} f={f} task={task} now={now} />
          ))}
        </FlexWidget>
      ) : null}
    </Surface>
  );
};

/* ------------------------------------------------------------------------ */
/* Mail and next event                                                      */
/* ------------------------------------------------------------------------ */

export const MailAndNextLayout: Layout = ({ s, p, f, now, height }) => {
  const tight = height < 140;
  const pad = tight ? 10 : 14;
  const unreadMail = s.mail.inbox.filter((m) => m.unread);
  const unread = Math.max(inboxUnread(s), unreadMail.length);
  const latest = unreadMail[0];
  const digits = String(unread).length;
  const big = (tight ? 28 : 36) - (digits >= 4 ? 8 : 0);

  const upcoming = s.calendar.supported ? upcomingTimed(s.calendar.events, now) : [];
  const event = upcoming[0];
  const following = upcoming[1];
  const running = !!event && event.start <= now;
  const when = event ? (running ? f.t('widgets.hub.now', 'Now') : capitalize(f.relative(event.start, now))) : '';
  const range = event
    ? `${sameDay(event.start, now) ? '' : `${f.weekdayShort(event.start)} `}${f.time(event.start)} – ${f.time(event.end)}`
    : '';

  return (
    <Surface p={p} style={{ flexDirection: 'row' }}>
      <FlexWidget
        {...open(links.inbox())}
        style={{
          width: 0,
          flex: 1,
          height: 'match_parent',
          padding: pad,
          backgroundColor: unread > 0 ? p.unreadRow : p.bg,
          borderTopLeftRadius: WIDGET_RADIUS - 1,
          borderBottomLeftRadius: WIDGET_RADIUS - 1,
        }}
      >
        <FlexWidget style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Icon name="inbox" color={p.folder.inbox} size={16} />
          <Spacer size={6} horizontal />
          <Txt text={f.t('widgets.mail.inbox', 'Inbox')} color={p.fg} size={14} weight="600" />
        </FlexWidget>
        <FlexWidget style={{ flexDirection: 'row', alignItems: 'flex-end', marginTop: 4 }}>
          <TextWidget text={String(unread)} maxLines={1} style={{ color: p.fg, fontSize: big, fontWeight: '700' }} />
          <Spacer size={4} horizontal />
          {/* Lines the small label up with the big number's baseline. */}
          <Txt
            text={f.t('widgets.mail.unread', 'unread')}
            color={p.muted}
            size={13}
            style={{ paddingBottom: Math.round((big - 13) * 0.27) }}
          />
        </FlexWidget>
        <Spacer />
        {latest ? (
          <FlexWidget {...open(links.message(latest))} style={{ width: 'match_parent' }}>
            <Txt text={latest.fromName || latest.fromEmail} color={p.fg} size={14} weight="700" />
            <Txt text={latest.subject || f.t('widgets.mail.no_subject', '(no subject)')} color={p.fg} size={13} weight="600" />
          </FlexWidget>
        ) : (
          <Txt text={f.t('widgets.mail.all_caught_up', 'All caught up')} color={p.muted} size={13} />
        )}
      </FlexWidget>
      <FlexWidget style={{ width: 1, height: 'match_parent', backgroundColor: p.border }} />
      <FlexWidget
        {...open(event ? links.event(event) : links.calendar())}
        style={{ width: 0, flex: 1, height: 'match_parent', padding: pad }}
      >
        {event ? (
          <FlexWidget style={{ width: 'match_parent', flex: 1 }}>
            <FlexWidget style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Icon name="clock" color={p.today} size={14} />
              <Spacer size={5} horizontal />
              <Txt text={when} color={p.today} size={13} weight="600" />
            </FlexWidget>
            <Spacer size={tight ? 4 : 8} />
            <Txt
              text={event.title || f.t('widgets.calendar.untitled', '(no title)')}
              color={p.fg}
              size={15}
              weight="600"
              lines={following || tight ? 1 : 2}
            />
            <Txt text={range} color={p.muted} size={13} />
            <Spacer />
            {following ? (
              <EventChip
                title={following.title || f.t('widgets.calendar.untitled', '(no title)')}
                time={startLabel(f, following, now)}
                color={following.color}
                click={open(links.event(following))}
              />
            ) : null}
          </FlexWidget>
        ) : (
          <FlexWidget style={{ width: 'match_parent', flex: 1 }}>
            <Icon name="clock" color={p.muted} size={14} />
            <Spacer size={8} />
            <Txt text={f.t('widgets.hub.no_events', 'No upcoming events')} color={p.muted} size={13} lines={2} />
          </FlexWidget>
        )}
      </FlexWidget>
    </Surface>
  );
};

/* ------------------------------------------------------------------------ */
/* Recent files                                                             */
/* ------------------------------------------------------------------------ */

const FILE_ROW_HEIGHT = 42;
const FILE_ROW_MIN_HEIGHT = 34;

function fileIcon(item: FileItem, p: WidgetPalette): { name: IconName; color: string } {
  if (item.isFolder) return { name: 'folder', color: TYPE_COLOR.folder };
  const ext = extension(item.name);
  const type = item.type.toLowerCase();
  if (
    SPREADSHEET_EXTENSIONS.has(ext) ||
    type.includes('spreadsheet') ||
    type.includes('ms-excel') ||
    type === 'text/csv' ||
    type === 'text/tab-separated-values'
  ) {
    return { name: 'fileSpreadsheet', color: TYPE_COLOR.spreadsheet };
  }
  if (PRESENTATION_EXTENSIONS.has(ext) || type.includes('presentation') || type.includes('ms-powerpoint')) {
    return { name: 'presentation', color: TYPE_COLOR.presentation };
  }
  if (type.startsWith('image/') || IMAGE_EXTENSIONS.has(ext)) return { name: 'photo', color: TYPE_COLOR.image };
  return { name: 'fileText', color: p.muted };
}

export const RecentFilesLayout: Layout = ({ s, p, f, now, height }) => {
  if (!s.files.supported) {
    return (
      <Surface p={p}>
        <Placeholder p={p} iconName="server" title={f.t('widgets.files.unsupported', "Files aren't available on this server")} />
      </Surface>
    );
  }
  const header = (
    <Header
      p={p}
      iconName="server"
      title={f.t('widgets.shortcuts.files', 'Files')}
      count={f.t('widgets.files.recent', 'Recently changed')}
      click={open(links.files())}
      trailing={<GhostIcon p={p} iconName="upload" click={open(links.files())} />}
    />
  );
  const items = s.files.items;
  if (items.length === 0) {
    return (
      <Surface p={p}>
        {header}
        <Placeholder p={p} iconName="folder" title={f.t('widgets.files.empty', 'No files yet')} click={open(links.files())} />
      </Surface>
    );
  }
  // Rows share the space below the header, between 34 and 42dp each.
  const avail = height - 2 - 41;
  const count = Math.max(1, Math.min(items.length, Math.floor(avail / FILE_ROW_MIN_HEIGHT)));
  const rowHeight = Math.max(FILE_ROW_MIN_HEIGHT, Math.min(FILE_ROW_HEIGHT, Math.floor(avail / count)));
  const shown = items.slice(0, count);
  return (
    <Surface p={p}>
      {header}
      {shown.map((item, i) => {
        const kind = fileIcon(item, p);
        const date = item.modified > 0 ? shortDate(f, item.modified, now) : '';
        const meta = item.isFolder ? date : [size(f, item.size), date].filter(Boolean).join(' · ');
        return (
          <FlexWidget
            key={item.id}
            {...open(links.files())}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              width: 'match_parent',
              height: rowHeight,
              paddingHorizontal: 14,
              borderBottomWidth: i === shown.length - 1 ? 0 : 1,
              borderBottomColor: p.border,
            }}
          >
            <Icon name={kind.name} color={kind.color} size={18} />
            <Spacer size={12} horizontal />
            <FlexWidget style={{ flex: 1 }}>
              <Txt text={item.name} color={p.fg} size={14} />
            </FlexWidget>
            {meta ? <Spacer size={8} horizontal /> : null}
            {meta ? <Txt text={meta} color={p.muted} size={12} /> : null}
          </FlexWidget>
        );
      })}
    </Surface>
  );
};

/* ------------------------------------------------------------------------ */
/* Recent attachments                                                       */
/* ------------------------------------------------------------------------ */

type AttachmentFile = AttachmentGroup['files'][number];

interface AttachmentDensity {
  header: number;
  padTop: number;
  padBottom: number;
  gap: number;
  chip: number;
}

// Most comfortable first; the first one that shows the most groups wins.
const ATTACHMENT_DENSITIES: AttachmentDensity[] = [
  { header: 36, padTop: 6, padBottom: 6, gap: 4, chip: 28 },
  { header: 32, padTop: 3, padBottom: 4, gap: 3, chip: 28 },
  { header: 32, padTop: 3, padBottom: 3, gap: 2, chip: 24 },
];
const SENDER_LINE_HEIGHT = 18;
const CHIP_GAP = 6;

function groupHeight(d: AttachmentDensity): number {
  return d.padTop + SENDER_LINE_HEIGHT + d.gap + d.chip + d.padBottom + 1;
}

function attachmentIcon(file: AttachmentFile, p: WidgetPalette): { name: IconName; color: string } {
  const ext = extension(file.name);
  const type = file.type.toLowerCase();
  if (type === 'application/pdf' || ext === 'pdf') return { name: 'fileText', color: TYPE_COLOR.pdf };
  if (type.startsWith('image/') || IMAGE_EXTENSIONS.has(ext)) return { name: 'photo', color: TYPE_COLOR.image };
  return { name: 'file', color: p.muted };
}

/** Border, padding, icon and gap around the file name. */
const CHIP_CHROME = 2 + 16 + 14 + 6;

function moreChipWidth(rest: number): number {
  return rest > 0 ? CHIP_GAP + 2 + 16 + textWidth(`+${rest}`, 12, 0.6) : 0;
}

/**
 * The chips that fit on one line of `inner` dp, each at most about half the
 * widget, and how many files are left over for the "+N" chip.
 */
function fitChips(files: AttachmentFile[], inner: number) {
  const maxChip = Math.max(64, Math.floor(inner / 2) - CHIP_GAP / 2);
  const chips = files.map((file) => {
    const natural = CHIP_CHROME + textWidth(file.name, 12, 0.55);
    return { file, width: Math.min(natural, maxChip), fixed: natural > maxChip };
  });
  const total = (k: number) =>
    chips.slice(0, k).reduce((sum, c) => sum + c.width, 0) + CHIP_GAP * (k - 1) + moreChipWidth(chips.length - k);
  let k = chips.length;
  while (k > 1 && total(k) > inner) k--;
  const shown = chips.slice(0, k);
  if (total(k) > inner) {
    shown[0] = { ...shown[0], width: Math.max(48, inner - moreChipWidth(chips.length - 1)), fixed: true };
  }
  return { shown, more: chips.length - k };
}

function AttachmentChip({
  p,
  file,
  width,
  fixed,
  height,
}: {
  p: WidgetPalette;
  file: AttachmentFile;
  width: number;
  fixed: boolean;
  height: number;
}) {
  const kind = attachmentIcon(file, p);
  return (
    <FlexWidget
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        height,
        width: fixed ? width : 'wrap_content',
        paddingHorizontal: 8,
        borderWidth: 1,
        borderColor: p.border,
        borderRadius: 6,
      }}
    >
      <Icon name={kind.name} color={kind.color} size={14} />
      <Spacer size={6} horizontal />
      {fixed ? (
        <FlexWidget style={{ flex: 1 }}>
          <Txt text={file.name} color={p.fg} size={12} />
        </FlexWidget>
      ) : (
        <Txt text={file.name} color={p.fg} size={12} />
      )}
    </FlexWidget>
  );
}

export const AttachmentsLayout: Layout = ({ s, p, f, now, width, height }) => {
  const groups = s.mail.attachments;
  let density = ATTACHMENT_DENSITIES[0];
  let fit = 0;
  for (const d of ATTACHMENT_DENSITIES) {
    // The last group has no bottom rule, hence the + 1.
    const n = Math.min(groups.length, Math.floor((height - 2 - (d.header + 1) + 1) / groupHeight(d)));
    if (n > fit) {
      fit = n;
      density = d;
    }
  }
  const header = (
    <Header
      p={p}
      height={density.header}
      iconName="paperclip"
      title={f.t('widgets.attachments.title', 'Attachments')}
      count={f.t('widgets.attachments.from_mail', 'from mail')}
      click={open(links.inbox())}
    />
  );
  if (groups.length === 0) {
    return (
      <Surface p={p}>
        {header}
        <Placeholder p={p} iconName="paperclip" title={f.t('widgets.attachments.empty', 'No recent attachments')} click={open(links.inbox())} />
      </Surface>
    );
  }
  const shown = groups.slice(0, Math.max(1, fit));
  const inner = width - 2 - 28;
  return (
    <Surface p={p}>
      {header}
      {shown.map((g, i) => {
        const { shown: chips, more } = fitChips(g.files, inner);
        return (
          <FlexWidget
            key={g.emailId}
            {...open(links.message({ id: g.emailId, accountId: g.accountId }))}
            style={{
              width: 'match_parent',
              paddingHorizontal: 14,
              paddingTop: density.padTop,
              paddingBottom: density.padBottom,
              borderBottomWidth: i === shown.length - 1 ? 0 : 1,
              borderBottomColor: p.border,
            }}
          >
            <FlexWidget style={{ flexDirection: 'row', alignItems: 'center', width: 'match_parent', height: SENDER_LINE_HEIGHT }}>
              <FlexWidget style={{ flex: 1 }}>
                <Txt text={g.fromName || f.t('widgets.attachments.unknown_sender', 'Unknown sender')} color={p.fg} size={13} weight="600" />
              </FlexWidget>
              <Spacer size={6} horizontal />
              <Txt text={f.listDate(g.receivedAt, now)} color={p.muted} size={12} />
            </FlexWidget>
            <Spacer size={density.gap} />
            <FlexWidget style={{ flexDirection: 'row', alignItems: 'center', width: 'match_parent' }}>
              {chips.map((c, j) => (
                <FlexWidget key={`${j}:${c.file.name}`} style={{ flexDirection: 'row' }}>
                  {j > 0 ? <Spacer size={CHIP_GAP} horizontal /> : null}
                  <AttachmentChip p={p} file={c.file} width={c.width} fixed={c.fixed} height={density.chip} />
                </FlexWidget>
              ))}
              {more > 0 ? <Spacer size={CHIP_GAP} horizontal /> : null}
              {more > 0 ? (
                <FlexWidget
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    height: density.chip,
                    paddingHorizontal: 8,
                    borderWidth: 1,
                    borderColor: p.border,
                    borderRadius: 6,
                  }}
                >
                  <Txt text={`+${more}`} color={p.muted} size={12} />
                </FlexWidget>
              ) : null}
            </FlexWidget>
          </FlexWidget>
        );
      })}
    </Surface>
  );
};

/* ------------------------------------------------------------------------ */
/* Vacation responder                                                       */
/* ------------------------------------------------------------------------ */

/** The settings switch (`h-[22px] w-10 rounded-full`), drawn only; taps open settings. */
function Switch({ p, on, label, click }: { p: WidgetPalette; on: boolean; label: string; click: WidgetClick }) {
  return (
    <FlexWidget
      {...click}
      accessibilityLabel={label}
      style={{
        flexDirection: 'row',
        justifyContent: on ? 'flex-end' : 'flex-start',
        alignItems: 'center',
        width: 40,
        height: 22,
        padding: 2,
        borderRadius: 11,
        backgroundColor: on ? p.primary : p.mutedBg,
      }}
    >
      <FlexWidget style={{ width: 18, height: 18, borderRadius: 9, backgroundColor: on ? p.primaryFg : p.bg }} />
    </FlexWidget>
  );
}

export const VacationLayout: Layout = ({ s, p, f, width, height }) => {
  const click = open(links.settings('vacation'));
  const v = s.vacation;
  if (!v) {
    return (
      <Surface p={p}>
        <Placeholder p={p} iconName="beach" title={f.t('widgets.vacation.unsupported', "Vacation replies aren't available")} click={click} />
      </Surface>
    );
  }
  const title = f.t('widgets.vacation.title', 'Vacation Responder');
  const until = v.to ? f.t('widgets.vacation.until', 'Until {date}', { date: f.weekdayDayMonth(v.to) }) : '';
  const subject = v.subject ? f.t('widgets.vacation.subject', 'Subject: {subject}', { subject: v.subject }) : '';

  // Drop spacing first, then the subject, then the end date, until it fits.
  const pad = 14;
  const avail = height - 2 - 2 * pad;
  const titleLines = textWidth(title, 14, 0.58) > width - 2 - 2 * pad ? 2 : 1;
  // Switch row, title (~17dp a line plus font padding), status pill.
  const base = 22 + titleLines * 17 + 2 + 19;
  let gapTop = 12;
  let gapPill = 6;
  let showUntil = !!until;
  let showSubject = !!subject;
  const need = () => base + gapTop + gapPill + (showUntil ? 16 : 0) + (showSubject ? 16 : 0);
  if (need() > avail) {
    gapTop = 6;
    gapPill = 4;
  }
  if (need() > avail) showSubject = false;
  if (need() > avail) showUntil = false;

  return (
    <Surface p={p} style={{ padding: pad }} click={click}>
      <FlexWidget style={{ flexDirection: 'row', alignItems: 'center', width: 'match_parent' }}>
        <Icon name="beach" color={p.fg} size={20} />
        <Spacer />
        <Switch p={p} on={v.enabled} label={title} click={click} />
      </FlexWidget>
      <Spacer size={gapTop} />
      <Txt text={title} color={p.fg} size={14} weight="600" lines={titleLines} />
      <Spacer size={gapPill} />
      {v.enabled ? (
        <Pill text={f.t('widgets.vacation.active', 'Active')} bg={p.successBg} color={p.successText} />
      ) : (
        <Pill text={f.t('widgets.vacation.inactive', 'Inactive')} bg={p.mutedBg} color={p.muted} />
      )}
      <Spacer />
      {showUntil ? <Txt text={until} color={p.muted} size={12} /> : null}
      {showSubject ? <Txt text={subject} color={p.muted} size={12} /> : null}
    </Surface>
  );
};

/* ------------------------------------------------------------------------ */
/* Storage                                                                  */
/* ------------------------------------------------------------------------ */

function percent(f: Fmt, fraction: number): string {
  try {
    return new Intl.NumberFormat(f.locale, { style: 'percent', maximumFractionDigits: 0 }).format(fraction);
  } catch {
    return `${Math.round(fraction * 100)}%`;
  }
}

export const StorageLayout: Layout = ({ s, p, f, width, height }) => {
  const click = open(links.settings('account'));
  const q = s.quota;
  if (!q) {
    return (
      <Surface p={p}>
        <Placeholder p={p} iconName="server" title={f.t('widgets.storage.unavailable', 'No quota information')} click={click} />
      </Surface>
    );
  }
  const limited = q.limit > 0;
  const fraction = limited ? q.used / q.limit : 0;
  const fill = fraction > 0.9 ? p.destructive : p.success;

  const pad = 14;
  const gap = height < 165 ? 6 : 8;
  const titleHeight = 19;
  const captionHeight = 16;
  const ringSize = Math.max(
    40,
    Math.min(76, height - 2 - 2 * pad - titleHeight - captionHeight - 2 * gap, width - 2 - 2 * pad),
  );
  const centre = limited ? percent(f, fraction) : size(f, q.used);
  const centreSize = Math.max(11, Math.round(((limited ? 16 : 13) * ringSize) / 76));
  const caption = limited
    ? f.t('widgets.storage.used_of', '{used} of {total}', { used: size(f, q.used), total: size(f, q.limit) })
    : f.t('widgets.storage.no_limit', 'No storage limit');

  return (
    <Surface p={p} style={{ padding: pad, alignItems: 'center' }} click={click}>
      <FlexWidget style={{ width: 'match_parent' }}>
        <Txt text={f.t('widgets.storage.title', 'Storage')} color={p.fg} size={14} weight="600" />
      </FlexWidget>
      <Spacer />
      <Overlay style={{ width: ringSize, height: ringSize }}>
        {/* ring() draws on a 64 viewBox; stroke 5 is ~6dp at 76dp like the webmail ring. */}
        <SvgWidget svg={ring(fraction, p.mutedBg, fill, 5)} style={{ width: ringSize, height: ringSize }} />
        <FlexWidget style={{ width: ringSize, height: ringSize, justifyContent: 'center', alignItems: 'center' }}>
          <Txt text={centre} color={p.fg} size={centreSize} weight="700" />
        </FlexWidget>
      </Overlay>
      <Spacer size={gap} />
      <Txt text={caption} color={p.muted} size={12} />
      <Spacer />
    </Surface>
  );
};
