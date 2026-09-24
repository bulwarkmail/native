import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Eye, EyeOff } from 'lucide-react-native';
import { spacing, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { Button, Input } from '../../components';
import LoginNotice from './LoginNotice';
import { useLocaleStore } from '../../stores/locale-store';

interface PasswordStepProps {
  serverUrl: string;
  email: string;
  password: string;
  onChangeEmail: (value: string) => void;
  onChangePassword: (value: string) => void;
  /** Second factor, shown once the server answered 402 "MFA code required". */
  totp?: string;
  totpRequired?: boolean;
  onChangeTotp?: (value: string) => void;
  onSubmit: () => void;
  notice?: { title: string; detail?: string } | null;
}

function hostOf(url: string): string {
  return url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split('/')[0];
}

/** The fallback for servers without the browser hand-off — and the only step
 *  where a password is typed into the app. */
export default function PasswordStep({
  serverUrl,
  email,
  password,
  onChangeEmail,
  onChangePassword,
  totp = '',
  totpRequired = false,
  onChangeTotp,
  onSubmit,
  notice,
}: PasswordStepProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const [showPassword, setShowPassword] = React.useState(false);

  return (
    <View style={styles.root}>
      <View style={styles.heading}>
        <Text style={styles.title}>{t('login.mobile.password_title', 'Sign in to {host}', { host: hostOf(serverUrl) })}</Text>
        <Text style={styles.subtitle}>
          {t('login.mobile.password_subtitle', 'Your password is sent to this server only, and stored in the device keychain.')}
        </Text>
      </View>

      <Input
        label={t('login.mobile.username_label', 'Email or username')}
        placeholder={t('login.username_placeholder', 'user@example.com')}
        value={email}
        onChangeText={onChangeEmail}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="email"
        textContentType="username"
        keyboardType="email-address"
      />

      <Input
        label={t('login.password_label', 'Password')}
        placeholder={t('login.password_placeholder', 'Enter your password')}
        value={password}
        onChangeText={onChangePassword}
        autoFocus={Boolean(email)}
        secureTextEntry={!showPassword}
        autoComplete="current-password"
        textContentType="password"
        returnKeyType={totpRequired ? 'next' : 'go'}
        onSubmitEditing={totpRequired ? undefined : onSubmit}
        rightIcon={
          <Pressable
            onPress={() => setShowPassword((v) => !v)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={showPassword ? t('login.hide_password', 'Hide password') : t('login.show_password', 'Show password')}
          >
            {showPassword ? <EyeOff size={20} color={c.textMuted} /> : <Eye size={20} color={c.textMuted} />}
          </Pressable>
        }
      />

      {totpRequired ? (
        <Input
          label={t('login.totp_label', 'Two-factor code')}
          placeholder="123456"
          value={totp}
          onChangeText={(value) => onChangeTotp?.(value)}
          autoFocus
          keyboardType="number-pad"
          autoComplete="one-time-code"
          textContentType="oneTimeCode"
          maxLength={8}
          returnKeyType="go"
          onSubmitEditing={onSubmit}
        />
      ) : null}

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
