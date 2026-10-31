import React from 'react';
import { View, Text, Pressable, StyleSheet, type TextInput } from 'react-native';
import { Eye, EyeOff, KeyRound } from '../../components/icons';
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
  notice?: { title: string; detail?: string; tone?: 'error' | 'info' } | null;
  /** Access-token sign-in in place of username and password. */
  tokenMode?: boolean;
  token?: string;
  onChangeToken?: (value: string) => void;
  onToggleTokenMode?: () => void;
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
  tokenMode = false,
  token = '',
  onChangeToken,
  onToggleTokenMode,
}: PasswordStepProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const [showPassword, setShowPassword] = React.useState(false);
  // Return moves username → password → code, then signs in.
  const passwordRef = React.useRef<TextInput>(null);
  const totpRef = React.useRef<TextInput>(null);

  return (
    <View style={styles.root}>
      <View style={styles.heading}>
        <Text style={styles.title}>{t('login.mobile.password_title', 'Sign in to {host}', { host: hostOf(serverUrl) })}</Text>
        <Text style={styles.subtitle}>
          {tokenMode
            ? t('login.token_hint', "Create an API token in your mail provider's settings and paste it here.")
            : t('login.mobile.password_subtitle', 'Your password is sent to this server only, and stored in the device keychain.')}
        </Text>
      </View>

      {tokenMode ? (
        <Input
          label={t('login.token_label', 'Access token')}
          placeholder={t('login.token_placeholder', 'Paste your API token')}
          value={token}
          onChangeText={(value) => onChangeToken?.(value)}
          testID="login-token-input"
          autoFocus
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          spellCheck={false}
          returnKeyType="go"
          onSubmitEditing={onSubmit}
        />
      ) : null}

      {tokenMode ? null : (
        <>
          <Input
            label={t('login.mobile.username_label', 'Email or username')}
            placeholder={t('login.username_placeholder', 'user@example.com')}
            value={email}
            onChangeText={onChangeEmail}
            testID="login-username-input"
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="email"
            textContentType="username"
            keyboardType="email-address"
            returnKeyType="next"
            blurOnSubmit={false}
            onSubmitEditing={() => passwordRef.current?.focus()}
          />

          <Input
            label={t('login.password_label', 'Password')}
            placeholder={t('login.password_placeholder', 'Enter your password')}
            value={password}
            onChangeText={onChangePassword}
            testID="login-password-input"
            autoFocus={Boolean(email)}
            secureTextEntry={!showPassword}
            autoComplete="current-password"
            textContentType="password"
            ref={passwordRef}
            returnKeyType={totpRequired ? 'next' : 'go'}
            blurOnSubmit={!totpRequired}
            onSubmitEditing={totpRequired ? () => totpRef.current?.focus() : onSubmit}
            rightIcon={
              <Pressable
                onPress={() => setShowPassword((v) => !v)}
                hitSlop={14}
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
              ref={totpRef}
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
        </>
      )}

      {notice ? <LoginNotice title={notice.title} detail={notice.detail} tone={notice.tone} live /> : null}

      <Button variant="default" size="md" onPress={onSubmit}>
        {t('login.sign_in', 'Sign in')}
      </Button>

      {onToggleTokenMode ? (
        <Pressable onPress={onToggleTokenMode} hitSlop={8} style={styles.toggle} accessibilityRole="button" testID="login-token-toggle">
          <KeyRound size={16} color={c.textLink} />
          <Text style={styles.link}>
            {tokenMode ? t('login.password_toggle', 'Sign in with a password') : t('login.token_toggle', 'Sign in with an access token')}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    root: { gap: spacing.lg },
    heading: { gap: spacing.sm },
    title: { ...typography.h1, color: c.text },
    subtitle: { ...typography.body, color: c.textSecondary },
    toggle: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.xs, paddingVertical: spacing.xs },
    link: { ...typography.body, color: c.textLink },
  });
}
