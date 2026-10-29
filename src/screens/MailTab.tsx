import React from 'react';
import { StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Mail } from '../components/icons';

import EmailListScreen from './EmailListScreen';
import EmailThreadScreen from './EmailThreadScreen';
import SidebarDrawer, { DOCKED_WIDTH } from '../components/SidebarDrawer';
import type { RootStackParamList } from '../navigation/types';
import type { Email } from '../api/types';
import { useEmailStore, viewerParamsForRow } from '../stores/email-store';
import { useSettingsStore } from '../stores/settings-store';
import { useLocaleStore } from '../stores/locale-store';
import { mailboxAccountId } from '../lib/mailbox-tree';
import { prefetchMessage } from '../lib/email-detail-cache';
import { collapseThreads, rowKeyOf } from '../lib/thread-utils';
import { listPaneWidth, useLayout } from '../lib/use-layout';
import { useColors } from '../theme/colors';
import { spacing, typography, type ThemePalette } from '../theme/tokens';

type ThreadParams = RootStackParamList['EmailThread'];
type RootNav = NativeStackNavigationProp<RootStackParamList, 'MainTabs'>;

/** What the detail pane shows: the route params plus the row it came from. */
interface OpenMessage {
  params: ThreadParams;
  rowKey: string;
  /** Position of the row in the list when it was opened. */
  index: number;
}

function threadParamsFor(email: Email): ThreadParams {
  // The list holds the open folder's mail: name its account so the viewer
  // never has to guess it from whatever folder is open.
  const { mailboxes, currentMailboxId } = useEmailStore.getState();
  return {
    emailId: email.id,
    threadId: email.threadId,
    subject: email.subject,
    jmapAccountId: mailboxAccountId(mailboxes, currentMailboxId),
    // A row of an "All folders" list or a tag view names its own account
    // instead, and pages over that account's rows.
    ...viewerParamsForRow(email),
  };
}

function visibleRows(): Email[] {
  return collapseThreads(useEmailStore.getState().emails, useSettingsStore.getState().disableThreading);
}

/**
 * The Mail tab. On a phone it is the list, and a message opens on the stack.
 * On a wide window (`useLayout().isSplit`) the message opens in a pane next
 * to the list, and on the widest the folder list is a permanent sidebar; the
 * same viewer screen runs in the pane with a navigation that keeps it there.
 */
export default function MailTab({ navigation }: { navigation: RootNav }) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const layout = useLayout();
  const { width } = useWindowDimensions();
  const [open, setOpen] = React.useState<OpenMessage | null>(null);
  // The pager in the pane can move to another message; the list follows it.
  const [activeKey, setActiveKey] = React.useState<string | null>(null);

  const openEmail = React.useCallback((email: Email) => {
    const params = threadParamsFor(email);
    // Start on the body now: mounting the viewer takes a while.
    prefetchMessage(email, params.jmapAccountId);
    if (!layout.isSplit) {
      navigation.navigate('EmailThread', params);
      return;
    }
    const key = rowKeyOf(email);
    const index = Math.max(0, visibleRows().findIndex((e) => rowKeyOf(e) === key));
    setOpen({ params, rowKey: key, index });
    setActiveKey(key);
  }, [layout.isSplit, navigation]);

  // The window got narrow (split-screen, a fold) with a message open: carry
  // it over to the stack so it stays on screen.
  const openRef = React.useRef(open);
  openRef.current = open;
  React.useEffect(() => {
    if (layout.isSplit || !openRef.current) return;
    navigation.navigate('EmailThread', openRef.current.params);
    setOpen(null);
    setActiveKey(null);
  }, [layout.isSplit, navigation]);

  // Another folder: its list has nothing to do with the message on show.
  const currentMailboxId = useEmailStore((s) => s.currentMailboxId);
  React.useEffect(() => {
    setOpen(null);
    setActiveKey(null);
  }, [currentMailboxId]);

  // A message that moved out of the list (deleted, archived, moved, marked
  // spam) leaves the pane to the row that took its place, as Apple Mail does.
  const showNextAfterRemoval = React.useCallback(() => {
    const current = openRef.current;
    if (!current) return;
    const rows = visibleRows();
    const next = rows[Math.min(current.index, rows.length - 1)];
    if (!next || rowKeyOf(next) === current.rowKey) {
      setOpen(null);
      setActiveKey(null);
      return;
    }
    openEmail(next);
  }, [openEmail]);

  // The viewer drives its stack through `goBack` / `navigate`; in the pane
  // `goBack` means "this message is done" and other routes go to the stack.
  const paneNavigation = React.useMemo(() => ({
    ...navigation,
    goBack: showNextAfterRemoval,
    navigate: (...args: unknown[]) => {
      const [name, params] = args as [unknown, ThreadParams | undefined];
      if (name === 'EmailThread' && params) {
        setOpen({ params, rowKey: params.emailId, index: openRef.current?.index ?? 0 });
        return;
      }
      (navigation.navigate as (...a: unknown[]) => void)(...args);
    },
  }), [navigation, showNextAfterRemoval]);

  const onActiveChange = React.useCallback((id: string) => {
    const row = useEmailStore.getState().emails.find((e) => e.id === id);
    setActiveKey(row ? rowKeyOf(row) : id);
  }, []);

  const list = (
    <EmailListScreen
      onComposePress={() => navigation.navigate('Compose')}
      onEmailPress={openEmail}
      activeRowKey={layout.isSplit ? activeKey : null}
      sidebarDocked={layout.hasSidebar}
    />
  );
  if (!layout.isSplit) return list;

  const listWidth = listPaneWidth(width - (layout.hasSidebar ? DOCKED_WIDTH : 0));
  return (
    <View style={styles.row}>
      {layout.hasSidebar && <SidebarDrawer docked visible onClose={noop} />}
      <View style={[styles.listPane, { width: listWidth }]}>{list}</View>
      <View style={styles.detailPane}>
        {open ? (
          <EmailThreadScreen
            route={{ key: 'mail-pane', name: 'EmailThread', params: open.params }}
            navigation={paneNavigation as unknown as React.ComponentProps<typeof EmailThreadScreen>['navigation']}
            embedded
            onActiveChange={onActiveChange}
          />
        ) : (
          <View style={styles.empty}>
            <Mail size={40} color={c.textMuted} strokeWidth={1.5} />
            <Text style={styles.emptyTitle}>{t('email_viewer.no_email_selected', 'No email selected')}</Text>
            <Text style={styles.emptyText}>
              {t('email_viewer.no_email_description', 'Select an email from the list to view it here')}
            </Text>
          </View>
        )}
      </View>
    </View>
  );
}

function noop() {}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    row: { flex: 1, flexDirection: 'row', backgroundColor: c.background },
    listPane: { borderRightWidth: 1, borderRightColor: c.border },
    detailPane: { flex: 1 },
    empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.sm, padding: spacing.xl },
    emptyTitle: { ...typography.bodySemibold, color: c.text, marginTop: spacing.sm },
    emptyText: { ...typography.body, color: c.textMuted, textAlign: 'center' },
  });
}
