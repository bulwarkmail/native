import React, { useCallback, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, Pressable, TextInput,
  KeyboardAvoidingView, Platform, ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { X, AlertTriangle, CheckCircle } from '../icons';
import { spacing, radius, typography, componentSizes, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import Button from '../Button';
import { useLocaleStore } from '../../stores/locale-store';
import { SafeAreaModal } from '../SafeAreaModal';
import { MODAL_ORIENTATIONS } from '../../lib/modal-orientations';
import { seedsOnRender } from '../../lib/sieve/editor-seed';

interface SieveEditorSheetProps {
  visible: boolean;
  content: string;
  onSave: (content: string) => void;
  onClose: () => void;
  onValidate: (content: string) => Promise<{ isValid: boolean; errors?: string[] }>;
}

export function SieveEditorSheet({ visible, content, onSave, onClose, onValidate }: SieveEditorSheetProps) {
  const c = useColors();
  const styles = useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);

  const [script, setScript] = useState(content);
  const [isValidating, setIsValidating] = useState(false);
  const [validationResult, setValidationResult] = useState<{ isValid: boolean; errors?: string[] } | null>(null);
  const [showSaveWarning, setShowSaveWarning] = useState(false);

  // Seed the editor when it opens, with the script as it is then. A new
  // `content` while it is open (a store refresh) must not wipe what was
  // typed (#1162).
  const wasVisible = React.useRef(false);
  React.useEffect(() => {
    if (seedsOnRender(wasVisible.current, visible)) {
      setScript(content);
      setValidationResult(null);
      setShowSaveWarning(false);
    }
    wasVisible.current = visible;
  }, [visible, content]);

  const lineCount = script.split('\n').length;

  const handleValidate = useCallback(async () => {
    setIsValidating(true);
    setValidationResult(null);
    try {
      const result = await onValidate(script);
      setValidationResult(result);
    } catch {
      setValidationResult({ isValid: false, errors: [t('settings.filters.sieve_editor.validation_failed', 'Validation request failed')] });
    } finally {
      setIsValidating(false);
    }
  }, [script, onValidate, t]);

  const handleSave = useCallback(() => {
    if (!showSaveWarning) {
      setShowSaveWarning(true);
      return;
    }
    onSave(script);
  }, [script, showSaveWarning, onSave]);

  return (
    <SafeAreaModal supportedOrientations={MODAL_ORIENTATIONS} visible={visible} animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        <View style={styles.header}>
          <Pressable
            onPress={onClose}
            hitSlop={8}
            style={styles.headerClose}
            accessibilityRole="button"
            accessibilityLabel={t('common.close', 'Close')}
          >
            <X size={20} color={c.text} />
          </Pressable>
          <Text style={styles.headerTitle}>{t('settings.filters.sieve_editor.title', 'Sieve Script Editor')}</Text>
          <View style={styles.headerRightSpacer} />
        </View>

        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={styles.body}>
            <View style={styles.warningBanner}>
              <AlertTriangle size={16} color={c.warning} />
              <Text style={styles.warningText}>
                {t('settings.filters.sieve_editor.warning', 'Editing the raw Sieve script may break visual rule editing. Changes made here override the visual builder.')}
              </Text>
            </View>

            <ScrollView style={styles.editorWrap} contentContainerStyle={styles.editorContent}>
              <TextInput
                value={script}
                onChangeText={(v) => {
                  setScript(v);
                  setValidationResult(null);
                  setShowSaveWarning(false);
                }}
                style={styles.editor}
                multiline
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
                textAlignVertical="top"
                placeholder={t('settings.filters.sieve_editor.script_content', 'Sieve script')}
                placeholderTextColor={c.textMuted}
                accessibilityLabel={t('settings.filters.sieve_editor.script_content', 'Sieve script')}
              />
            </ScrollView>

            <Text style={styles.lineCount}>
              {t('settings.filters.sieve_editor.line_count', '{count, plural, one {# line} other {# lines}}', { count: lineCount })}
            </Text>

            {validationResult && (
              <View style={[styles.resultBanner, validationResult.isValid ? styles.resultOk : styles.resultErr]}>
                {validationResult.isValid ? (
                  <>
                    <CheckCircle size={16} color={c.success} />
                    <Text style={[styles.resultText, { color: c.success }]}>
                      {t('settings.filters.sieve_editor.valid', 'Script is valid')}
                    </Text>
                  </>
                ) : (
                  <>
                    <AlertTriangle size={16} color={c.error} />
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.resultText, { color: c.error, fontWeight: '600' }]}>
                        {t('settings.filters.sieve_editor.invalid', 'Script has errors')}
                      </Text>
                      {validationResult.errors?.map((err, i) => (
                        <Text key={i} style={styles.errorDetail}>{err}</Text>
                      ))}
                    </View>
                  </>
                )}
              </View>
            )}

            {showSaveWarning && (
              <View style={styles.warningBanner}>
                <AlertTriangle size={16} color={c.warning} />
                <Text style={styles.warningText}>
                  {t('settings.filters.sieve_editor.save_warning', 'Saving will overwrite any visual rules. This cannot be undone. Tap Save again to confirm.')}
                </Text>
              </View>
            )}
          </View>
        </KeyboardAvoidingView>

        <View style={styles.footer}>
          <Button
            variant="outline"
            onPress={handleValidate}
            disabled={isValidating || !script.trim()}
            icon={isValidating ? <ActivityIndicator size="small" color={c.text} /> : undefined}
          >
            {isValidating
              ? t('settings.filters.sieve_editor.validating', 'Validating...')
              : t('settings.filters.sieve_editor.validate', 'Validate')}
          </Button>
          <View style={styles.footerRight}>
            <Button variant="outline" onPress={onClose}>
              {t('settings.filters.sieve_editor.cancel', 'Cancel')}
            </Button>
            <Button onPress={handleSave} disabled={!script.trim()}>
              {showSaveWarning
                ? t('settings.filters.sieve_editor.confirm_save', 'Confirm Save')
                : t('settings.filters.sieve_editor.save', 'Save')}
            </Button>
          </View>
        </View>
      </SafeAreaView>
    </SafeAreaModal>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: c.background },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      height: componentSizes.headerHeight,
      paddingHorizontal: spacing.lg,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
      gap: spacing.sm,
    },
    headerClose: {
      width: 40, height: 40,
      alignItems: 'center', justifyContent: 'center',
      borderRadius: radius.md,
    },
    headerTitle: { ...typography.h3, color: c.text, flex: 1, textAlign: 'center' },
    headerRightSpacer: { width: 40 },

    body: { flex: 1, padding: spacing.lg, gap: spacing.md },

    warningBanner: {
      flexDirection: 'row',
      gap: spacing.sm,
      padding: spacing.md,
      borderRadius: radius.sm,
      borderWidth: 1,
      // Theme warning tokens: the fixed dark-amber values left light-yellow
      // text on a near-white fill in the light theme.
      borderColor: c.warning,
      backgroundColor: c.warningBg,
      alignItems: 'flex-start',
    },
    warningText: { ...typography.caption, color: c.text, flex: 1 },

    editorWrap: {
      flex: 1,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.md,
      backgroundColor: c.surface,
    },
    editorContent: { flexGrow: 1 },
    editor: {
      flex: 1,
      minHeight: 240,
      padding: spacing.md,
      color: c.text,
      fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
      fontSize: 13,
      lineHeight: 20,
    },
    lineCount: { ...typography.caption, color: c.mutedForeground, textAlign: 'right' },

    resultBanner: {
      flexDirection: 'row',
      gap: spacing.sm,
      padding: spacing.md,
      borderRadius: radius.sm,
      borderWidth: 1,
      alignItems: 'flex-start',
    },
    resultOk: { backgroundColor: c.successBg, borderColor: c.success },
    resultErr: { backgroundColor: c.errorBg, borderColor: c.errorBorder },
    resultText: { ...typography.caption },
    errorDetail: {
      ...typography.caption,
      color: c.error,
      fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
      marginTop: 4,
    },

    footer: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
      borderTopWidth: 1,
      borderTopColor: c.border,
    },
    footerRight: { flexDirection: 'row', gap: spacing.sm },
  });
}
