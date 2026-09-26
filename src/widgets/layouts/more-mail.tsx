// Board "More ways into mail": the unified inbox across accounts, starred
// mail, favourite people, search, scheduled sends and the offline outbox, the
// busiest tag and the last draft.

import React from 'react';
import { FlexWidget, TextWidget, type ColorProp } from 'react-native-android-widget';
import { links, open, type WidgetClick } from '../clicks';
import { daysUntil } from '../derive';
import type { Fmt } from '../format';
import { MAIL_ROW_HEIGHT, MailRow } from '../parts';
import {
  Avatar,
  Button,
  Divider,
  Dot,
  FilledIcon,
  Header,
  Icon,
  Overlay,
  Pill,
  Placeholder,
  Spacer,
  Surface,
  Txt,
} from '../primitives';
import type { AccountSummary, Person, ScheduledItem } from '../snapshot';
import { normalizeHex, type WidgetPalette } from '../theme';
import type { Layout } from './types';

/**
 * Rough rendered width of a line of text in dp. Widgets cannot measure text,
 * so chips and header pills are budgeted with this (a glyph averages a bit
 * over half the font size; erring wide keeps the last chip from clipping).
 */
function textWidth(text: string, size: number): number {
  return Math.ceil(text.length * size * 0.58);
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;
}

/** `border-sky-500/20`-style edge for a tinted pill: the tint's colour at 20%. */
function tintEdge(tint: ColorProp): ColorProp {
  const m = /^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,/.exec(tint);
  return m ? (`rgba(${m[1]}, ${m[2]}, ${m[3]}, 0.2)` as ColorProp) : tint;
}

/** Header rule like `Header`, for a leading glyph that is not an outline icon (the filled star). */
function LeadHeader({
  p,
  lead,
  title,
  count,
  height,
  click,
}: {
  p: WidgetPalette;
  lead: React.ReactNode;
  title: string;
  count?: string;
  height: number;
  click?: WidgetClick;
}) {
  return (
    <FlexWidget style={{ width: 'match_parent' }}>
      <FlexWidget
        {...click}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          width: 'match_parent',
          height,
          paddingLeft: 14,
          paddingRight: 8,
        }}
      >
        {lead}
        <Spacer size={8} horizontal />
        <Txt text={title} color={p.fg} size={14} weight="600" />
        {count ? <Spacer size={8} horizontal /> : null}
        {count ? <Txt text={count} color={p.muted} size={12} /> : null}
      </FlexWidget>
      <Divider p={p} />
    </FlexWidget>
  );
}

// ── All accounts ─────────────────────────────────────────────────────────

/** Opens the Mail tab on one account's inbox (`?account=` switches to it first). */
function accountInbox(accountId: string): string {
  return `${links.inbox()}?account=${encodeURIComponent(accountId)}`;
}

function accountChipLabel(a: AccountSummary): string {
  const label = clip(a.label, 12);
  return a.unread > 0 ? `${label} ${a.unread}` : label;
}

/** `rounded-full bg-muted px-2 py-0.5 text-[11px]` with the account dot. */
function AccountChip({ p, a }: { p: WidgetPalette; a: AccountSummary }) {
  return (
    <FlexWidget
      {...open(accountInbox(a.id))}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: p.mutedBg,
        borderRadius: 999,
        paddingHorizontal: 8,
        paddingVertical: 2,
      }}
    >
      <Dot color={normalizeHex(a.color)} size={8} />
      <Spacer size={5} horizontal />
      <TextWidget text={accountChipLabel(a)} maxLines={1} style={{ color: p.muted, fontSize: 11, fontWeight: '500' }} />
    </FlexWidget>
  );
}

/** As many account chips as fit next to the title, then "+N" for the rest. */
function fitAccountChips(accounts: AccountSummary[], budget: number): { shown: AccountSummary[]; hidden: number } {
  const chipWidth = (a: AccountSummary) => 8 + 8 + 5 + textWidth(accountChipLabel(a), 11) + 8;
  const moreWidth = (n: number) => 16 + textWidth(`+${n}`, 11);
  const shown: AccountSummary[] = [];
  let used = 0;
  for (let i = 0; i < accounts.length; i++) {
    const width = chipWidth(accounts[i]) + (shown.length ? 6 : 0);
    const rest = accounts.length - i - 1;
    const reserve = rest > 0 ? 6 + moreWidth(rest) : 0;
    if (used + width + reserve > budget) break;
    used += width;
    shown.push(accounts[i]);
  }
  const hidden = accounts.length - shown.length;
  const room = budget - used - (shown.length ? 6 : 0);
  return { shown, hidden: hidden > 0 && moreWidth(hidden) <= room ? hidden : 0 };
}

export const AllAccountsLayout: Layout = ({ s, p, f, now, width, height }) => {
  const compact = height < 190;
  const headerHeight = compact ? 38 : 44;
  const rowHeight = compact ? MAIL_ROW_HEIGHT.compact : MAIL_ROW_HEIGHT.full;
  const rows = Math.max(1, Math.floor((height - headerHeight) / rowHeight));
  const items = s.mail.unified.slice(0, rows);
  const colors = new Map(s.accounts.map((a) => [a.id, normalizeHex(a.color)]));
  const title = f.t('widgets.mail.all_accounts', 'All accounts');
  // Frame, header padding, icon and gap, title, header right padding, the
  // chips' own right padding and a minimum gap before them.
  const budget = width - 2 - 14 - 16 - 8 - textWidth(title, 14) - 8 - 4 - 8;
  const { shown, hidden } = fitAccountChips(s.accounts, budget);
  return (
    <Surface p={p}>
      <Header
        p={p}
        height={headerHeight}
        iconName="inbox"
        iconColor={p.folder.inbox}
        title={title}
        click={open(links.unified())}
        trailing={(
          <FlexWidget style={{ flexDirection: 'row', alignItems: 'center', paddingRight: 4 }}>
            {shown.map((a, i) => (
              <FlexWidget key={a.id} style={{ flexDirection: 'row', alignItems: 'center' }}>
                {i > 0 ? <Spacer size={6} horizontal /> : null}
                <AccountChip p={p} a={a} />
              </FlexWidget>
            ))}
            {hidden > 0 && shown.length > 0 ? <Spacer size={6} horizontal /> : null}
            {hidden > 0 ? <Pill text={`+${hidden}`} bg={p.mutedBg} color={p.muted} /> : null}
          </FlexWidget>
        )}
      />
      {items.length === 0 ? (
        <Placeholder
          p={p}
          iconName="inbox"
          title={f.t('widgets.mail.empty_all_accounts', 'Your inboxes are empty')}
          click={open(links.unified())}
        />
      ) : (
        items.map((m, i) => (
          <MailRow
            key={`${m.accountId}:${m.id}`}
            p={p}
            f={f}
            m={m}
            now={now}
            compact={compact}
            showAccountDot
            accountColor={colors.get(m.accountId)}
            last={i === items.length - 1}
          />
        ))
      )}
    </Surface>
  );
};

// ── Starred ──────────────────────────────────────────────────────────────

export const StarredLayout: Layout = ({ s, p, f, now, height }) => {
  const compact = height < 190;
  const headerHeight = compact ? 38 : 44;
  const rowHeight = compact ? MAIL_ROW_HEIGHT.compact : MAIL_ROW_HEIGHT.full;
  const rows = Math.max(1, Math.floor((height - headerHeight) / rowHeight));
  const items = s.mail.starred.slice(0, rows);
  const count = Math.max(s.mail.starredCount, s.mail.starred.length);
  const click = open(links.unified({ view: 'starred' }));
  return (
    <Surface p={p}>
      <LeadHeader
        p={p}
        height={headerHeight}
        lead={<FilledIcon name="star" color={p.star} size={16} />}
        title={f.t('widgets.mail.starred', 'Starred')}
        count={count > 0 ? String(count) : undefined}
        click={click}
      />
      {items.length === 0 ? (
        <Placeholder
          p={p}
          iconName="star"
          title={f.t('widgets.mail.no_starred', 'No starred mail')}
          body={f.t('widgets.mail.no_starred_body', 'Star a message to keep it here.')}
          click={click}
        />
      ) : (
        // Every row is starred, so the per-row star would only repeat the header.
        items.map((m, i) => (
          <MailRow
            key={m.id}
            p={p}
            f={f}
            m={{ ...m, starred: false }}
            now={now}
            compact={compact}
            last={i === items.length - 1}
          />
        ))
      )}
    </Surface>
  );
};

// ── Favourite people ─────────────────────────────────────────────────────

/** "Sofia" for "Sofia Russo" (and for "Russo, Sofia"); the address's local part without a name. */
function givenName(person: Person): string {
  const name = person.name.trim();
  if (!name) return person.email.split('@')[0] || person.email;
  const comma = name.indexOf(',');
  const given = comma > 0 ? name.slice(comma + 1).trim() : name;
  return given.split(/\s+/)[0] || name;
}

/** The unread badge on an avatar: `bg-primary` pill with a ring in the surface colour. */
function UnreadBadge({ p, count, left }: { p: WidgetPalette; count: number; left: number }) {
  const text = count > 99 ? '99+' : String(count);
  const width = Math.max(20, 10 + text.length * 7);
  return (
    <FlexWidget
      style={{
        marginLeft: left - width,
        width,
        height: 20,
        borderRadius: 10,
        borderWidth: 2,
        borderColor: p.bg,
        backgroundColor: p.primary,
        justifyContent: 'center',
        alignItems: 'center',
      }}
    >
      <TextWidget text={text} allowFontScaling={false} style={{ color: p.primaryFg, fontSize: 11, fontWeight: '600' }} />
    </FlexWidget>
  );
}

function PersonTile({
  p,
  f,
  person,
  avatar,
  showTime,
  now,
}: {
  p: WidgetPalette;
  f: Fmt;
  person: Person;
  avatar: number;
  showTime: boolean;
  now: number;
}) {
  // The badge sits 3dp above and 5dp right of the avatar, as in the list's
  // avatar badges; the box leaves 5dp on both sides so the avatar stays centred.
  const unread = person.unread > 0;
  return (
    <FlexWidget
      {...open(links.search(person.email ? `from:${person.email}` : person.name))}
      style={{ flex: 1, width: 0, alignItems: 'center' }}
    >
      <Overlay style={{ width: avatar + 10, height: avatar + 3 }}>
        <FlexWidget style={{ marginLeft: 5, marginTop: 3 }}>
          <Avatar initials={person.initials} color={person.color} size={avatar} />
        </FlexWidget>
        {unread ? <UnreadBadge p={p} count={person.unread} left={avatar + 10} /> : null}
      </Overlay>
      <Spacer size={4} />
      <Txt text={givenName(person)} color={p.fg} size={12} weight="500" />
      {showTime ? <Spacer size={4} /> : null}
      {showTime ? (
        <Txt
          text={f.listDate(person.lastAt, now)}
          color={unread ? p.fg : p.muted}
          size={12}
          weight={unread ? '600' : '400'}
        />
      ) : null}
    </FlexWidget>
  );
}

export const FavouritePeopleLayout: Layout = ({ s, p, f, now, width, height }) => {
  const headerHeight = 38;
  const people = s.mail.favourites.slice(0, 4);
  const header = (
    <Header
      p={p}
      height={headerHeight}
      iconName="addressBook"
      iconColor={p.muted}
      title={f.t('widgets.people.favourites', 'Favourites')}
      click={open(links.contacts())}
    />
  );
  if (people.length === 0) {
    return (
      <Surface p={p}>
        {header}
        <Placeholder
          p={p}
          iconName="users"
          title={f.t('widgets.people.empty', 'No favourites yet')}
          body={f.t('widgets.people.empty_body', 'The people you hear from most show up here.')}
          click={open(links.contacts())}
        />
      </Surface>
    );
  }
  // Four equal columns (grid-cols-4 gap-2 px-3); the avatar shrinks to fit a
  // narrow widget, and the time line goes first when the widget is short.
  const body = height - 2 - headerHeight;
  const topPad = body >= 110 ? 14 : 8;
  const showTime = body - topPad >= 3 + 40 + 20 + 20;
  const column = (width - 2 - 24 - 8 * 3) / 4;
  const avatar = Math.max(
    24,
    Math.min(48, Math.floor(column - 10), body - topPad - 3 - 20 - (showTime ? 20 : 0)),
  );
  const cells: React.ReactNode[] = [];
  for (let i = 0; i < 4; i++) {
    if (i > 0) cells.push(<Spacer key={`gap-${i}`} size={8} horizontal />);
    const person = people[i];
    cells.push(
      person ? (
        <PersonTile
          key={`person-${i}`}
          p={p}
          f={f}
          person={person}
          avatar={avatar}
          showTime={showTime}
          now={now}
        />
      ) : (
        <FlexWidget key={`person-${i}`} style={{ flex: 1, width: 0 }} />
      ),
    );
  }
  return (
    <Surface p={p}>
      {header}
      <FlexWidget style={{ flexDirection: 'row', width: 'match_parent', paddingHorizontal: 12, paddingTop: topPad }}>
        {cells}
      </FlexWidget>
    </Surface>
  );
};

// ── Search ───────────────────────────────────────────────────────────────

const CHIP_HEIGHT = 26;
const CHIP_GAP = 6;
/** `px-2.5` on both sides plus the 1dp border. */
const CHIP_CHROME = 22;

interface SearchChip {
  label: string;
  query: string;
}

/** Lays recent searches out in wrapped rows (flex-wrap), dropping what does not fit. */
function packChips(queries: string[], maxWidth: number, maxRows: number): SearchChip[][] {
  const maxChars = Math.max(4, Math.floor((maxWidth - CHIP_CHROME) / (12 * 0.58)));
  const rows: SearchChip[][] = [];
  let row: SearchChip[] = [];
  let used = 0;
  for (const raw of queries) {
    if (rows.length >= maxRows) break;
    const query = raw.trim();
    if (!query) continue;
    const label = clip(query, maxChars);
    const width = CHIP_CHROME + textWidth(label, 12);
    if (row.length && used + CHIP_GAP + width > maxWidth) {
      rows.push(row);
      row = [];
      used = 0;
      if (rows.length >= maxRows) break;
    }
    used += (row.length ? CHIP_GAP : 0) + width;
    row.push({ label, query });
  }
  if (row.length && rows.length < maxRows) rows.push(row);
  return rows;
}

function SearchBar({ p, f, height }: { p: WidgetPalette; f: Fmt; height: number }) {
  return (
    <FlexWidget
      {...open(links.search())}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        width: 'match_parent',
        height,
        paddingHorizontal: 16,
        borderRadius: 999,
        backgroundColor: p.mutedBg,
      }}
    >
      <Icon name="search" color={p.muted} size={18} />
      <Spacer size={10} horizontal />
      <Txt text={f.t('widgets.search.placeholder', 'Search mail…')} color={p.muted} size={14} />
    </FlexWidget>
  );
}

export const MailSearchLayout: Layout = ({ s, p, f, width, height }) => {
  // Below the bar: 10 gap, the label (~16), 10 gap, then rows of chips.
  const room = height - 2 - 28 - 44 - 10 - 16 - 10;
  const maxRows = Math.floor((room + CHIP_GAP) / (CHIP_HEIGHT + CHIP_GAP));
  if (maxRows < 1) {
    // 4x1: only the bar.
    return (
      <Surface p={p} style={{ paddingHorizontal: 12, justifyContent: 'center' }}>
        <SearchBar p={p} f={f} height={Math.max(32, Math.min(44, height - 20))} />
      </Surface>
    );
  }
  const rows = packChips(s.mail.recentSearches, width - 2 - 28, maxRows);
  return (
    <Surface p={p} style={{ padding: 14 }}>
      <SearchBar p={p} f={f} height={44} />
      <Spacer size={10} />
      <Txt
        text={f.t('widgets.search.recent', 'Recent searches').toUpperCase()}
        color={p.muted}
        size={12}
        weight="500"
        style={{ letterSpacing: 0.05 }}
      />
      <Spacer size={10} />
      {rows.length === 0 ? (
        <Txt text={f.t('widgets.search.no_recent', 'Your recent searches show up here.')} color={p.muted} size={12} lines={maxRows > 1 ? 2 : 1} />
      ) : (
        rows.map((row, r) => (
          <FlexWidget key={`row-${r}`} style={{ flexDirection: 'row', width: 'match_parent', marginTop: r === 0 ? 0 : CHIP_GAP }}>
            {row.map((chip, i) => (
              <FlexWidget key={`${r}-${i}`} style={{ flexDirection: 'row' }}>
                {i > 0 ? <Spacer size={CHIP_GAP} horizontal /> : null}
                <FlexWidget
                  {...open(links.search(chip.query))}
                  style={{
                    borderRadius: 999,
                    borderWidth: 1,
                    borderColor: p.border,
                    paddingHorizontal: 10,
                    paddingVertical: 4,
                  }}
                >
                  <TextWidget text={chip.label} maxLines={1} style={{ color: p.fg, fontSize: 12 }} />
                </FlexWidget>
              </FlexWidget>
            ))}
          </FlexWidget>
        ))
      )}
    </Surface>
  );
};

// ── Scheduled and outbox ─────────────────────────────────────────────────

/** "Today, 08:00", "Tomorrow, 08:00", "Fri, 17:00", "Oct 3, 09:30". */
function sendAtLabel(f: Fmt, at: number, now: number): string {
  if (at <= now) return f.t('widgets.scheduled.sending', 'Sending now');
  const time = f.time(at);
  const days = daysUntil(at, now);
  if (days === 0) return f.t('widgets.scheduled.today_at', 'Today, {time}', { time });
  if (days === 1) return f.t('widgets.scheduled.tomorrow_at', 'Tomorrow, {time}', { time });
  const day = days < 7 ? f.weekdayShort(at) : f.dayMonth(at);
  return f.t('widgets.scheduled.day_at', '{day}, {time}', { day, time });
}

/** The app's scheduled-send label: `sky-500/10` pill, `sky-500/20` edge, clock icon. */
function SendAtPill({ p, text }: { p: WidgetPalette; text: string }) {
  return (
    <FlexWidget
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 8,
        paddingVertical: 1,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: tintEdge(p.scheduledBg),
        backgroundColor: p.scheduledBg,
      }}
    >
      <Icon name="calendarClock" color={p.scheduledText} size={12} />
      <Spacer size={4} horizontal />
      <TextWidget text={text} maxLines={1} style={{ color: p.scheduledText, fontSize: 11, fontWeight: '500' }} />
    </FlexWidget>
  );
}

function ScheduledRow({
  p,
  f,
  item,
  now,
  last,
}: {
  p: WidgetPalette;
  f: Fmt;
  item: ScheduledItem;
  now: number;
  last?: boolean;
}) {
  const to = item.to
    ? f.t('widgets.scheduled.to', 'To: {name}', { name: item.to })
    : f.t('widgets.scheduled.no_recipient', '(no recipient)');
  return (
    <FlexWidget
      {...open(links.scheduled())}
      style={{
        width: 'match_parent',
        paddingLeft: 14,
        paddingRight: 12,
        paddingVertical: 4,
        borderBottomWidth: last ? 0 : 1,
        borderBottomColor: p.border,
      }}
    >
      <FlexWidget style={{ flexDirection: 'row', alignItems: 'center', width: 'match_parent', height: 18 }}>
        <FlexWidget style={{ flex: 1 }}>
          <Txt text={to} color={p.muted} size={14} weight="500" />
        </FlexWidget>
        <Spacer size={6} horizontal />
        <SendAtPill p={p} text={sendAtLabel(f, item.sendAt, now)} />
      </FlexWidget>
      <Txt text={item.subject || f.t('widgets.mail.no_subject', '(no subject)')} color={p.subjectRead} size={13} />
    </FlexWidget>
  );
}

export const OutboxLayout: Layout = ({ s, p, f, now, width, height }) => {
  const headerHeight = height < 190 ? 38 : 44;
  const rows = Math.max(1, Math.floor((height - headerHeight) / MAIL_ROW_HEIGHT.compact));
  const scheduled = [...s.mail.scheduled].sort((a, b) => a.sendAt - b.sendAt);
  const items = scheduled.slice(0, rows);
  const pending = s.mail.pendingChanges;
  const click = open(links.scheduled());
  const title = f.t('widgets.mail.scheduled', 'Scheduled');
  const count = scheduled.length > 0 ? String(scheduled.length) : undefined;

  let pill: string | null = null;
  if (pending > 0) {
    const room = width - 2 - 14 - 16 - 8 - textWidth(title, 14) - (count ? 6 + textWidth(count, 12) : 0) - 8 - 12;
    const long = f.t('widgets.mail.in_outbox', '{count, plural, one {# change waiting} other {# changes waiting}}', { count: pending });
    pill = 16 + textWidth(long, 11) <= room
      ? long
      : f.t('widgets.mail.in_outbox_short', '{count} waiting', { count: pending });
  }

  return (
    <Surface p={p}>
      <Header
        p={p}
        height={headerHeight}
        iconName="calendarClock"
        iconColor={p.folder.scheduled}
        title={title}
        count={count}
        click={click}
        trailing={pill ? (
          <FlexWidget style={{ paddingRight: 4 }}>
            <Pill text={pill} bg={p.warningBg} color={p.warningText} />
          </FlexWidget>
        ) : undefined}
      />
      {items.length > 0 ? (
        items.map((item, i) => (
          <ScheduledRow key={item.id} p={p} f={f} item={item} now={now} last={i === items.length - 1} />
        ))
      ) : pending > 0 ? (
        <Placeholder
          p={p}
          iconName="refresh"
          title={f.t('widgets.scheduled.waiting', 'Waiting for network')}
          body={f.t('widgets.scheduled.waiting_body', 'Changes you made offline go out when you are back online.')}
          click={click}
        />
      ) : (
        <Placeholder
          p={p}
          iconName="calendarClock"
          title={f.t('widgets.scheduled.empty', 'Nothing scheduled')}
          body={f.t('widgets.scheduled.empty_body', 'Messages you schedule to send later show up here.')}
          click={click}
        />
      )}
    </Surface>
  );
};

// ── Tag ──────────────────────────────────────────────────────────────────

export const TagLayout: Layout = ({ s, p, f, now }) => {
  // Tags come sorted busiest first (most unread, then most messages).
  const tag = s.mail.tags[0];
  if (!tag) {
    return (
      <Surface p={p}>
        <Placeholder
          p={p}
          iconName="tag"
          title={f.t('widgets.tag.empty', 'No tags yet')}
          body={f.t('widgets.tag.empty_body', 'Tags you add in the app show up here.')}
          click={open(links.inbox())}
        />
      </Surface>
    );
  }
  const count = tag.unread > 0 ? tag.unread : tag.total;
  const label = tag.unread > 0
    ? f.t('widgets.mail.unread', 'unread')
    : f.t('widgets.tag.messages', '{count, plural, one {message} other {messages}}', { count });
  const latest = tag.latestFrom
    ? [tag.latestFrom, tag.latestAt ? f.listDate(tag.latestAt, now) : ''].filter(Boolean).join(' · ')
    : f.t('widgets.tag.total', '{count, plural, one {# message} other {# messages}}', { count: tag.total });
  return (
    <Surface p={p} style={{ padding: 14, justifyContent: 'space-between' }} click={open(links.inbox())}>
      <FlexWidget style={{ flexDirection: 'row', alignItems: 'center', width: 'match_parent' }}>
        <FilledIcon name="tag" color={normalizeHex(tag.color)} size={16} />
        <Spacer size={8} horizontal />
        <FlexWidget style={{ flex: 1 }}>
          <Txt text={tag.name} color={p.fg} size={14} weight="500" />
        </FlexWidget>
      </FlexWidget>
      <FlexWidget>
        <TextWidget text={String(count)} style={{ color: p.fg, fontSize: 44, fontWeight: '700' }} />
        <Txt text={label} color={p.muted} size={13} />
      </FlexWidget>
      <Txt text={latest} color={p.muted} size={12} />
    </Surface>
  );
};

// ── Last draft ───────────────────────────────────────────────────────────

function editedLabel(f: Fmt, at: number, now: number): string {
  const minutes = Math.floor((now - at) / 60000);
  if (minutes < 1) return f.t('widgets.draft.edited_now', 'Edited just now');
  if (minutes < 60) {
    return f.t('widgets.draft.edited_minutes', '{count, plural, one {Edited # min ago} other {Edited # min ago}}', { count: minutes });
  }
  return f.t('widgets.draft.edited_at', 'Edited {when}', { when: f.listDate(at, now) });
}

export const LastDraftLayout: Layout = ({ s, p, f, now, height }) => {
  const draft = s.mail.drafts[0];
  if (!draft) {
    return (
      <Surface p={p}>
        <Placeholder
          p={p}
          iconName="file"
          title={f.t('widgets.draft.empty', 'No drafts')}
          body={f.t('widgets.draft.empty_body', 'Messages you start and do not send wait here.')}
          click={open(links.compose())}
        />
      </Surface>
    );
  }
  const count = Math.max(s.mail.draftCount, s.mail.drafts.length);
  const resume = open(links.draft(draft));
  return (
    <Surface p={p} style={{ padding: 14 }} click={resume}>
      <FlexWidget
        {...open(links.unified({ role: 'drafts' }))}
        style={{ flexDirection: 'row', alignItems: 'center', width: 'match_parent' }}
      >
        <Icon name="file" color={p.folder.drafts} size={16} />
        <Spacer size={8} horizontal />
        <Txt text={f.t('widgets.draft.title', 'Drafts')} color={p.fg} size={14} weight="500" />
        {count > 0 ? <Spacer size={8} horizontal /> : null}
        {count > 0 ? <Txt text={String(count)} color={p.muted} size={12} /> : null}
      </FlexWidget>
      <Spacer size={6} />
      <Txt
        text={draft.subject || f.t('widgets.mail.no_subject', '(no subject)')}
        color={p.fg}
        size={14}
        weight="600"
        lines={height >= 150 ? 2 : 1}
      />
      <Spacer size={6} />
      <Txt text={editedLabel(f, draft.receivedAt, now)} color={p.muted} size={12} />
      <Spacer />
      <FlexWidget style={{ flexDirection: 'row', width: 'match_parent' }}>
        <Button p={p} label={f.t('widgets.draft.keep_writing', 'Keep writing')} flex={1} click={resume} />
      </FlexWidget>
    </Surface>
  );
};
