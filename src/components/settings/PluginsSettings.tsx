import React, { useState } from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { Upload, Puzzle, AlertTriangle, Lock, Trash2, ChevronDown, ChevronRight } from 'lucide-react-native';
import { SettingsSection, SettingItem, ToggleSwitch } from './settings-section';
import Button from '../Button';
import { colors, spacing, radius, typography } from '../../theme/tokens';

interface Plugin {
  id: string;
  name: string;
  author: string;
  version: string;
  type: string;
  description?: string;
  enabled: boolean;
  status: 'installed' | 'enabled' | 'running' | 'disabled' | 'error';
  error?: string;
  permissions: string[];
  forceEnabled?: boolean;
}

const STATUS_STYLE: Record<Plugin['status'], { bg: string; fg: string }> = {
  installed: { bg: colors.muted, fg: colors.mutedForeground },
  enabled:   { bg: 'rgba(59, 130, 246, 0.15)', fg: '#60a5fa' },
  running:   { bg: 'rgba(34, 197, 94, 0.15)',  fg: '#4ade80' },
  disabled:  { bg: colors.muted, fg: colors.mutedForeground },
  error:     { bg: 'rgba(239, 68, 68, 0.15)',  fg: '#f87171' },
};

export function PluginsSettings() {
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const togglePlugin = (id: string) => {
    setPlugins((ps) => ps.map((p) => {
      if (p.id !== id) return p;
      const enabled = !p.enabled;
      return { ...p, enabled, status: enabled ? 'enabled' : 'disabled' };
    }));
  };

  const uninstall = (id: string) => {
    setPlugins((ps) => ps.filter((p) => p.id !== id));
  };

  return (
    <SettingsSection
      title="Plugins"
      description="Manage installed plugins. Upload plugin .zip files to add new functionality."
      experimental
      experimentalDescription="Plugins is an experimental feature. The plugin API is not yet stable. Only install plugins from sources you trust."
    >
      {plugins.length === 0 ? (
        <View style={styles.empty}>
          <Puzzle size={48} color={colors.mutedForeground} style={{ opacity: 0.3 }} />
          <Text style={styles.emptyTitle}>No plugins installed</Text>
          <Text style={styles.emptyDesc}>Upload a plugin .zip file to get started.</Text>
        </View>
      ) : (
        <View style={{ gap: spacing.sm }}>
          {plugins.map((plugin) => {
            const expanded = expandedId === plugin.id;
            const status = STATUS_STYLE[plugin.status];
            return (
              <View
                key={plugin.id}
                style={[
                  styles.card,
                  plugin.status === 'error' && { borderColor: colors.errorBorder },
                ]}
              >
                <View style={styles.cardHeader}>
                  <Pressable
                    style={{ flex: 1 }}
                    onPress={() => setExpandedId(expanded ? null : plugin.id)}
                  >
                    <View style={styles.headerRow}>
                      <Text style={styles.pluginName} numberOfLines={1}>{plugin.name}</Text>
                      <View style={[styles.statusPill, { backgroundColor: status.bg }]}>
                        <Text style={[styles.statusText, { color: status.fg }]}>{plugin.status}</Text>
                      </View>
                      {plugin.forceEnabled && (
                        <View style={styles.forcedPill}>
                          <Lock size={10} color="#fbbf24" />
                          <Text style={styles.forcedText}>Forced</Text>
                        </View>
                      )}
                    </View>
                    <View style={styles.metaRow}>
                      <Text style={styles.meta}>{plugin.author}</Text>
                      <Text style={styles.metaDot}>v{plugin.version}</Text>
                      <Text style={styles.metaDot}>{plugin.type}</Text>
                    </View>
                  </Pressable>
                  <ToggleSwitch
                    checked={plugin.enabled}
                    onChange={() => togglePlugin(plugin.id)}
                    disabled={plugin.forceEnabled}
                  />
                </View>

                {expanded && (
                  <View style={styles.cardBody}>
                    {plugin.description && (
                      <Text style={styles.description}>{plugin.description}</Text>
                    )}

                    {plugin.error && (
                      <View style={styles.errorBox}>
                        <AlertTriangle size={14} color={colors.error} />
                        <Text style={styles.errorText}>{plugin.error}</Text>
                      </View>
                    )}

                    {plugin.permissions.length > 0 && (
                      <View>
                        <Text style={styles.sectionLabel}>Permissions</Text>
                        <View style={styles.permWrap}>
                          {plugin.permissions.map((p) => (
                            <View key={p} style={styles.permPill}>
                              <Text style={styles.permText}>{p}</Text>
                            </View>
                          ))}
                        </View>
                      </View>
                    )}

                    <View style={styles.uninstallRow}>
                      <Button
                        variant="destructive"
                        size="sm"
                        icon={<Trash2 size={14} color="#fff" />}
                        onPress={() => uninstall(plugin.id)}
                        disabled={plugin.forceEnabled}
                      >
                        Uninstall
                      </Button>
                    </View>
                  </View>
                )}
              </View>
            );
          })}
        </View>
      )}

      <SettingItem label="Upload Plugin" description="Install a new plugin from a .zip file.">
        <Button variant="outline" size="sm" icon={<Upload size={14} color={colors.text} />}>
          Upload .zip
        </Button>
      </SettingItem>
    </SettingsSection>
  );
}

const styles = StyleSheet.create({
  empty: {
    alignItems: 'center',
    paddingVertical: spacing.xxxl,
    gap: spacing.sm,
  },
  emptyTitle: { ...typography.body, color: colors.mutedForeground },
  emptyDesc: { ...typography.caption, color: colors.mutedForeground },
  card: {
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
  pluginName: { ...typography.bodyMedium, color: colors.text },
  statusPill: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: radius.full },
  statusText: { fontSize: 10, fontWeight: '500' },
  forcedPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.full,
    backgroundColor: 'rgba(251, 191, 36, 0.15)',
  },
  forcedText: { fontSize: 10, fontWeight: '500', color: '#fbbf24' },
  metaRow: { flexDirection: 'row', gap: spacing.sm, marginTop: 2 },
  meta: { ...typography.caption, color: colors.mutedForeground },
  metaDot: { ...typography.caption, color: colors.mutedForeground, opacity: 0.6 },
  cardBody: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    padding: spacing.md,
    gap: spacing.md,
  },
  description: { ...typography.caption, color: colors.mutedForeground },
  errorBox: {
    flexDirection: 'row',
    gap: spacing.sm,
    padding: spacing.sm,
    borderRadius: radius.sm,
    backgroundColor: colors.errorBg,
    alignItems: 'flex-start',
  },
  errorText: { ...typography.caption, color: colors.error, flex: 1 },
  sectionLabel: { ...typography.captionMedium, color: colors.text, marginBottom: 4 },
  permWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 4 },
  permPill: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.xs,
    backgroundColor: colors.muted,
  },
  permText: { fontSize: 10, color: colors.mutedForeground },
  uninstallRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
});
