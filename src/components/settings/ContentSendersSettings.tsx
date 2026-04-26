import React, { useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, Pressable, TextInput, FlatList, Modal,
} from 'react-native';
import { ChevronRight, X, Plus, Trash2 } from 'lucide-react-native';
import { SettingsSection, SettingItem, RadioGroup, ToggleSwitch } from './settings-section';
import Button from '../Button';
import { colors, spacing, radius, typography } from '../../theme/tokens';
import { useSettingsStore, type ExternalContentPolicy } from '../../stores/settings-store';

export function ContentSendersSettings() {
  const externalContentPolicy = useSettingsStore((s) => s.externalContentPolicy);
  const setExternalContentPolicy = useSettingsStore((s) => s.setExternalContentPolicy);
  const emailAlwaysLightMode = useSettingsStore((s) => s.emailAlwaysLightMode);
  const setEmailAlwaysLightMode = useSettingsStore((s) => s.setEmailAlwaysLightMode);
  const trustedSenders = useSettingsStore((s) => s.trustedSenders);
  const addTrustedSender = useSettingsStore((s) => s.addTrustedSender);
  const removeTrustedSender = useSettingsStore((s) => s.removeTrustedSender);
  const hydrated = useSettingsStore((s) => s.hydrated);
  const hydrate = useSettingsStore((s) => s.hydrate);

  const [modalOpen, setModalOpen] = useState(false);
  const [newSender, setNewSender] = useState('');

  useEffect(() => { if (!hydrated) void hydrate(); }, [hydrated, hydrate]);

  const trustedCount = trustedSenders.length;
  const trustedLabel = trustedCount === 0 ? 'None' : trustedCount === 1 ? '1 sender' : `${trustedCount} senders`;

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
          description="External content always loads for senders on this list."
        >
          <Pressable
            onPress={() => setModalOpen(true)}
            style={({ pressed }) => [styles.trustedButton, pressed && styles.trustedButtonPressed]}
          >
            <Text style={styles.trustedButtonText}>{trustedLabel}</Text>
            <ChevronRight size={14} color={colors.textMuted} />
          </Pressable>
        </SettingItem>
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
                <X size={18} color={colors.textSecondary} />
              </Pressable>
            </View>

            <View style={styles.addRow}>
              <TextInput
                value={newSender}
                onChangeText={setNewSender}
                placeholder="sender@example.com"
                placeholderTextColor={colors.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
                style={styles.input}
                onSubmitEditing={() => {
                  if (newSender.trim()) {
                    addTrustedSender(newSender);
                    setNewSender('');
                  }
                }}
              />
              <Button
                variant="default"
                size="sm"
                onPress={() => {
                  if (newSender.trim()) {
                    addTrustedSender(newSender);
                    setNewSender('');
                  }
                }}
                disabled={!newSender.trim()}
                icon={<Plus size={14} color={colors.primaryForeground} />}
              >
                Add
              </Button>
            </View>

            {trustedSenders.length === 0 ? (
              <Text style={styles.emptyText}>No trusted senders yet.</Text>
            ) : (
              <FlatList
                data={trustedSenders}
                keyExtractor={(item) => item}
                style={styles.list}
                ItemSeparatorComponent={() => <View style={styles.separator} />}
                renderItem={({ item }) => (
                  <View style={styles.row}>
                    <Text style={styles.rowText} numberOfLines={1}>{item}</Text>
                    <Pressable
                      onPress={() => removeTrustedSender(item)}
                      hitSlop={6}
                      style={({ pressed }) => [styles.removeBtn, pressed && styles.removeBtnPressed]}
                    >
                      <Trash2 size={16} color={colors.error} />
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

const styles = StyleSheet.create({
  trustedButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    backgroundColor: colors.muted,
    borderRadius: radius.sm,
  },
  trustedButtonPressed: { opacity: 0.7 },
  trustedButtonText: { ...typography.body, color: colors.text },

  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  modalCard: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    maxHeight: '80%',
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  modalTitle: { ...typography.h3, color: colors.text },
  addRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.md },
  input: {
    flex: 1,
    backgroundColor: colors.background,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
    color: colors.text,
    ...typography.body,
  },
  list: { maxHeight: 300 },
  separator: { height: 1, backgroundColor: colors.border },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.md,
  },
  rowText: { ...typography.body, color: colors.text, flex: 1, marginRight: spacing.sm },
  removeBtn: { padding: 6, borderRadius: radius.sm },
  removeBtnPressed: { backgroundColor: colors.muted },
  emptyText: {
    ...typography.body,
    color: colors.textMuted,
    textAlign: 'center',
    paddingVertical: spacing.xl,
  },
});
