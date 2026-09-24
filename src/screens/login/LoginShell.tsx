import React from 'react';
import {
  View,
  Text,
  Pressable,
  ScrollView,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Constants from 'expo-constants';
import { ArrowLeft, X } from 'lucide-react-native';
import { spacing, typography, componentSizes, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useLocaleStore } from '../../stores/locale-store';

const APP_VERSION = Constants.expoConfig?.version ?? '0.0.0';

interface LoginShellProps {
  children: React.ReactNode;
  /** Renders a back chevron. Omit on the first step of the flow. */
  onBack?: () => void;
  /** Renders a close X on the right — add-account mode only. */
  onClose?: () => void;
  /** Vertically centres the content instead of stacking from the top. */
  centered?: boolean;
  showFooter?: boolean;
}

/**
 * Shared chrome for every sign-in step: safe area, keyboard avoidance, the
 * back/close affordances, and the version footer. Steps supply only their own
 * content so they all sit on the same grid.
 */
export default function LoginShell({
  children,
  onBack,
  onClose,
  centered = false,
  showFooter = false,
}: LoginShellProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.flex}
      >
        <View style={styles.header}>
          {onBack ? (
            <Pressable
              onPress={onBack}
              hitSlop={12}
              style={styles.headerButton}
              accessibilityRole="button"
              accessibilityLabel={t('common.back', 'Back')}
            >
              <ArrowLeft size={22} color={c.textSecondary} />
            </Pressable>
          ) : (
            <View style={styles.headerButton} />
          )}
          {onClose ? (
            <Pressable
              onPress={onClose}
              hitSlop={12}
              style={styles.headerButton}
              accessibilityRole="button"
              accessibilityLabel={t('common.close', 'Close')}
            >
              <X size={22} color={c.textSecondary} />
            </Pressable>
          ) : (
            <View style={styles.headerButton} />
          )}
        </View>

        <ScrollView
          style={styles.flex}
          contentContainerStyle={[styles.content, centered && styles.contentCentered]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {children}
        </ScrollView>

        {showFooter ? (
          <View style={styles.footer}>
            <Text style={styles.footerText}>Bulwark Mobile v{APP_VERSION}</Text>
          </View>
        ) : null}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: c.background },
    flex: { flex: 1 },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: spacing.lg,
      height: componentSizes.headerHeight,
    },
    headerButton: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
    content: {
      paddingHorizontal: spacing.lg,
      paddingBottom: spacing.xxxl,
    },
    contentCentered: { flexGrow: 1, justifyContent: 'center' },
    footer: { alignItems: 'center', paddingBottom: spacing.lg, gap: spacing.xs },
    footerText: { ...typography.caption, color: c.textMuted },
  });
}
