import React from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';

import EmailListScreen from './EmailListScreen';
import MessagePane from '../components/MessagePane';
import SidebarDrawer from '../components/SidebarDrawer';
import type { RootStackParamList } from '../navigation/types';
import type { Email } from '../api/types';
import { useEmailStore, viewerParamsForRow } from '../stores/email-store';
import { useSettingsStore } from '../stores/settings-store';
import { mailboxAccountId } from '../lib/mailbox-tree';
import { prefetchMessage } from '../lib/email-detail-cache';
import { collapseThreads, rowKeyOf } from '../lib/thread-utils';
import { DOCKED_WIDTH, listPaneWidth, mailLayoutFor, useLayout } from '../lib/use-layout';
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
 * Where the tab has room (`mailLayoutFor`) the message opens in a pane next
 * to the list, and with more room the folder list is a permanent sidebar; the
 * same viewer screen runs in the pane with a navigation that keeps it there.
 */
export default function MailTab({ navigation }: { navigation: RootNav }) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const readingPane = useSettingsStore((s) => s.readingPane);
  // The tab's own width: the window less the tab rail, whose width follows
  // its labels (language, font size). The window stands in until measured.
  const { width: windowWidth } = useWindowDimensions();
  const [tabWidth, setTabWidth] = React.useState(0);
  const width = tabWidth || windowWidth;
  const layout = mailLayoutFor(useLayout(), readingPane, width);
  const pane = useMessagePane(navigation, layout.isSplit, readingPane === 'off');
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
      split={layout.isSplit}
      sidebarDocked={layout.hasSidebar}
    />
  );
  const listWidth = listPaneWidth(width - (layout.hasSidebar ? DOCKED_WIDTH : 0));
  // One tree for both layouts, so the list keeps its place (scroll, search)
  // when the split comes or goes.
  return (
    <View style={styles.row} onLayout={(e) => setTabWidth(Math.round(e.nativeEvent.layout.width))}>
      {layout.hasSidebar && <SidebarDrawer docked visible onClose={noop} />}
      <View style={layout.isSplit ? [styles.listPane, { width: listWidth }] : styles.fill}>{list}</View>
      {layout.isSplit && (
        <View style={styles.fill}>
          <MessagePane
            message={pane.open}
            navigation={navigation}
            onRemoved={showNextAfterRemoval}
            onReplace={pane.replace}
            onActiveChange={onActiveChange}
          />
        </View>
      )}
    </View>
  );
}

function noop() {}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    row: { flex: 1, flexDirection: 'row', backgroundColor: c.background },
    listPane: { borderRightWidth: 1, borderRightColor: c.border },
    fill: { flex: 1 },
  });
}
