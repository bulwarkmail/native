import React, { useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, Pressable, TextInput, FlatList, Modal, Alert,
} from 'react-native';
import { ChevronRight, X, Plus, Trash2, BookUser } from 'lucide-react-native';
import { SettingsSection, SettingItem, RadioGroup, ToggleSwitch } from './settings-section';
import Button from '../Button';
import { spacing, radius, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useSettingsStore, type ExternalContentPolicy } from '../../stores/settings-store';
import { useContactsStore } from '../../stores/contacts-store';
import { useHasContacts } from '../../lib/capabilities';

interface TrustedRow {
  email: string;
  /** Kept in the local settings list. */
  local: boolean;
  /** Kept in the synced "Trusted Senders" address book. */
  synced: boolean;
}

export function ContentSendersSettings() {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const externalContentPolicy = useSettingsStore((s) => s.externalContentPolicy);
  const setExternalContentPolicy = useSettingsStore((s) => s.setExternalContentPolicy);
  const emailAlwaysLightMode = useSettingsStore((s) => s.emailAlwaysLightMode);
  const setEmailAlwaysLightMode = useSettingsStore((s) => s.setEmailAlwaysLightMode);
  const trustedSenders = useSettingsStore((s) => s.trustedSenders);
  const addTrustedSender = useSettingsStore((s) => s.addTrustedSender);
  const removeTrustedSender = useSettingsStore((s) => s.removeTrustedSender);
  const trustedSendersAddressBook = useSettingsStore((s) => s.trustedSendersAddressBook);
  const updateSetting = useSettingsStore((s) => s.updateSetting);
  const hydrated = useSettingsStore((s) => s.hydrated);
  const hydrate = useSettingsStore((s) => s.hydrate);

  const hasContacts = useHasContacts();
  const trustedSenderEmails = useContactsStore((s) => s.trustedSenderEmails);
  const trustedSendersLoaded = useContactsStore((s) => s.trustedSendersLoaded);
  const loadTrustedSendersBook = useContactsStore((s) => s.loadTrustedSendersBook);
  const addToTrustedSendersBook = useContactsStore((s) => s.addToTrustedSendersBook);
  const removeFromTrustedSendersBook = useContactsStore((s) => s.removeFromTrustedSendersBook);

  const [modalOpen, setModalOpen] = useState(false);
  const [newSender, setNewSender] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => { if (!hydrated) void hydrate(); }, [hydrated, hydrate]);

  // Sync stays off until the user turns it on below (null = never chosen):
  // opening this pane must not change which senders the viewer trusts.
  const syncEnabled = !!trustedSendersAddressBook && hasContacts;

  useEffect(() => {
    if (modalOpen && syncEnabled) void loadTrustedSendersBook();
  }, [modalOpen, syncEnabled, loadTrustedSendersBook]);

  // The settings list ∪ the synced book, so an entry trusted from the viewer
  // (which writes both) shows once and can be removed from both.
  const rows = React.useMemo<TrustedRow[]>(() => {
    const map = new Map<string, TrustedRow>();
    for (const email of trustedSenders) {
      const key = email.toLowerCase().trim();
      if (!key) continue;
      map.set(key, { email: key, local: true, synced: false });
    }
    if (syncEnabled) {
      for (const email of trustedSenderEmails) {
        const key = email.toLowerCase().trim();
        if (!key) continue;
        const existing = map.get(key);
        if (existing) existing.synced = true;
        else map.set(key, { email: key, local: false, synced: true });
      }
    }
    return Array.from(map.values()).sort((a, b) => a.email.localeCompare(b.email));
  }, [trustedSenders, trustedSenderEmails, syncEnabled]);

  const trustedCount = rows.length;
  const trustedLabel = trustedCount === 0 ? 'None' : trustedCount === 1 ? '1 sender' : `${trustedCount} senders`;
  const syncedCount = rows.filter((r) => r.synced).length;

  const handleAdd = async () => {
    const value = newSender.trim();
    if (!value) return;
    setNewSender('');
    addTrustedSender(value);
    if (syncEnabled) {
      setBusy(value);
      try {
        await addToTrustedSendersBook(value);
      } catch (err) {
        Alert.alert('Could not sync to address book', err instanceof Error ? err.message : 'Unknown error');
      } finally {
        setBusy(null);
      }
    }
  };

  const handleRemove = async (row: TrustedRow) => {
    if (row.local) removeTrustedSender(row.email);
    if (row.synced) {
      setBusy(row.email);
      try {
        await removeFromTrustedSendersBook(row.email);
      } catch (err) {
        Alert.alert('Could not remove from address book', err instanceof Error ? err.message : 'Unknown error');
      } finally {
        setBusy(null);
      }
    }
  };

  return (
    <View style={{ gap: spacing.xxxl }}>
      <SettingsSection
        title="Content & Senders"
        description="Control how external resources and tracking pixels are handled."
      >
        <SettingItem
          label="External content"
          description="What to do when an email links to remote images or media."
        >
          <RadioGroup
            value={externalContentPolicy}
            onChange={(v) => setExternalContentPolicy(v as ExternalContentPolicy)}
            options={[
              { value: 'ask', label: 'Ask' },
              { value: 'block', label: 'Block' },
              { value: 'allow', label: 'Allow' },
            ]}
          />
        </SettingItem>

        <SettingItem
          label="Always view emails in light mode"
          description="Force a light background for the message body, even when the app is in dark mode."
        >
          <ToggleSwitch checked={emailAlwaysLightMode} onChange={setEmailAlwaysLightMode} />
        </SettingItem>

        <SettingItem
          label="Trusted senders"
          description={
            syncEnabled && syncedCount > 0
              ? `External content always loads for senders on this list. ${syncedCount} synced via your address book.`
              : 'External content always loads for senders on this list.'
          }
        >
          <Pressable
            onPress={() => setModalOpen(true)}
            style={({ pressed }) => [styles.trustedButton, pressed && styles.trustedButtonPressed]}
          >
            <Text style={styles.trustedButtonText}>{trustedLabel}</Text>
            <ChevronRight size={14} color={c.textMuted} />
          </Pressable>
        </SettingItem>

        {hasContacts && (
          <SettingItem
            label="Sync trusted senders to address book"
            description='Keep the list in a "Trusted Senders" address book so it is shared with the webmail and your other devices.'
          >
            <ToggleSwitch
              checked={!!trustedSendersAddressBook}
              onChange={(enabled) => {
                updateSetting('trustedSendersAddressBook', enabled);
                if (enabled) void loadTrustedSendersBook();
              }}
            />
          </SettingItem>
        )}
      </SettingsSection>

      <Modal
        visible={modalOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setModalOpen(false)}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => setModalOpen(false)}>
          <Pressable style={styles.modalCard} onPress={() => {}}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Trusted senders</Text>
              <Pressable onPress={() => setModalOpen(false)} hitSlop={6}>
                <X size={18} color={c.textSecondary} />
              </Pressable>
            </View>

            <View style={styles.addRow}>
              <TextInput
                value={newSender}
                onChangeText={setNewSender}
                placeholder="sender@example.com"
                placeholderTextColor={c.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
                style={styles.input}
                onSubmitEditing={() => { void handleAdd(); }}
              />
              <Button
                variant="default"
                size="sm"
                onPress={() => { void handleAdd(); }}
                disabled={!newSender.trim()}
                icon={<Plus size={14} color={c.primaryForeground} />}
              >
                Add
              </Button>
            </View>

            {rows.length === 0 ? (
              <Text style={styles.emptyText}>
                {syncEnabled && !trustedSendersLoaded
                  ? 'Loading…'
                  : 'No trusted senders yet.'}
              </Text>
            ) : (
              <FlatList
                data={rows}
                keyExtractor={(item) => item.email}
                style={styles.list}
                ItemSeparatorComponent={() => <View style={styles.separator} />}
                renderItem={({ item }) => (
                  <View style={styles.row}>
                    <Text style={styles.rowText} numberOfLines={1}>{item.email}</Text>
                    {item.synced && (
                      <View style={styles.syncedBadge} accessibilityLabel="Synced via address book">
                        <BookUser size={12} color={c.textMuted} />
                      </View>
                    )}
                    <Pressable
                      onPress={() => { void handleRemove(item); }}
                      disabled={busy === item.email}
                      hitSlop={6}
                      style={({ pressed }) => [styles.removeBtn, pressed && styles.removeBtnPressed]}
                    >
                      <Trash2 size={16} color={busy === item.email ? c.textMuted : c.error} />
                    </Pressable>
                  </View>
                )}
              />
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
  trustedButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    backgroundColor: c.muted,
    borderRadius: radius.sm,
  },
  trustedButtonPressed: { opacity: 0.7 },
  trustedButtonText: { ...typography.body, color: c.text },

  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  modalCard: {
    backgroundColor: c.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: c.border,
    padding: spacing.lg,
    maxHeight: '80%',
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  modalTitle: { ...typography.h3, color: c.text },
  addRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.md },
  input: {
    flex: 1,
    backgroundColor: c.background,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: c.border,
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
    color: c.text,
    ...typography.body,
  },
  list: { maxHeight: 300 },
  separator: { height: 1, backgroundColor: c.border },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.md,
  },
  rowText: { ...typography.body, color: c.text, flex: 1, marginRight: spacing.sm },
  syncedBadge: {
    width: 22, height: 22,
    alignItems: 'center', justifyContent: 'center',
    borderRadius: radius.full,
    backgroundColor: c.muted,
    marginRight: spacing.xs,
  },
  removeBtn: { padding: 6, borderRadius: radius.sm },
  removeBtnPressed: { backgroundColor: c.muted },
  emptyText: {
    ...typography.body,
    color: c.textMuted,
    textAlign: 'center',
    paddingVertical: spacing.xl,
  },
});
}
