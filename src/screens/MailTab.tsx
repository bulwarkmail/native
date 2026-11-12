import React from 'react';
import { StyleSheet, View } from 'react-native';
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
import { useMailLayout } from '../lib/use-mail-layout';
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
 * With room for a reader next to the list (`useMailLayout`) the message opens
 * in a pane beside it, and with room for the folder list too that is a
 * permanent sidebar; the same viewer screen runs in the pane with a
 * navigation that keeps it there.
 */
export default function MailTab({ navigation }: { navigation: RootNav }) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  // Sized from the room next to the tab rail, and one pane when the reader
  // would get less than its minimum (#104).
  const layout = useMailLayout(true);
  const pane = useMessagePane(navigation, layout.isSplit, layout.windowIsSplit);
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
      split={layout.isSplit}
    />
  );

  // On a wide window the stored reading pane setting picks the layout: wait
  // for it, so the list mounts once and the split never flashes up (#93).
  if (!layout.ready) return <View style={styles.row} onLayout={layout.onLayout} />;

  // One tree for both layouts: the list stays mounted when the split comes
  // or goes (a rotation, a fold), and the row measures the room it has.
  return (
    <View style={styles.row} onLayout={layout.onLayout}>
      {layout.hasSidebar && <SidebarDrawer docked visible onClose={noop} />}
      <View style={layout.isSplit ? [styles.listPane, { width: layout.listWidth }] : styles.singlePane}>{list}</View>
      {layout.isSplit && (
        <View style={styles.detailPane}>
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
    singlePane: { flex: 1 },
    detailPane: { flex: 1 },
  });
}
