// Board 1, "Mail at a glance": inbox list, triage card, unread count, latest
// message, folder counts and shortcuts.

import React from 'react';
import { FlexWidget, TextWidget } from 'react-native-android-widget';
import { action, links, open } from '../clicks';
import { MAIL_ROW_HEIGHT, MailRow } from '../parts';
import {
  Avatar,
  Button,
  Fab,
  GhostIcon,
  Header,
  Icon,
  Placeholder,
  Spacer,
  Surface,
  Txt,
} from '../primitives';
import type { FolderCount } from '../snapshot';
import type { IconName } from '../icons';
import type { WidgetPalette } from '../theme';
import type { Layout } from './types';

function inboxCounts(s: Parameters<Layout>[0]['s']) {
  const inbox = s.mail.folders.find((f) => f.role === 'inbox');
  return { unread: inbox?.unread ?? 0, total: inbox?.total ?? 0 };
}

function CountText({ p, unread, total }: { p: WidgetPalette; unread: number; total: number }) {
  return (
    <FlexWidget style={{ flexDirection: 'row', alignItems: 'center' }}>
      <Txt text={String(unread)} color={p.fg} size={12} weight="600" />
      <Txt text={` / ${total}`} color={p.muted} size={12} />
    </FlexWidget>
  );
}

export const InboxLayout: Layout = ({ s, p, f, now, height }) => {
  const compact = height < 190;
  const headerHeight = compact ? 38 : 44;
  const rowHeight = compact ? MAIL_ROW_HEIGHT.compact : MAIL_ROW_HEIGHT.full;
  const rows = Math.max(1, Math.floor((height - headerHeight) / rowHeight));
  const items = s.mail.inbox.slice(0, rows);
  const { unread, total } = inboxCounts(s);
  return (
    <Surface p={p}>
      <Header
        p={p}
        height={headerHeight}
        iconName="inbox"
        iconColor={p.folder.inbox}
        title={f.t('widgets.mail.inbox', 'Inbox')}
        click={open(links.inbox())}
        trailing={(
          <FlexWidget style={{ flexDirection: 'row', alignItems: 'center' }}>
            <CountText p={p} unread={unread} total={total} />
            {compact ? null : <GhostIcon p={p} iconName="search" click={open(links.search())} />}
            <Spacer size={6} horizontal />
            <Fab p={p} iconName="edit" size={compact ? 28 : 32} click={open(links.compose())} />
          </FlexWidget>
        )}
      />
      {items.length === 0 ? (
        <Placeholder p={p} iconName="inbox" title={f.t('widgets.mail.empty_inbox', 'Your inbox is empty')} click={open(links.inbox())} />
      ) : (
        items.map((m, i) => (
          <MailRow key={m.id} p={p} f={f} m={m} now={now} compact={compact} last={i === items.length - 1} />
        ))
      )}
    </Surface>
  );
};

export const TriageLayout: Layout = ({ s, p, f, now, widgetId, local }) => {
  const candidates = s.mail.inbox.filter((m) => m.unread);
  const current = candidates.find((m) => m.id === local.triageId) ?? candidates[0];
  const { unread } = inboxCounts(s);
  if (!current) {
    return (
      <Surface p={p}>
        <Placeholder
          p={p}
          iconName="check"
          title={f.t('widgets.mail.all_caught_up', 'All caught up')}
          body={f.t('widgets.mail.no_unread', 'No unread messages in your inbox.')}
          click={open(links.inbox())}
        />
      </Surface>
    );
  }
  const position = candidates.indexOf(current) + 1;
  const target = { id: current.id, accountId: current.accountId, jmapAccountId: current.jmapAccountId, widgetId };
  return (
    <Surface p={p} style={{ padding: 12 }}>
      <FlexWidget {...open(links.message(current))} style={{ width: 'match_parent', flex: 1 }}>
        <FlexWidget style={{ flexDirection: 'row', alignItems: 'center', width: 'match_parent' }}>
          <Avatar initials={current.initials} color={current.color} size={32} />
          <Spacer size={10} horizontal />
          <Txt text={current.fromName || current.fromEmail} color={p.fg} size={14} weight="700" />
          <Spacer size={6} horizontal />
          <Txt text={f.listDate(current.receivedAt, now)} color={p.fg} size={12} weight="600" />
          <Spacer />
          <Txt
            text={f.t('widgets.mail.position', '{index} of {count}', { index: position, count: Math.max(unread, candidates.length) })}
            color={p.muted}
            size={12}
          />
        </FlexWidget>
        <Spacer size={6} />
        <Txt text={current.subject || f.t('widgets.mail.no_subject', '(no subject)')} color={p.fg} size={14} weight="600" />
        {current.preview ? <Txt text={current.preview} color={p.muted} size={13} lines={2} /> : null}
      </FlexWidget>
      <Spacer size={8} />
      <FlexWidget style={{ flexDirection: 'row', width: 'match_parent' }}>
        <Button p={p} label={f.t('widgets.mail.archive', 'Archive')} iconName="archive" flex={1} click={action('archive', target)} />
        <Spacer size={6} horizontal />
        <Button p={p} label={f.t('widgets.mail.delete', 'Delete')} iconName="trash" flex={1} click={action('trash', target)} />
        <Spacer size={6} horizontal />
        <Button p={p} label={f.t('widgets.mail.reply', 'Reply')} iconName="reply" variant="primary" flex={1} click={open(links.reply(current))} />
        <Spacer size={6} horizontal />
        <Button p={p} iconName="chevronRight" click={action('triageNext', { widgetId, id: current.id })} />
      </FlexWidget>
    </Surface>
  );
};

export const UnreadCountLayout: Layout = ({ s, p, f }) => {
  const { unread, total } = inboxCounts(s);
  const senders = s.mail.inbox.filter((m) => m.unread);
  const faces = senders.slice(0, 3);
  const more = Math.max(0, unread - faces.length);
  return (
    <Surface p={p} style={{ padding: 14, justifyContent: 'space-between' }} click={open(links.inbox())}>
      <FlexWidget style={{ flexDirection: 'row', alignItems: 'center' }}>
        <Icon name="inbox" color={p.folder.inbox} size={16} />
        <Spacer size={6} horizontal />
        <Txt text={f.t('widgets.mail.inbox', 'Inbox')} color={p.fg} size={14} weight="600" />
      </FlexWidget>
      <FlexWidget>
        <FlexWidget style={{ flexDirection: 'row', alignItems: 'flex-end' }}>
          <TextWidget text={String(unread)} style={{ color: p.fg, fontSize: 44, fontWeight: '700' }} />
          <Spacer size={4} horizontal />
          <TextWidget text={`/ ${total}`} style={{ color: p.muted, fontSize: 15, paddingBottom: 8 }} />
        </FlexWidget>
        <Txt text={f.t('widgets.mail.unread', 'unread')} color={p.muted} size={13} />
      </FlexWidget>
      <FlexWidget style={{ flexDirection: 'row', alignItems: 'center' }}>
        {faces.map((m, i) => (
          <FlexWidget key={m.id} style={{ marginLeft: i === 0 ? 0 : -8 }}>
            <Avatar initials={m.initials} color={m.color} size={24} ring={p.bg} />
          </FlexWidget>
        ))}
        {more > 0 ? <Spacer size={6} horizontal /> : null}
        {more > 0 ? <Txt text={`+${more}`} color={p.muted} size={12} /> : null}
      </FlexWidget>
    </Surface>
  );
};

export const LatestMessageLayout: Layout = ({ s, p, f, now }) => {
  const latest = s.mail.inbox.find((m) => m.unread);
  const { unread } = inboxCounts(s);
  if (!latest) {
    return (
      <Surface p={p}>
        <Placeholder p={p} iconName="check" title={f.t('widgets.mail.all_caught_up', 'All caught up')} click={open(links.inbox())} />
      </Surface>
    );
  }
  return (
    <Surface p={p} style={{ padding: 14, backgroundColor: p.unreadRow }} click={open(links.message(latest))}>
      <FlexWidget style={{ flexDirection: 'row', width: 'match_parent' }}>
        <Avatar initials={latest.initials} color={latest.color} size={40} />
        <Spacer />
        <Txt text={f.listDate(latest.receivedAt, now)} color={p.fg} size={12} weight="600" />
      </FlexWidget>
      <Spacer size={6} />
      <Txt text={latest.fromName || latest.fromEmail} color={p.fg} size={14} weight="700" />
      <Txt text={latest.subject || f.t('widgets.mail.no_subject', '(no subject)')} color={p.fg} size={14} weight="600" lines={2} />
      <Spacer />
      {unread > 1 ? (
        <Txt text={f.t('widgets.mail.more_unread', '+{count} more unread', { count: unread - 1 })} color={p.muted} size={12} />
      ) : null}
    </Surface>
  );
};

const FOLDER_ICON: Record<FolderCount['role'], IconName> = {
  inbox: 'inbox',
  drafts: 'file',
  sent: 'send',
  archive: 'archive',
  junk: 'ban',
  trash: 'trash',
  scheduled: 'calendarClock',
};

function folderLink(role: FolderCount['role']): string {
  if (role === 'inbox') return links.inbox();
  if (role === 'scheduled') return links.scheduled();
  return links.unified({ role });
}

export const FolderCountsLayout: Layout = ({ s, p, f, height }) => {
  const scheduled = s.mail.scheduled.length;
  const rows: Array<{ role: FolderCount['role']; name: string; count: number; strong: boolean }> = [];
  for (const role of ['inbox', 'drafts', 'scheduled', 'junk', 'archive', 'sent'] as const) {
    if (role === 'scheduled') {
      if (scheduled > 0) rows.push({ role, name: f.t('widgets.mail.scheduled', 'Scheduled'), count: scheduled, strong: false });
      continue;
    }
    const folder = s.mail.folders.find((x) => x.role === role);
    if (!folder) continue;
    const count = role === 'drafts' ? folder.total : folder.unread;
    rows.push({ role, name: folder.name, count, strong: role !== 'drafts' && folder.unread > 0 });
  }
  const fit = Math.max(1, Math.floor((height - 40) / 31));
  const colors: Record<FolderCount['role'], string> = {
    inbox: p.folder.inbox,
    drafts: p.folder.drafts,
    sent: p.folder.sent,
    archive: p.folder.archive,
    junk: p.folder.junk,
    trash: p.muted,
    scheduled: p.folder.scheduled,
  };
  return (
    <Surface p={p} style={{ paddingHorizontal: 12, paddingVertical: 8 }}>
      <FlexWidget style={{ height: 26, justifyContent: 'center' }}>
        <Txt text={f.t('widgets.mail.folders', 'Folders')} color={p.fg} size={14} weight="500" />
      </FlexWidget>
      {rows.slice(0, fit).map((row) => (
        <FlexWidget
          key={row.role}
          {...open(folderLink(row.role))}
          style={{ flexDirection: 'row', alignItems: 'center', height: 31, width: 'match_parent' }}
        >
          <Icon name={FOLDER_ICON[row.role]} color={colors[row.role]} size={16} />
          <Spacer size={10} horizontal />
          <FlexWidget style={{ flex: 1 }}>
            <Txt text={row.name} color={p.fg} size={14} />
          </FlexWidget>
          {row.count > 0 ? (
            <Txt text={String(row.count)} color={row.strong ? p.fg : p.muted} size={12} weight={row.strong ? '600' : '400'} />
          ) : null}
        </FlexWidget>
      ))}
    </Surface>
  );
};

export const MailShortcutsLayout: Layout = ({ p, f }) => {
  const tile = (key: string, icon: IconName, label: string, uri: string, primary = false) => (
    <FlexWidget
      key={key}
      {...open(uri)}
      style={{
        // A zero base width makes the weights split the row evenly instead
        // of only sharing out what the labels leave over.
        width: 0,
        flex: 1,
        height: 'match_parent',
        borderRadius: 8,
        backgroundColor: primary ? p.primary : p.bg,
        ...(primary ? {} : { borderWidth: 1, borderColor: p.input }),
        justifyContent: 'center',
        alignItems: 'center',
      }}
    >
      <Icon name={icon} color={primary ? p.primaryFg : p.fg} size={20} />
      <Spacer size={4} />
      <Txt text={label} color={primary ? p.primaryFg : p.fg} size={12} weight="500" />
    </FlexWidget>
  );
  return (
    <Surface p={p} style={{ padding: 10 }}>
      <FlexWidget style={{ flexDirection: 'row', flex: 1, width: 'match_parent' }}>
        {tile('compose', 'edit', f.t('widgets.shortcuts.compose', 'Compose'), links.compose(), true)}
        <Spacer size={8} horizontal />
        {tile('calendar', 'calendar', f.t('widgets.shortcuts.calendar', 'Calendar'), links.calendar())}
      </FlexWidget>
      <Spacer size={8} />
      <FlexWidget style={{ flexDirection: 'row', flex: 1, width: 'match_parent' }}>
        {tile('contacts', 'addressBook', f.t('widgets.shortcuts.contacts', 'Contacts'), links.contacts())}
        <Spacer size={8} horizontal />
        {tile('files', 'server', f.t('widgets.shortcuts.files', 'Files'), links.files())}
      </FlexWidget>
    </Surface>
  );
};
