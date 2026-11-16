import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useNavigation, type NavigationProp, type ParamListBase } from '@react-navigation/native';
import { BookUser } from '../components/icons';

import ContactsScreen from './ContactsScreen';
import ContactDetailScreen from './ContactDetailScreen';
import GroupDetailScreen from './GroupDetailScreen';
import type { ContactCard } from '../api/types';
import { isGroup } from '../lib/contact-utils';
import { useFoldAlignedListWidth, useLaptopFoldY } from '../lib/use-fold-panes';
import { paneLayoutFor, usePaneArea } from '../lib/use-layout';
import { PaneScreen, type PaneTarget } from '../navigation/pane';
import { useLocaleStore } from '../stores/locale-store';
import { useColors } from '../theme/colors';
import { spacing, typography, type ThemePalette } from '../theme/tokens';

type Open =
  | { name: 'ContactDetail'; params: { contactId: string } }
  | { name: 'GroupDetail'; params: { groupId: string } };

function openFor(contact: ContactCard): Open {
  return isGroup(contact)
    ? { name: 'GroupDetail', params: { groupId: contact.id } }
    : { name: 'ContactDetail', params: { contactId: contact.id } };
}

/**
 * The Contacts tab: the list on a phone; list and contact side by side on a
 * wide window, where the contact (or group) opens in the right pane.
 */
export default function ContactsTab() {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const navigation = useNavigation<NavigationProp<ParamListBase>>();
  // List and contact side by side when the contact keeps its minimum width
  // next to the tab rail and the list (#104).
  const area = usePaneArea(true);
  const panes = paneLayoutFor(area.window, area.contentWidth);
  const { isSplit } = panes;
  const listWidth = useFoldAlignedListWidth(panes.listWidth, area.contentWidth);
  // An iPhone Duo half open like a laptop: the contact on the upright half,
  // the list on the half lying flat, nothing across the fold. The contact
  // lies over the top of the row (see MailTab on why not a column).
  const foldY = useLaptopFoldY();
  const stacked = isSplit && foldY != null;
  const [open, setOpen] = React.useState<Open | null>(null);

  // Narrowed with a contact open: hand it to the stack.
  const openRef = React.useRef(open);
  openRef.current = open;
  React.useEffect(() => {
    if (isSplit || !openRef.current) return;
    navigation.navigate(openRef.current.name, openRef.current.params);
    setOpen(null);
  }, [isSplit, navigation]);

  const onOpen = React.useCallback((target: PaneTarget) => {
    if (target.name === 'ContactDetail' || target.name === 'GroupDetail') {
      setOpen(target as Open);
      return true;
    }
    return false;
  }, []);
  const onClose = React.useCallback(() => setOpen(null), []);

  const activeId = open ? ('contactId' in open.params ? open.params.contactId : open.params.groupId) : null;
  // One tree for both layouts: the list stays mounted when the split comes
  // or goes, and the row measures the room it has.
  return (
    <View style={styles.row} onLayout={area.onLayout}>
      <View style={stacked ? [styles.singlePane, { marginTop: foldY }] : isSplit ? [styles.listPane, { width: listWidth }] : styles.singlePane}>
        <ContactsScreen
          onOpenContact={isSplit ? (contact) => setOpen(openFor(contact)) : undefined}
          activeContactId={isSplit ? activeId : undefined}
          belowDetail={stacked}
        />
      </View>
      {isSplit && <View style={stacked ? [styles.detailAbove, { height: foldY }] : styles.detailPane}>
        {open ? (
          <PaneScreen
            key={activeId ?? undefined}
            navigation={navigation}
            name={open.name}
            params={open.params}
            onOpen={onOpen}
            onClose={onClose}
          >
            {open.name === 'ContactDetail' ? <ContactDetailScreen /> : <GroupDetailScreen />}
          </PaneScreen>
        ) : (
          <View style={styles.empty}>
            <BookUser size={40} color={c.textMuted} strokeWidth={1.5} />
            <Text style={styles.emptyText}>{t('contacts.detail.no_contact_selected', 'Select a contact to view details')}</Text>
          </View>
        )}
      </View>}
    </View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    row: { flex: 1, flexDirection: 'row', backgroundColor: c.background },
    listPane: { borderRightWidth: 1, borderRightColor: c.border },
    detailAbove: {
      position: 'absolute', top: 0, left: 0, right: 0,
      borderBottomWidth: 1, borderBottomColor: c.border, backgroundColor: c.background,
    },
    singlePane: { flex: 1 },
    detailPane: { flex: 1 },
    empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.md, padding: spacing.xl },
    emptyText: { ...typography.body, color: c.textMuted, textAlign: 'center' },
  });
}
