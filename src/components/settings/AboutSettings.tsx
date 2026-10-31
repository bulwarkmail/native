import React, { useEffect } from 'react';
import { View, Text, Image, StyleSheet, Pressable, Linking, Platform } from 'react-native';
import Constants from 'expo-constants';
import { ExternalLink } from '../icons';
import { SettingsSection, SettingItem } from './settings-section';
import Button from '../Button';
import { spacing, radius, typography, type ThemePalette } from '../../theme/tokens';
import { useColors, useResolvedTheme } from '../../theme/colors';
import { useLocaleStore } from '../../stores/locale-store';
import { useAuthStore } from '../../stores/auth-store';
import { useAccountStore } from '../../stores/account-store';
import { useUpdatesStore } from '../../stores/updates-store';
import { supportsSideloadUpdates } from '../../lib/platform-capabilities';
import { buildIssueUrl, sourceCodeUrl, updateSourceUrl } from '../../lib/about-links';
import { helpLinks } from '../../lib/org-policy';
import { usePolicyStore } from '../../stores/policy-store';

const LOGO_WHITE = require('../../../assets/logos/Bulwark Logo White.png');
const LOGO_COLOR = require('../../../assets/logos/Bulwark Logo Color.png');

const extra = (Constants.expoConfig?.extra ?? {}) as { commit?: string; sourceCodeUrl?: string };
export const APP_NAME = Constants.expoConfig?.name ?? 'Bulwark';
export const APP_VERSION = Constants.expoConfig?.version ?? '0.0.0';
export const GIT_COMMIT = extra.commit ?? 'dev';
const SOURCE_URL = sourceCodeUrl(extra.sourceCodeUrl);

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

interface AboutSettingsProps {
  /** Opens a page below About: Updates, the licence list, Privacy. */
  onOpen?: (page: 'updates' | 'licences' | 'privacy') => void;
}

// English labels of the webmail's help_links keys.
const HELP_LINK_LABELS = {
  statement: 'Accessibility statement',
  feedback: 'Report a barrier',
  help: 'Help',
  easy_read: 'Easy Read',
  sign_language: 'Sign language',
} as const;

export function AboutSettings({ onOpen }: AboutSettingsProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const scheme = useResolvedTheme();
  const t = useLocaleStore((s) => s.t);
  const operatorLinks = usePolicyStore((s) => s.links);
  const locale = useLocaleStore((s) => s.locale);

  const authUsername = useAuthStore((s) => s.username);
  const authServerUrl = useAuthStore((s) => s.serverUrl);
  const activeAccountId = useAuthStore((s) => s.activeAccountId);
  const account = useAccountStore((s) => s.accounts.find((a) => a.id === activeAccountId));
  const serverUrl = account?.serverUrl || authServerUrl || '';
  const signedInAs = account?.email || account?.username || authUsername || '';

  const hydrated = useUpdatesStore((s) => s.hydrated);
  const hydrate = useUpdatesStore((s) => s.hydrate);
  const checking = useUpdatesStore((s) => s.checking);
  const checkNow = useUpdatesStore((s) => s.checkNow);
  const lastCheckedAt = useUpdatesStore((s) => s.lastCheckedAt);
  const latest = useUpdatesStore((s) => s.cachedLatest);
  const updateAvailable = useUpdatesStore((s) => s.hasUpdate());
  const severity = latest?.severity ?? 'normal';

  useEffect(() => {
    if (!hydrated) void hydrate();
  }, [hydrated, hydrate]);

  const updateLine = updateAvailable && latest
    ? severity === 'security'
      ? t('settings.advanced.about.security_update', 'Security update: {version}', { version: latest.tag })
      : severity === 'deprecated'
        ? t('settings.advanced.about.deprecated_update', 'Update required: {version}', { version: latest.tag })
        : t('settings.advanced.about.update_available', 'Update: {version}', { version: latest.tag })
    : lastCheckedAt > 0
      ? t('settings.about.up_to_date', 'Up to date')
      : null;
  const openUpdate = () => {
    if (supportsSideloadUpdates && onOpen) onOpen('updates');
    else void Linking.openURL(updateSourceUrl(Platform.OS, latest?.htmlUrl));
  };

  const lastChecked = lastCheckedAt > 0
    ? t('settings.about.checked_at', 'Checked {when}', {
      when: new Date(lastCheckedAt).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' }),
    })
    : t('settings.about.never_checked', 'Not checked yet');

  const reportProblem = () => {
    const constants = Platform.constants as { Release?: string; Model?: string };
    void Linking.openURL(buildIssueUrl(
      { version: APP_VERSION, commit: GIT_COMMIT },
      {
        os: Platform.OS,
        osVersion: Platform.Version,
        release: constants.Release,
        model: constants.Model,
      },
    ));
  };

  return (
    <View style={styles.container}>
      <View style={styles.card}>
        <Image
          source={scheme === 'dark' ? LOGO_WHITE : LOGO_COLOR}
          style={styles.logo}
          resizeMode="contain"
          accessibilityIgnoresInvertColors
          accessible={false}
        />
        <View style={styles.cardText}>
          <Text style={styles.appName}>{APP_NAME}</Text>
          <Text style={styles.version}>v{APP_VERSION} ({GIT_COMMIT})</Text>
          {updateLine && (
            updateAvailable ? (
              <Pressable onPress={openUpdate} accessibilityRole="link" hitSlop={{ top: 12, bottom: 12 }}>
                <Text style={[styles.updateLine, severity === 'normal' ? styles.updateLineNew : styles.updateLineUrgent]}>
                  {updateLine}
                </Text>
              </Pressable>
            ) : (
              <Text style={[styles.updateLine, styles.updateLineOk]}>{updateLine}</Text>
            )
          )}
        </View>
        <Pressable
          onPress={() => void Linking.openURL(SOURCE_URL)}
          accessibilityRole="link"
          style={styles.sourceLink}
        >
          <Text style={styles.sourceText}>{t('settings.about.source_code', 'Source code')}</Text>
          <ExternalLink size={14} color={c.mutedForeground} />
        </Pressable>
      </View>

      <SettingsSection
        title={t('settings.about.this_device', 'This device')}
        description={t('settings.about.this_device_desc', 'What the app is connected to and how to get help.')}
      >
        <SettingItem
          label={t('settings.about.server', 'Server')}
          description={serverUrl
            ? t('settings.about.server_value', '{host} · signed in as {user}', { host: hostOf(serverUrl), user: signedInAs })
            : undefined}
        />
        {supportsSideloadUpdates && (
          <SettingItem label={t('settings.about.updates', 'Updates')} description={lastChecked}>
            <Button variant="outline" size="sm" loading={checking} onPress={() => void checkNow({ force: true })}>
              {t('settings.about.check_now', 'Check now')}
            </Button>
          </SettingItem>
        )}
        <SettingItem
          label={t('settings.about.licences', 'Open-source licences')}
          description={t('settings.about.licences_desc', 'AGPL-3.0 for the app, and the libraries it uses')}
          onPress={() => onOpen?.('licences')}
        />
        <SettingItem
          label={t('settings.about.privacy', 'Privacy')}
          description={t('settings.about.privacy_desc', 'What stays on this device and what goes to your server')}
          onPress={() => onOpen?.('privacy')}
        />
        {/* The operator's accessibility and help links, from the account's webmail. */}
        {helpLinks(operatorLinks).map((link) => (
          <SettingItem
            key={link.id}
            label={t(`help_links.${link.id}`, HELP_LINK_LABELS[link.id])}
            onPress={() => void Linking.openURL(link.href)}
            link="external"
          />
        ))}
        <SettingItem
          label={t('settings.about.report_problem', 'Report a problem')}
          description={t('settings.about.report_problem_desc', 'Opens an issue on GitHub with the version filled in')}
          onPress={reportProblem}
          link="external"
          noBorder
        />
      </SettingsSection>
    </View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    container: { gap: spacing.xxl },
    card: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 14,
      padding: spacing.lg,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.card,
    },
    logo: { width: 48, height: 48 },
    cardText: { flex: 1, minWidth: 0, gap: 3 },
    appName: { fontSize: 16, fontWeight: '600', lineHeight: 22, color: c.text },
    version: { ...typography.caption, fontSize: 13, lineHeight: 18, color: c.mutedForeground },
    updateLine: { ...typography.caption },
    updateLineOk: { color: c.success },
    updateLineNew: { color: c.textLink },
    updateLineUrgent: { color: c.error },
    sourceLink: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      minHeight: 48,
      paddingHorizontal: 4,
    },
    sourceText: { fontSize: 13, color: c.mutedForeground },
  });
}
