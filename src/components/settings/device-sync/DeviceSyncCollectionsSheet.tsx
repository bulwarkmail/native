// Which address books or calendars of one account sync to this device
// (docs/device-sync.md, "Settings sections"). The account's own collections
// are on unless turned off, shared ones off unless turned on; read-only ones
// are marked, and a collection another signed-in account already syncs gets
// a warning (it would show twice on the phone).
import React from 'react';
import {
  ActivityIndicator, Animated, Easing, Modal, Pressable, ScrollView, StyleSheet, Text, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AlertTriangle, Check, X } from '../../icons';
import Button from '../../Button';
import { spacing, radius, typography, type ThemePalette } from '../../../theme/tokens';
import { useColors } from '../../../theme/colors';
import { useSheetDrag } from '../../../lib/use-sheet-drag';
import { useLocaleStore } from '../../../stores/locale-store';
import { useAccountStore } from '../../../stores/account-store';
import {
  isCollectionSelected,
  selectionFor,
  useDeviceSyncStore,
  emptyAccountDeviceSync,
} from '../../../stores/device-sync-store';
import { otherAccountsSyncing, type SyncCollection } from '../../../device-sync/app/collections';
import { CONTACTS_AUTHORITY, type Authority } from '../../../device-sync/types';
import { useSyncCollections } from './use-sync-collections';
import { MODAL_ORIENTATIONS } from '../../../lib/modal-orientations';
import { useSheetInsets } from '../../../lib/use-layout';

interface Props {
  visible: boolean;
  /** `changed`: the selection was edited while the sheet was open. */
  onClose: (changed: boolean) => void;
  registryId: string;
  authority: Authority;
  /** The account's address, under the title. */
  accountLabel: string;
}

export function DeviceSyncCollectionsSheet({ visible, onClose, registryId, authority, accountLabel }: Props) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const insets = useSafeAreaInsets();
  const { state, reload } = useSyncCollections(registryId, authority, visible);
  const entry = useDeviceSyncStore((s) => s.accounts[registryId]);
  const allEntries = useDeviceSyncStore((s) => s.accounts);
  const setCollectionSelected = useDeviceSyncStore((s) => s.setCollectionSelected);
  const registry = useAccountStore((s) => s.accounts);
  const changed = React.useRef(false);

  const slideY = React.useRef(new Animated.Value(600)).current;
  // Centred on a wide window, clear of side insets in landscape.
  const sheetInsets = useSheetInsets();
  const overlayOpacity = React.useRef(new Animated.Value(0)).current;
  const close = React.useCallback(() => {
    const wasChanged = changed.current;
    changed.current = false;
    onClose(wasChanged);
  }, [onClose]);
  const dragHandlers = useSheetDrag({ slideY, closedY: 600, onClose: close });

  React.useEffect(() => {
    if (visible) {
      changed.current = false;
      Animated.parallel([
        Animated.timing(slideY, { toValue: 0, duration: 220, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
        Animated.timing(overlayOpacity, { toValue: 1, duration: 220, useNativeDriver: true }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(slideY, { toValue: 600, duration: 180, easing: Easing.in(Easing.cubic), useNativeDriver: true }),
        Animated.timing(overlayOpacity, { toValue: 0, duration: 180, useNativeDriver: true }),
      ]).start();
    }
  }, [visible, slideY, overlayOpacity]);

  const selection = selectionFor(entry ?? emptyAccountDeviceSync(), authority);
  const collections = state.kind === 'loaded' || state.kind === 'loading' ? state.collections ?? [] : [];
  const groups = React.useMemo(() => {
    const out: Array<{ jmapAccountId: string; isPersonal: boolean; accountName: string; items: SyncCollection[] }> = [];
    for (const collection of collections) {
      let group = out.find((g) => g.jmapAccountId === collection.jmapAccountId);
      if (!group) {
        group = {
          jmapAccountId: collection.jmapAccountId,
          isPersonal: collection.isPersonal,
          accountName: collection.accountName,
          items: [],
        };
        out.push(group);
      }
      group.items.push(collection);
    }
    return out;
  }, [collections]);

  const toggle = (collection: SyncCollection) => {
    const on = isCollectionSelected(selection, authority, collection);
    setCollectionSelected(registryId, authority, collection.key, !on);
    changed.current = true;
  };

  const errorText = state.kind !== 'error'
    ? ''
    : state.error === 'signedOut'
      ? t('settings.device_sync.list_error_signed_out', 'This account is not signed in on this device.')
      : state.error === 'auth'
        ? t('settings.device_sync.list_error_auth', 'The server did not accept the sign-in.')
        : state.error === 'network'
          ? t('settings.device_sync.list_error_network', 'Could not reach the server.')
          : t('settings.device_sync.list_error_server', 'The server could not list them.');

  return (
    <Modal supportedOrientations={MODAL_ORIENTATIONS} visible={visible} transparent animationType="none" onRequestClose={close} statusBarTranslucent>
      <Animated.View style={[styles.overlay, { opacity: overlayOpacity }]}>
        <Pressable style={{ flex: 1 }} onPress={close} />
      </Animated.View>
      <Animated.View
        style={[
          styles.sheet,
          { paddingBottom: Math.max(insets.bottom, spacing.md), transform: [{ translateY: slideY }], ...sheetInsets },
        ]}
      >
        <View {...dragHandlers}>
          <View style={styles.handleHit}>
            <View style={styles.handle} />
          </View>
          <View style={styles.header}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={styles.title}>
                {authority === CONTACTS_AUTHORITY
                  ? t('settings.device_sync.choose_books_title', 'Address books to sync')
                  : t('settings.device_sync.choose_calendars_title', 'Calendars to sync')}
              </Text>
              <Text style={styles.subtitle} numberOfLines={1}>{accountLabel}</Text>
            </View>
            <Pressable
              onPress={close}
              hitSlop={10}
              style={styles.close}
              accessibilityRole="button"
              accessibilityLabel={t('common.close', 'Close')}
            >
              <X size={18} color={c.textSecondary} />
            </Pressable>
          </View>
        </View>

        <ScrollView contentContainerStyle={styles.body}>
          {state.kind === 'error' && (
            <View style={styles.message} accessibilityRole="alert">
              <Text style={styles.errorText}>{errorText}</Text>
              <Button variant="outline" size="sm" onPress={reload}>
                {t('common.retry', 'Retry')}
              </Button>
            </View>
          )}
          {(state.kind === 'loading' || state.kind === 'idle') && collections.length === 0 && (
            <View style={styles.message}>
              <ActivityIndicator size="small" color={c.primary} />
            </View>
          )}
          {state.kind === 'loaded' && collections.length === 0 && (
            <View style={styles.message}>
              <Text style={styles.muted}>
                {authority === CONTACTS_AUTHORITY
                  ? t('settings.device_sync.no_books', 'This account has no address books.')
                  : t('settings.device_sync.no_calendars', 'This account has no calendars to sync.')}
              </Text>
            </View>
          )}

          {groups.map((group) => (
            <View key={group.jmapAccountId} style={styles.group}>
              <Text style={styles.groupTitle}>
                {group.isPersonal
                  ? t('settings.device_sync.own_collections', 'Your own')
                  : t('settings.device_sync.shared_by', 'Shared by {name}', { name: group.accountName })}
              </Text>
              {group.items.map((collection) => {
                const on = isCollectionSelected(selection, authority, collection);
                const others = on ? otherAccountsSyncing(registryId, authority, collection, registry, allEntries) : [];
                const tint = collection.color ?? c.primary;
                return (
                  <Pressable
                    key={collection.key}
                    onPress={() => toggle(collection)}
                    style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: on }}
                    accessibilityLabel={collection.name}
                  >
                    <View style={[styles.box, { borderColor: tint, backgroundColor: on ? tint : 'transparent' }]}>
                      {on && <Check size={12} color={c.textInverse} />}
                    </View>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={[styles.rowName, !on && styles.rowNameOff]} numberOfLines={1}>
                        {collection.name}
                      </Text>
                      {(collection.readOnly || collection.isDefault) && (
                        <Text style={styles.muted}>
                          {[
                            collection.isDefault ? t('contacts.address_books.default', 'Default') : null,
                            collection.readOnly ? t('settings.device_sync.read_only', 'Read-only') : null,
                          ].filter(Boolean).join(' · ')}
                        </Text>
                      )}
                      {others.length > 0 && (
                        <View style={styles.warningRow}>
                          <AlertTriangle size={12} color={c.warning} />
                          <Text style={styles.warningText}>
                            {t(
                              'settings.device_sync.also_synced_by',
                              'Also synced for {accounts}, so it shows twice on this device.',
                              { accounts: others.join(', ') },
                            )}
                          </Text>
                        </View>
                      )}
                    </View>
                  </Pressable>
                );
              })}
            </View>
          ))}

          <Text style={styles.hint}>
            {authority === CONTACTS_AUTHORITY
              ? t(
                'settings.device_sync.books_hint',
                'Your own address books sync unless you turn them off; shared ones only when you turn them on.',
              )
              : t(
                'settings.device_sync.calendars_hint',
                'Your own calendars sync unless you turn them off; shared ones only when you turn them on. Task lists stay in Bulwark.',
              )}
          </Text>
        </ScrollView>
      </Animated.View>
    </Modal>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    overlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.5)' },
    sheet: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      maxHeight: '80%',
      backgroundColor: c.popover,
      borderTopLeftRadius: radius.lg,
      borderTopRightRadius: radius.lg,
      borderTopWidth: 1,
      borderColor: c.border,
      paddingTop: spacing.sm,
    },
    handleHit: { alignItems: 'center', paddingTop: spacing.xs, paddingBottom: spacing.sm },
    handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: c.border },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
      paddingBottom: spacing.sm,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    title: { ...typography.bodySemibold, color: c.text },
    subtitle: { ...typography.caption, color: c.mutedForeground },
    close: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center', borderRadius: radius.xs },
    body: { paddingBottom: spacing.md },
    message: { alignItems: 'center', gap: spacing.sm, padding: spacing.lg },
    errorText: { ...typography.caption, color: c.error, textAlign: 'center' },
    muted: { ...typography.caption, color: c.mutedForeground },
    group: { paddingTop: spacing.sm },
    groupTitle: {
      ...typography.captionMedium,
      color: c.mutedForeground,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.xs,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm + 2,
      minHeight: 44,
    },
    rowPressed: { backgroundColor: c.surfaceHover },
    box: {
      width: 18,
      height: 18,
      borderRadius: radius.xs,
      borderWidth: 2,
      alignItems: 'center',
      justifyContent: 'center',
    },
    rowName: { ...typography.body, color: c.text },
    rowNameOff: { color: c.textSecondary },
    warningRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 4, marginTop: 2 },
    warningText: { ...typography.caption, color: c.warning, flex: 1 },
    hint: {
      ...typography.caption,
      color: c.mutedForeground,
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.md,
    },
  });
}
