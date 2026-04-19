import React from 'react';
import { View, Text, Pressable, StyleSheet, KeyboardAvoidingView, Platform, Image } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Eye, EyeOff, X } from 'lucide-react-native';
import { colors, spacing, radius, typography, componentSizes } from '../theme/tokens';
import { Button, Input } from '../components';
import { useAuthStore } from '../stores/auth-store';

interface LoginScreenProps {
  onLogin?: () => void;
  isAddMode?: boolean;
  onCancel?: () => void;
}

export default function LoginScreen({ onLogin, isAddMode, onCancel }: LoginScreenProps) {
  const login = useAuthStore((state) => state.login);
  const isLoading = useAuthStore((state) => state.isLoading);
  const error = useAuthStore((state) => state.error);
  const clearError = useAuthStore((state) => state.clearError);

  const [serverUrl, setServerUrl] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [showPassword, setShowPassword] = React.useState(false);

  const canSubmit = Boolean(serverUrl.trim() && email.trim() && password);

  const handleLogin = async () => {
    if (!canSubmit) {
      return;
    }

    try {
      await login(serverUrl.trim(), email.trim(), password, { addAccount: isAddMode });
      onLogin?.();
    } catch {
      // Store state already contains the user-facing error.
    }
  };

  const updateField = React.useCallback(
    (setter: React.Dispatch<React.SetStateAction<string>>) => (value: string) => {
      if (useAuthStore.getState().error) {
        clearError();
      }
      setter(value);
    },
    [clearError],
  );

  const onChangeServerUrl = React.useMemo(() => updateField(setServerUrl), [updateField]);
  const onChangeEmail = React.useMemo(() => updateField(setEmail), [updateField]);
  const onChangePassword = React.useMemo(() => updateField(setPassword), [updateField]);

  return (
    <SafeAreaView style={styles.container}>
      {isAddMode && onCancel ? (
        <Pressable onPress={onCancel} style={styles.cancelButton} hitSlop={10}>
          <X size={24} color={colors.text} />
        </Pressable>
      ) : null}
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.keyboardView}
      >
        <View style={styles.content}>
          {/* Logo & Branding */}
          <View style={styles.branding}>
            <View style={styles.logoContainer}>
              <Image
                source={require('../../assets/logos/Bulwark Logo White.png')}
                style={styles.logoImage}
                resizeMode="contain"
              />
            </View>
            <Text style={styles.appName}>{isAddMode ? 'Add account' : 'Bulwark Mail'}</Text>
            <Text style={styles.tagline}>
              {isAddMode ? 'Sign in to a second account' : 'Secure. Private. Yours.'}
            </Text>
          </View>

          {/* Login Form */}
          <View style={styles.form}>
            <Input
              label="Server URL"
              placeholder="https://mail.example.com"
              value={serverUrl}
              onChangeText={onChangeServerUrl}
              autoCapitalize="none"
              keyboardType="url"
              autoCorrect={false}
            />

            <Input
              label="Email or Username"
              placeholder="you@example.com"
              value={email}
              onChangeText={onChangeEmail}
              autoCapitalize="none"
              keyboardType="email-address"
              autoCorrect={false}
            />

            <Input
              label="Password"
              placeholder="Enter your password"
              value={password}
              onChangeText={onChangePassword}
              secureTextEntry={!showPassword}
              onSubmitEditing={() => {
                void handleLogin();
              }}
              rightIcon={
                <Pressable onPress={() => setShowPassword(!showPassword)}>
                  {showPassword ? (
                    <EyeOff size={20} color={colors.textMuted} />
                  ) : (
                    <Eye size={20} color={colors.textMuted} />
                  )}
                </Pressable>
              }
            />

            <Button
              variant="default"
              size="lg"
              onPress={() => {
                void handleLogin();
              }}
              disabled={!canSubmit}
              loading={isLoading}
              style={styles.loginButton}
            >
              {isLoading ? 'Signing in...' : 'Sign In'}
            </Button>

            {error ? <Text style={styles.errorText}>{error}</Text> : null}

            {/* OAuth divider */}
            <View style={styles.divider}>
              <View style={styles.dividerLine} />
              <Text style={styles.dividerText}>or continue with</Text>
              <View style={styles.dividerLine} />
            </View>

            {/* OAuth buttons */}
            <View style={styles.oauthRow}>
              <Button variant="outline" size="md" disabled>
                SSO Provider
              </Button>
            </View>
          </View>

          {/* Footer */}
          <View style={styles.footer}>
            <Text style={styles.footerText}>Bulwark Mobile v0.0.1</Text>
            <Text style={styles.footerLink}>Privacy Policy</Text>
          </View>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  cancelButton: {
    position: 'absolute',
    top: 50,
    left: 16,
    zIndex: 10,
    padding: 8,
  },
  keyboardView: { flex: 1 },
  content: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: spacing.xxl,
  },
  branding: { alignItems: 'center', marginBottom: 40 },
  logoContainer: {
    width: 80,
    height: 80,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.lg,
  },
  logoImage: {
    width: 72,
    height: 72,
  },
  appName: { ...typography.h1, color: colors.text },
  tagline: { ...typography.caption, color: colors.textMuted, marginTop: spacing.xs },

  form: { gap: spacing.lg },

  loginButton: {
    marginTop: spacing.sm,
  },
  errorText: {
    ...typography.caption,
    color: colors.error,
    textAlign: 'center',
  },

  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: spacing.md,
    gap: spacing.md,
  },
  dividerLine: { flex: 1, height: 1, backgroundColor: colors.border },
  dividerText: { ...typography.caption, color: colors.textMuted },

  oauthRow: { gap: spacing.md },

  footer: { alignItems: 'center', marginTop: 40, gap: spacing.xs },
  footerText: { ...typography.caption, color: colors.textMuted },
  footerLink: { ...typography.caption, color: colors.textLink },
});
