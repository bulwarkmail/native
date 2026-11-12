import React from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';

import EmailListScreen from './EmailListScreen';
import MessagePane from '../components/MessagePane';
import SidebarDrawer, { DOCKED_WIDTH } from '../components/SidebarDrawer';
import type { RootStackParamList } from '../navigation/types';
import type { Email } from '../api/types';
import { useEmailStore, viewerParamsForRow } from '../stores/email-store';
import { useSettingsStore } from '../stores/settings-store';
import { mailboxAccountId } from '../lib/mailbox-tree';
import { prefetchMessage } from '../lib/email-detail-cache';
import { collapseThreads, rowKeyOf } from '../lib/thread-utils';
import { listPaneWidth, mailLayoutFor, useLayout } from '../lib/use-layout';
import { rowAfterRemoval, useMessagePane, type ThreadParams } from '../lib/use-message-pane';
import { useColors } from '../theme/colors';
import type { ThemePalette } from '../theme/tokens';

type RootNav = NativeStackNavigationProp<RootStackParamList, 'MainTabs'>;

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
  const windowLayout = useLayout();
  const layout = mailLayoutFor(windowLayout, useSettingsStore((s) => s.readingPane));
  const { width } = useWindowDimensions();
  const pane = useMessagePane(navigation, layout.isSplit, windowLayout.isSplit);
  const { show, close, openRef, setActiveKey } = pane;

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
    show({ params, rowKey: key, index });
  }, [layout.isSplit, navigation, show]);

  // Another folder: its list has nothing to do with the message on show.
  const currentMailboxId = useEmailStore((s) => s.currentMailboxId);
  React.useEffect(() => {
    close();
  }, [currentMailboxId, close]);

  // A message that moved out of the list (deleted, archived, moved, marked
  // spam) leaves the pane to the row that took its place, as Apple Mail does.
  const showNextAfterRemoval = React.useCallback(() => {
    const current = openRef.current;
    if (!current) return;
    const next = rowAfterRemoval(visibleRows(), current, rowKeyOf);
    if (next) openEmail(next);
    else close();
  }, [openRef, openEmail, close]);

  const onActiveChange = React.useCallback((id: string) => {
    const row = useEmailStore.getState().emails.find((e) => e.id === id);
    setActiveKey(row ? rowKeyOf(row) : id);
  }, [setActiveKey]);

  const list = (
    <EmailListScreen
      onComposePress={() => navigation.navigate('Compose')}
      onEmailPress={openEmail}
      activeRowKey={layout.isSplit ? pane.activeKey : null}
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
        <MessagePane
          message={pane.open}
          navigation={navigation}
          onRemoved={showNextAfterRemoval}
          onReplace={pane.replace}
          onActiveChange={onActiveChange}
        />
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
  });
}
