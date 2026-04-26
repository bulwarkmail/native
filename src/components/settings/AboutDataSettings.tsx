import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Pressable, Linking, Alert } from 'react-native';
import Constants from 'expo-constants';
import { ExternalLink } from 'lucide-react-native';
import { SettingsSection, SettingItem, ToggleSwitch } from './settings-section';
import Button from '../Button';
import { colors, spacing, radius, typography } from '../../theme/tokens';
import { useSettingsStore } from '../../stores/settings-store';

const APP_VERSION = Constants.expoConfig?.version ?? '0.0.0';
const GIT_COMMIT = (Constants.expoConfig?.extra as { commit?: string } | undefined)?.commit ?? 'dev';

const DEBUG_CATEGORIES = [
  { id: 'jmap',       label: 'JMAP',       description: 'JMAP request and response logs.' },
  { id: 'auth',       label: 'Auth',       description: 'Authentication and session events.' },
  { id: 'sync',       label: 'Sync',       description: 'Background sync operations.' },
  { id: 'render',     label: 'Render',     description: 'React render counts and timings.' },
];

export function AboutDataSettings() {
  const senderFavicons = useSettingsStore((s) => s.senderFavicons);
  const setSenderFaviconsStore = useSettingsStore((s) => s.setSenderFavicons);
  const hydrated = useSettingsStore((s) => s.hydrated);
  const hydrate = useSettingsStore((s) => s.hydrate);
  const resetExternalContentPolicy = useSettingsStore((s) => s.setExternalContentPolicy);
  const trustedSenders = useSettingsStore((s) => s.trustedSenders);
  const removeTrustedSender = useSettingsStore((s) => s.removeTrustedSender);

  const [debugMode, setDebugMode] = useState(false);
  const [debugCategories, setDebugCategories] = useState<Record<string, boolean>>(
    Object.fromEntries(DEBUG_CATEGORIES.map((c) => [c.id, true]))
  );
  const [syncEnabled, setSyncEnabled] = useState(true);
  const [confirmReset, setConfirmReset] = useState(false);

  useEffect(() => {
    if (!hydrated) void hydrate();
  }, [hydrated, hydrate]);

  const handleReset = () => {
    resetExternalContentPolicy('ask');
    setSenderFaviconsStore(true);
    for (const email of trustedSenders) removeTrustedSender(email);
    setConfirmReset(false);
    Alert.alert('Settings reset', 'Saved settings have been restored to defaults.');
  };

  return (
    <View style={styles.container}>
      <View style={styles.aboutBox}>
        <View style={styles.aboutRow}>
          <View style={styles.logo}>
            <Text style={styles.logoText}>B</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.aboutTitle}>About</Text>
            <Text style={styles.aboutVersion}>
              v{APP_VERSION}{' '}
              <Text style={styles.aboutCommit}>({GIT_COMMIT})</Text>
            </Text>
          </View>
          <Pressable
            style={styles.ghLink}
            onPress={() => Linking.openURL('https://github.com/bulwarkmail/webmail')}
          >
            <Text style={styles.ghText}>GitHub</Text>
            <ExternalLink size={12} color={colors.mutedForeground} />
          </Pressable>
        </View>
      </View>

      <SettingsSection title="Advanced" description="Low-level options and troubleshooting.">
        <SettingItem label="Debug mode" description="Enable verbose logging for support and development.">
          <ToggleSwitch checked={debugMode} onChange={setDebugMode} />
        </SettingItem>

        {debugMode && (
          <View style={styles.debugCategoriesBox}>
            <Text style={styles.debugCategoriesHint}>
              Which categories to include in debug output.
            </Text>
            {DEBUG_CATEGORIES.map((cat) => (
              <SettingItem key={cat.id} label={cat.label} description={cat.description}>
                <ToggleSwitch
                  checked={debugCategories[cat.id] !== false}
                  onChange={(v) => setDebugCategories({ ...debugCategories, [cat.id]: v })}
                />
              </SettingItem>
            ))}
          </View>
        )}

        <SettingItem label="Settings sync" description="Sync settings across your signed-in devices.">
          <ToggleSwitch checked={syncEnabled} onChange={setSyncEnabled} />
        </SettingItem>

        <SettingItem
          label="Sender favicons"
          description="Fetch website favicons for sender avatars (experimental)."
        >
          <ToggleSwitch checked={senderFavicons} onChange={setSenderFaviconsStore} />
        </SettingItem>

        <SettingItem label="Reset settings" description="Restore saved preferences (external content, trusted senders, favicons) to defaults.">
          <Button
            variant={confirmReset ? 'destructive' : 'outline'}
            size="sm"
            onPress={() => {
              if (confirmReset) {
                handleReset();
              } else {
                setConfirmReset(true);
                setTimeout(() => setConfirmReset(false), 5000);
              }
            }}
          >
            {confirmReset ? 'Confirm reset' : 'Reset'}
          </Button>
        </SettingItem>
      </SettingsSection>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: spacing.xxxl },
  aboutBox: {
    padding: spacing.xl,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  aboutRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
  },
  logo: {
    width: 48,
    height: 48,
    borderRadius: radius.md,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoText: { fontSize: 24, fontWeight: '700', color: colors.primaryForeground },
  aboutTitle: { ...typography.bodyMedium, color: colors.text },
  aboutVersion: { ...typography.caption, color: colors.mutedForeground, marginTop: 2 },
  aboutCommit: { color: colors.mutedForeground, opacity: 0.6 },
  ghLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  ghText: { ...typography.caption, color: colors.mutedForeground },
  debugCategoriesBox: {
    marginLeft: spacing.lg,
    paddingLeft: spacing.lg,
    borderLeftWidth: 2,
    borderLeftColor: colors.muted,
    gap: 4,
  },
  debugCategoriesHint: {
    ...typography.caption,
    color: colors.mutedForeground,
    marginBottom: spacing.sm,
  },
});
