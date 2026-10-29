import React, { useState } from 'react';
import { View, Text, StyleSheet, Alert } from 'react-native';
import { SettingsSection, SettingItem, ToggleSwitch } from './settings-section';
import Button from '../Button';
import { spacing, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { ALL_DEBUG_CATEGORIES, useSettingsStore, type DebugCategory } from '../../stores/settings-store';
import { useLocaleStore } from '../../stores/locale-store';
import { clearCachedData } from '../../lib/clear-cached-data';

/** Settings → Storage & backup → Troubleshooting (webmail: the Debug page). */
export function TroubleshootingSettings() {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const debugMode = useSettingsStore((s) => s.debugMode);
  const debugCategories = useSettingsStore((s) => s.debugCategories);
  const updateSetting = useSettingsStore((s) => s.updateSetting);
  const [refreshing, setRefreshing] = useState(false);

  const handleRefreshCache = async () => {
    setRefreshing(true);
    try {
      await clearCachedData();
    } catch (err) {
      Alert.alert(
        t('settings.advanced.refresh_cache.label', 'Refresh cached data'),
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <View style={styles.container}>
      <SettingsSection
        title={t('settings.troubleshooting.cache_title', 'Cached data')}
        description={t('settings.troubleshooting.cache_desc', 'When a list looks stale or wrong.')}
      >
        <SettingItem
          label={t('settings.advanced.refresh_cache.label', 'Refresh cached data')}
          description={t(
            'settings.advanced.refresh_cache.description',
            'Reload contacts, calendars, and folders from the server. Keeps your accounts and sessions — fixes a stale or wrong view without signing out.',
          )}
          noBorder
        >
          <Button variant="outline" size="sm" onPress={() => void handleRefreshCache()} loading={refreshing}>
            {t('settings.advanced.refresh_cache.button', 'Refresh')}
          </Button>
        </SettingItem>
      </SettingsSection>

      <SettingsSection
        title={t('settings.advanced.debug_mode.label', 'Debug Mode')}
        description={t('settings.advanced.debug_mode.description', 'Enable detailed logging for troubleshooting')}
      >
        <SettingItem label={t('settings.advanced.debug_mode.label', 'Debug Mode')} noBorder={!debugMode}>
          <ToggleSwitch checked={debugMode} onChange={(v) => updateSetting('debugMode', v)} />
        </SettingItem>
        {debugMode && (
          <View style={styles.categories}>
            <Text style={styles.hint}>
              {t(
                'settings.advanced.debug_categories.description',
                "Select which categories to log. Disable categories you don't need to reduce console noise.",
              )}
            </Text>
            {ALL_DEBUG_CATEGORIES.map((cat: DebugCategory, i) => (
              <SettingItem
                key={cat}
                label={t(`settings.advanced.debug_categories.${cat}`, cat)}
                description={t(`settings.advanced.debug_categories.${cat}_description`, '')}
                noBorder={i === ALL_DEBUG_CATEGORIES.length - 1}
              >
                <ToggleSwitch
                  checked={debugCategories[cat] !== false}
                  onChange={(v) => updateSetting('debugCategories', { ...debugCategories, [cat]: v })}
                />
              </SettingItem>
            ))}
          </View>
        )}
      </SettingsSection>
    </View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    container: { gap: spacing.xxl },
    categories: {
      marginStart: spacing.xs,
      paddingStart: spacing.lg,
      borderStartWidth: 2,
      borderStartColor: c.muted,
    },
    hint: { ...typography.caption, color: c.mutedForeground, paddingTop: spacing.md },
  });
}
