import React, { useState } from 'react';
import { View, Text, StyleSheet, Pressable, TextInput } from 'react-native';
import {
  Plus, Pencil, Trash2, Globe, ExternalLink, PanelRight, GripVertical,
} from 'lucide-react-native';
import { SettingsSection, SettingItem, ToggleSwitch } from './settings-section';
import Button from '../Button';
import { colors, spacing, radius, typography } from '../../theme/tokens';

interface SidebarApp {
  id: string;
  name: string;
  url: string;
  icon: string;
  openMode: 'tab' | 'inline';
  showOnMobile: boolean;
}

export function SidebarAppsSettings() {
  const [keepLoaded, setKeepLoaded] = useState(false);
  const [apps, setApps] = useState<SidebarApp[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [isAdding, setIsAdding] = useState(false);

  const addApp = (data: Omit<SidebarApp, 'id'>) => {
    setApps((list) => [...list, { ...data, id: `app-${Math.random().toString(36).slice(2)}` }]);
    setIsAdding(false);
  };

  const updateApp = (id: string, data: Omit<SidebarApp, 'id'>) => {
    setApps((list) => list.map((a) => a.id === id ? { ...data, id } : a));
    setEditingId(null);
  };

  const removeApp = (id: string) => {
    setApps((list) => list.filter((a) => a.id !== id));
  };

  return (
    <View style={styles.container}>
      <SettingsSection title="Sidebar Apps" description="Embedded web apps accessible from the sidebar.">
        <SettingItem label="Keep apps loaded" description="Maintain app state when switching away.">
          <ToggleSwitch checked={keepLoaded} onChange={setKeepLoaded} />
        </SettingItem>
      </SettingsSection>

      <SettingsSection title="Manage Apps" description="Add, edit, or remove sidebar apps.">
        <View style={{ gap: spacing.md }}>
          {apps.length === 0 && !isAdding && (
            <Text style={styles.emptyText}>No apps added yet.</Text>
          )}

          {apps.map((app) => {
            if (editingId === app.id) {
              return (
                <AppForm
                  key={app.id}
                  initial={app}
                  onSave={(data) => updateApp(app.id, data)}
                  onCancel={() => setEditingId(null)}
                />
              );
            }
            return (
              <View key={app.id} style={styles.appRow}>
                <GripVertical size={16} color={colors.mutedForeground} style={{ opacity: 0.5 }} />
                <View style={styles.appIcon}>
                  <Globe size={16} color={colors.text} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.appName} numberOfLines={1}>{app.name}</Text>
                  <Text style={styles.appUrl} numberOfLines={1}>{app.url}</Text>
                </View>
                <View style={[
                  styles.modeBadge,
                  app.openMode === 'inline' ? styles.modeBadgeInline : styles.modeBadgeTab,
                ]}>
                  <Text style={[
                    styles.modeBadgeText,
                    { color: app.openMode === 'inline' ? '#60a5fa' : colors.mutedForeground },
                  ]}>
                    {app.openMode === 'inline' ? 'Inline' : 'Tab'}
                  </Text>
                </View>
                <Pressable style={styles.iconBtn} onPress={() => setEditingId(app.id)}>
                  <Pencil size={14} color={colors.mutedForeground} />
                </Pressable>
                <Pressable style={styles.iconBtn} onPress={() => removeApp(app.id)}>
                  <Trash2 size={14} color={colors.mutedForeground} />
                </Pressable>
              </View>
            );
          })}

          {isAdding && (
            <AppForm
              onSave={addApp}
              onCancel={() => setIsAdding(false)}
            />
          )}

          {!isAdding && editingId === null && (
            <Pressable style={styles.addBtn} onPress={() => setIsAdding(true)}>
              <Plus size={16} color={colors.text} />
              <Text style={styles.addBtnText}>Add app</Text>
            </Pressable>
          )}
        </View>
      </SettingsSection>
    </View>
  );
}

interface AppFormProps {
  initial?: SidebarApp;
  onSave: (data: Omit<SidebarApp, 'id'>) => void;
  onCancel: () => void;
}

function AppForm({ initial, onSave, onCancel }: AppFormProps) {
  const [name, setName] = useState(initial?.name ?? '');
  const [url, setUrl] = useState(initial?.url ?? '');
  const [openMode, setOpenMode] = useState<'tab' | 'inline'>(initial?.openMode ?? 'tab');
  const [showOnMobile, setShowOnMobile] = useState(initial?.showOnMobile ?? false);

  const canSave = name.trim().length > 0 && url.trim().length > 0;

  return (
    <View style={formStyles.form}>
      <View>
        <Text style={formStyles.label}>Name</Text>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="App name"
          placeholderTextColor={colors.mutedForeground}
          style={formStyles.input}
        />
      </View>

      <View>
        <Text style={formStyles.label}>URL</Text>
        <TextInput
          value={url}
          onChangeText={setUrl}
          placeholder="https://example.com"
          placeholderTextColor={colors.mutedForeground}
          style={formStyles.input}
          autoCapitalize="none"
          keyboardType="url"
        />
      </View>

      <View>
        <Text style={formStyles.label}>Open mode</Text>
        <View style={{ flexDirection: 'row', gap: spacing.sm }}>
          <Pressable
            onPress={() => setOpenMode('tab')}
            style={[formStyles.modeBtn, openMode === 'tab' && formStyles.modeBtnActive]}
          >
            <ExternalLink size={14} color={openMode === 'tab' ? colors.primary : colors.text} />
            <Text style={[formStyles.modeBtnText, openMode === 'tab' && { color: colors.primary }]}>
              New tab
            </Text>
          </Pressable>
          <Pressable
            onPress={() => setOpenMode('inline')}
            style={[formStyles.modeBtn, openMode === 'inline' && formStyles.modeBtnActive]}
          >
            <PanelRight size={14} color={openMode === 'inline' ? colors.primary : colors.text} />
            <Text style={[formStyles.modeBtnText, openMode === 'inline' && { color: colors.primary }]}>
              Inline
            </Text>
          </Pressable>
        </View>
      </View>

      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text style={formStyles.label}>Show on mobile</Text>
        <ToggleSwitch checked={showOnMobile} onChange={setShowOnMobile} />
      </View>

      <View style={{ flexDirection: 'row', gap: spacing.sm, justifyContent: 'flex-end' }}>
        <Button variant="ghost" size="sm" onPress={onCancel}>Cancel</Button>
        <Button
          size="sm"
          disabled={!canSave}
          onPress={() => onSave({ name: name.trim(), url: url.trim(), icon: 'Globe', openMode, showOnMobile })}
        >
          {initial ? 'Update' : 'Add'}
        </Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: spacing.xxxl },
  emptyText: {
    ...typography.body,
    color: colors.mutedForeground,
    textAlign: 'center',
    paddingVertical: spacing.lg,
  },
  appRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  appIcon: {
    width: 32,
    height: 32,
    borderRadius: radius.sm,
    backgroundColor: colors.muted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  appName: { ...typography.bodyMedium, color: colors.text },
  appUrl: { ...typography.caption, color: colors.mutedForeground, marginTop: 2 },
  modeBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.full,
  },
  modeBadgeInline: { backgroundColor: 'rgba(59, 130, 246, 0.1)' },
  modeBadgeTab: { backgroundColor: colors.muted },
  modeBadgeText: { fontSize: 10, fontWeight: '500' },
  iconBtn: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
  },
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  addBtnText: { ...typography.body, color: colors.text },
});

const formStyles = StyleSheet.create({
  form: {
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.muted,
  },
  label: { ...typography.captionMedium, color: colors.text },
  input: {
    marginTop: 4,
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
    borderRadius: radius.sm,
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.text,
    ...typography.body,
  },
  modeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  modeBtnActive: {
    borderColor: colors.primary,
    backgroundColor: 'rgba(59, 130, 246, 0.1)',
  },
  modeBtnText: { ...typography.caption, color: colors.text },
});
