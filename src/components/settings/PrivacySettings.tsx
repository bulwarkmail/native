import React from 'react';
import { View, Text, StyleSheet, Platform } from 'react-native';
import { SettingsSection } from './settings-section';
import { spacing, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useLocaleStore } from '../../stores/locale-store';
import { DEFAULT_RELAY_BASE_URL } from '../../lib/push-notifications';
import { supportsSideloadUpdates } from '../../lib/platform-capabilities';

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Settings → About → Privacy: where the app keeps and sends data. */
export function PrivacySettings() {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);

  const paragraph = (text: string) => <Text style={styles.paragraph}>{text}</Text>;

  return (
    <View style={styles.container}>
      <SettingsSection title={t('settings.privacy.phone_title', 'On this phone')}>
        {paragraph(t(
          'settings.privacy.phone_secure',
          'Your sign-in details are kept in the system\'s secure storage. Settings, the offline mail cache and changes waiting to sync are kept in the app\'s own storage.',
        ))}
        {Platform.OS === 'android' && paragraph(t(
          'settings.privacy.phone_backup',
          'None of it goes into Android\'s cloud backup.',
        ))}
      </SettingsSection>

      <SettingsSection title={t('settings.privacy.server_title', 'Your mail server')}>
        {paragraph(t(
          'settings.privacy.server',
          'Mail, calendars, contacts and files are loaded from your server and saved back to it. Apart from the connections below, the app talks only to your server.',
        ))}
      </SettingsSection>

      <SettingsSection title={t('settings.privacy.push_title', 'Push notifications')}>
        {paragraph(t(
          'settings.privacy.push',
          'When notifications are on, your server tells the push relay ({relay}) that something changed, and the relay wakes the app through {service}. The relay sees a device token and a change marker, never your mail. You can use your own relay under Notifications.',
          {
            relay: hostOf(DEFAULT_RELAY_BASE_URL),
            service: Platform.OS === 'ios'
              ? t('settings.privacy.service_apple', 'Apple\'s push service')
              : t('settings.privacy.service_google', 'Google\'s push service'),
          },
        ))}
      </SettingsSection>

      <SettingsSection title={t('settings.privacy.other_title', 'Other connections')}>
        {paragraph(t(
          'settings.privacy.favicons',
          'Sender icons for business mail come from DuckDuckGo\'s icon service, which sees the sender\'s domain. Turn them off under Appearance → Sender favicons.',
        ))}
        {paragraph(supportsSideloadUpdates
          ? t('settings.privacy.updates_android', 'The app asks GitHub for the latest release to tell you about updates. Turn that off under Updates.')
          : t('settings.privacy.updates', 'The app asks GitHub for the latest release to tell you about updates.'))}
        {paragraph(t(
          'settings.privacy.no_tracking',
          'The app has no analytics and no ads.',
        ))}
      </SettingsSection>
    </View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    container: { gap: spacing.xxl },
    paragraph: { ...typography.body, color: c.text, paddingVertical: spacing.xs },
  });
}
