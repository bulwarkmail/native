import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Mail } from 'lucide-react-native';
import { spacing, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { Button, Input } from '../../components';
import LoginNotice from './LoginNotice';
import { useLocaleStore } from '../../stores/locale-store';

interface EmailStepProps {
  isAddMode: boolean;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onKnowServer: () => void;
  isSearching: boolean;
  notice?: { title: string; detail?: string } | null;
  /** Addresses used before on this device, offered as one-tap fills. */
  suggestions?: string[];
}

/**
 * One field, keyboard already up. The button stays enabled and validates on
 * press, so nobody is left guessing which field disabled it.
 */
export default function EmailStep({
  isAddMode,
  value,
  onChange,
  onSubmit,
  onKnowServer,
  isSearching,
  notice,
  suggestions = [],
}: EmailStepProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);

  return (
    <View style={styles.root}>
      <View style={styles.heading}>
        <Text style={styles.title}>
          {isAddMode ? t('login.mobile.email_step_title_add', "What's the other address?") : t('login.mobile.email_step_title', "What's your email address?")}
        </Text>
        <Text style={styles.subtitle}>
          {t('login.mobile.email_step_subtitle', "That's usually all we need to find your mail server.")}
        </Text>
      </View>

      <Input
        placeholder={t('login.username_placeholder', 'user@example.com')}
        value={value}
        onChangeText={onChange}
        autoFocus
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="email"
        textContentType="username"
        keyboardType="email-address"
        returnKeyType="go"
        editable={!isSearching}
        onSubmitEditing={onSubmit}
        leftIcon={<Mail size={17} color={c.textMuted} />}
      />

      <Text style={styles.hint}>{t('login.mobile.email_step_hint', 'Works with Stalwart and any other JMAP mail server.')}</Text>

      {suggestions.length > 0 && !value ? (
        <View style={styles.suggestions}>
          {suggestions.slice(0, 5).map((address) => (
            <Pressable
              key={address}
              onPress={() => onChange(address)}
              style={styles.suggestion}
              accessibilityRole="button"
              accessibilityLabel={address}
            >
              <Text style={styles.suggestionText} numberOfLines={1}>{address}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      {notice ? <LoginNotice title={notice.title} detail={notice.detail} /> : null}

      <Button variant="default" size="md" onPress={onSubmit} loading={isSearching}>
        {isSearching ? t('login.mobile.looking_up', 'Looking up your server…') : t('login.mobile.continue', 'Continue')}
      </Button>

      <Pressable onPress={onKnowServer} disabled={isSearching} hitSlop={8} style={styles.link}>
        <Text style={styles.linkText}>{t('login.mobile.know_server', 'I know my server address')}</Text>
      </Pressable>
    </View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    root: { gap: spacing.lg },
    heading: { gap: spacing.sm },
    title: { ...typography.h1, color: c.text },
    subtitle: { ...typography.body, color: c.textSecondary },
    hint: { ...typography.caption, color: c.textMuted, marginTop: -spacing.sm },
    suggestions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    suggestion: {
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 999,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs,
      maxWidth: '100%',
    },
    suggestionText: { ...typography.caption, color: c.textSecondary },
    link: { alignItems: 'center', paddingVertical: spacing.sm },
    linkText: { ...typography.body, color: c.textMuted },
  });
}
