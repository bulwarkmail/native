import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Globe } from 'lucide-react-native';
import { spacing, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { Button, Input } from '../../components';
import LoginNotice from './LoginNotice';
import { useLocaleStore } from '../../stores/locale-store';

interface TokenStepProps {
  server: string;
  token: string;
  onChangeServer: (value: string) => void;
  onChangeToken: (value: string) => void;
  onSubmit: () => void;
  notice?: { title: string; detail?: string } | null;
}

/** Sign in with an access token (an API token from the mail provider's
 *  settings) instead of a password. The token goes to this server only and is
 *  kept in the device keychain; it is never shown again or logged. */
export default function TokenStep({
  server,
  token,
  onChangeServer,
  onChangeToken,
  onSubmit,
  notice,
}: TokenStepProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);

  return (
    <View style={styles.root}>
      <View style={styles.heading}>
        <Text style={styles.title}>{t('login.token_label', 'Access token')}</Text>
        <Text style={styles.subtitle}>
          {t('login.token_hint', "Create an API token in your mail provider's settings and paste it here.")}
        </Text>
      </View>

      <Input
        label={t('login.mobile.server_label', 'Server address')}
        placeholder="mail.example.com"
        value={server}
        onChangeText={onChangeServer}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        leftIcon={<Globe size={17} color={c.textMuted} />}
      />

      <Input
        label={t('login.token_label', 'Access token')}
        placeholder={t('login.token_placeholder', 'Paste your API token')}
        value={token}
        onChangeText={onChangeToken}
        autoFocus={Boolean(server)}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
        textContentType="password"
        returnKeyType="go"
        onSubmitEditing={onSubmit}
      />

      {notice ? <LoginNotice title={notice.title} detail={notice.detail} /> : null}

      <Button variant="default" size="md" onPress={onSubmit}>
        {t('login.sign_in', 'Sign in')}
      </Button>
    </View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    root: { gap: spacing.lg },
    heading: { gap: spacing.sm },
    title: { ...typography.h1, color: c.text },
    subtitle: { ...typography.body, color: c.textSecondary },
  });
}
