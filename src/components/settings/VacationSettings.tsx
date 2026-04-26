import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TextInput, Pressable, ActivityIndicator, Alert } from 'react-native';
import { AlertTriangle, Eye, EyeOff } from 'lucide-react-native';
import { SettingsSection, SettingItem, ToggleSwitch } from './settings-section';
import Button from '../Button';
import { colors, spacing, radius, typography } from '../../theme/tokens';
import { useVacationStore } from '../../stores/vacation-store';

function toJmapDate(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  // Accept "YYYY-MM-DD" or "YYYY-MM-DD HH:MM" - normalize to "YYYY-MM-DDTHH:MM:SS".
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(trimmed);
  const dateTime = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(trimmed);
  if (dateOnly) return `${trimmed}T00:00:00`;
  if (dateTime) return trimmed.replace(' ', 'T').length === 16 ? `${trimmed.replace(' ', 'T')}:00` : trimmed.replace(' ', 'T');
  return null;
}

function fromJmapDate(value: string | null): string {
  if (!value) return '';
  return value.replace('T', ' ').slice(0, 16);
}

export function VacationSettings() {
  const store = useVacationStore();

  const [enabled, setEnabled] = useState(store.isEnabled);
  const [fromDate, setFromDate] = useState(fromJmapDate(store.fromDate));
  const [toDate, setToDate] = useState(fromJmapDate(store.toDate));
  const [subject, setSubject] = useState(store.subject);
  const [body, setBody] = useState(store.textBody);
  const [showPreview, setShowPreview] = useState(false);

  useEffect(() => {
    void store.fetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!store.hasLoaded) return;
    setEnabled(store.isEnabled);
    setFromDate(fromJmapDate(store.fromDate));
    setToDate(fromJmapDate(store.toDate));
    setSubject(store.subject);
    setBody(store.textBody);
  }, [store.hasLoaded, store.isEnabled, store.fromDate, store.toDate, store.subject, store.textBody]);

  const dateErrorMsg = fromDate && toDate && toJmapDate(fromDate) && toJmapDate(toDate) && new Date(toJmapDate(toDate)!) <= new Date(toJmapDate(fromDate)!);
  const formatError = (fromDate && !toJmapDate(fromDate)) || (toDate && !toJmapDate(toDate));
  const emptyBody = enabled && !body.trim();

  const warnings: string[] = [];
  if (dateErrorMsg) warnings.push('End date must be after start date.');
  if (formatError) warnings.push('Dates must be "YYYY-MM-DD" or "YYYY-MM-DD HH:MM".');
  if (emptyBody) warnings.push('Auto-response body cannot be empty.');

  const canSave = !dateErrorMsg && !formatError && !emptyBody && !store.isSaving;

  const handleSave = async () => {
    try {
      await store.save({
        isEnabled: enabled,
        fromDate: toJmapDate(fromDate),
        toDate: toJmapDate(toDate),
        subject: subject.trim(),
        textBody: body,
      });
      Alert.alert('Saved', 'Vacation responder updated.');
    } catch (err) {
      Alert.alert('Error', err instanceof Error ? err.message : 'Failed to save');
    }
  };

  if (store.isLoading && !store.hasLoaded) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  if (!store.isSupported && store.hasLoaded) {
    return (
      <SettingsSection title="Vacation Responder" description="Automatically reply while you are away.">
        <View style={styles.unsupported}>
          <AlertTriangle size={16} color={colors.warning} />
          <Text style={styles.unsupportedText}>
            Your server does not advertise support for the JMAP vacation responder.
          </Text>
        </View>
      </SettingsSection>
    );
  }

  return (
    <View style={styles.container}>
      <SettingsSection title="Vacation Responder" description="Automatically reply while you are away.">
        <SettingItem label="Status" description="Enable or disable the responder.">
          <View style={styles.statusRow}>
            <View style={[styles.pill, enabled ? styles.pillActive : styles.pillInactive]}>
              <Text style={[styles.pillText, enabled ? styles.pillTextActive : styles.pillTextInactive]}>
                {enabled ? 'Active' : 'Inactive'}
              </Text>
            </View>
            <ToggleSwitch checked={enabled} onChange={setEnabled} />
          </View>
        </SettingItem>
      </SettingsSection>

      <SettingsSection title="Date Range" description="Optional window for the responder.">
        <SettingItem label="Start" description="When the responder becomes active.">
          <TextInput
            value={fromDate}
            onChangeText={setFromDate}
            placeholder="YYYY-MM-DD HH:MM"
            placeholderTextColor={colors.mutedForeground}
            style={styles.dateInput}
            autoCapitalize="none"
          />
        </SettingItem>
        <SettingItem label="End" description="When the responder is turned off.">
          <TextInput
            value={toDate}
            onChangeText={setToDate}
            placeholder="YYYY-MM-DD HH:MM"
            placeholderTextColor={colors.mutedForeground}
            style={styles.dateInput}
            autoCapitalize="none"
          />
        </SettingItem>
      </SettingsSection>

      <SettingsSection title="Message" description="What recipients will see.">
        <SettingItem label="Subject" description="Optional subject for the reply.">
          <TextInput
            value={subject}
            onChangeText={setSubject}
            placeholder="Out of office"
            placeholderTextColor={colors.mutedForeground}
            style={styles.subjectInput}
          />
        </SettingItem>
        <View style={styles.bodyBlock}>
          <Text style={styles.bodyLabel}>Body</Text>
          <Text style={styles.bodyDesc}>Short explanation for senders.</Text>
          <TextInput
            value={body}
            onChangeText={setBody}
            placeholder="I am away from…"
            placeholderTextColor={colors.mutedForeground}
            style={styles.bodyInput}
            multiline
            numberOfLines={6}
            textAlignVertical="top"
          />
        </View>
      </SettingsSection>

      {body.trim().length > 0 && (
        <SettingsSection title="Preview">
          <Pressable style={styles.previewToggle} onPress={() => setShowPreview((v) => !v)}>
            {showPreview ? (
              <EyeOff size={14} color={colors.primary} />
            ) : (
              <Eye size={14} color={colors.primary} />
            )}
            <Text style={styles.previewToggleText}>
              {showPreview ? 'Hide preview' : 'Show preview'}
            </Text>
          </Pressable>
          {showPreview && (
            <View style={styles.previewBox}>
              {subject.length > 0 && <Text style={styles.previewSubject}>{subject}</Text>}
              <Text style={styles.previewBody}>{body}</Text>
            </View>
          )}
        </SettingsSection>
      )}

      {warnings.length > 0 && (
        <View style={styles.warnings}>
          {warnings.map((w, i) => (
            <View key={i} style={styles.warnRow}>
              <AlertTriangle size={14} color={colors.warning} />
              <Text style={styles.warnText}>{w}</Text>
            </View>
          ))}
        </View>
      )}

      {store.error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{store.error}</Text>
        </View>
      )}

      <View style={styles.saveRow}>
        <Button onPress={handleSave} disabled={!canSave} loading={store.isSaving}>
          Save
        </Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: spacing.xl },
  centered: { paddingVertical: 40, alignItems: 'center' },
  unsupported: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.md,
    backgroundColor: 'rgba(202,138,4,0.12)',
    borderRadius: radius.sm,
  },
  unsupportedText: { ...typography.body, color: colors.warning, flex: 1 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  pill: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: radius.full,
  },
  pillActive: { backgroundColor: 'rgba(22,163,74,0.2)' },
  pillInactive: { backgroundColor: colors.muted },
  pillText: { fontSize: 11, fontWeight: '500' },
  pillTextActive: { color: '#4ade80' },
  pillTextInactive: { color: colors.mutedForeground },
  dateInput: {
    minWidth: 180,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.sm,
    backgroundColor: colors.muted,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.text,
    ...typography.body,
  },
  subjectInput: {
    width: 240,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.sm,
    backgroundColor: colors.muted,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.text,
    ...typography.body,
  },
  bodyBlock: { paddingVertical: spacing.md },
  bodyLabel: { ...typography.bodyMedium, color: colors.text },
  bodyDesc: { ...typography.caption, color: colors.mutedForeground, marginTop: 2, marginBottom: spacing.sm },
  bodyInput: {
    width: '100%',
    minHeight: 96,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    backgroundColor: colors.muted,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.text,
    ...typography.body,
  },
  previewToggle: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  previewToggleText: { ...typography.body, color: colors.primary },
  previewBox: {
    marginTop: spacing.sm,
    padding: spacing.lg,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
  },
  previewSubject: { ...typography.bodyMedium, color: colors.text, marginBottom: spacing.sm },
  previewBody: { ...typography.body, color: colors.mutedForeground },
  warnings: { gap: spacing.sm },
  warnRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  warnText: { ...typography.body, color: colors.warning, flex: 1 },
  errorBox: {
    padding: spacing.md,
    borderRadius: radius.sm,
    backgroundColor: colors.errorBg,
  },
  errorText: { ...typography.body, color: colors.error },
  saveRow: { alignItems: 'flex-end' },
});
