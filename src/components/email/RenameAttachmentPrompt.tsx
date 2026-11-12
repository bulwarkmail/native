import React from 'react';
import { View, Text, TextInput, Pressable, Modal, StyleSheet } from 'react-native';
import { spacing, radius, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useLocaleStore } from '../../stores/locale-store';
import { MODAL_ORIENTATIONS } from '../../lib/modal-orientations';
import { useSheetBottomInset } from '../../lib/sheet-bottom-inset';
import { renameAttachmentProblem, splitAttachmentName } from '../../lib/attachment-display';

/**
 * "Save as…" for an attachment (webmail rename-attachment-dialog.tsx,
 * fc54c1915, #1623): only the part before the extension can be edited, so
 * the copy keeps its type. `onSubmit` gets the whole new name.
 */
export function RenameAttachmentPrompt({ name, onSubmit, onClose }: {
  /** The attachment's name now; null hides the prompt. */
  name: string | null;
  onSubmit: (name: string) => void;
  onClose: () => void;
}) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const [stem, ext] = splitAttachmentName(name ?? '');
  const [value, setValue] = React.useState(stem);
  // Centred above the keyboard (the field autofocuses) and the taskbar.
  const bottomInset = useSheetBottomInset(name !== null);
  React.useEffect(() => { setValue(splitAttachmentName(name ?? '')[0]); }, [name]);

  const problem = renameAttachmentProblem(value);
  const error = problem === 'tooLong'
    ? t('attachment_rename.rename_too_long', 'This name is too long')
    : problem === 'chars'
      ? t('attachment_rename.rename_invalid_chars', "File names can't contain / or \\ or control characters")
      : null;
  const submit = () => {
    if (!value.trim() || problem) return;
    onClose();
    onSubmit(value.trim() + ext);
  };

  return (
    <Modal supportedOrientations={MODAL_ORIENTATIONS} visible={name !== null} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={styles.overlay} onPress={onClose} />
      <View style={[styles.center, { paddingBottom: bottomInset }]} pointerEvents="box-none">
        <View style={styles.card}>
          <Text style={styles.title}>{t('attachment_rename.rename_title', 'Rename attachment')}</Text>
          <View style={styles.inputRow}>
            <TextInput
              autoFocus
              value={value}
              onChangeText={setValue}
              onSubmitEditing={submit}
              returnKeyType="done"
              selectTextOnFocus
              accessibilityLabel={t('attachment_rename.rename_title', 'Rename attachment')}
              style={[styles.input, error ? styles.inputError : null]}
              testID="rename-attachment-input"
            />
            {!!ext && <Text style={styles.suffix}>{ext}</Text>}
          </View>
          {error && <Text style={styles.error} accessibilityRole="alert">{error}</Text>}
          <View style={styles.actions}>
            <Pressable onPress={onClose} hitSlop={8} accessibilityRole="button">
              <Text style={styles.cancel}>{t('common.cancel', 'Cancel')}</Text>
            </Pressable>
            <Pressable onPress={submit} hitSlop={8} accessibilityRole="button" disabled={!value.trim() || !!problem}>
              <Text style={[styles.confirm, (!value.trim() || !!problem) && styles.disabled]}>
                {t('email_viewer.attachment_actions.save', 'Save')}
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    overlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.5)' },
    center: { flex: 1, justifyContent: 'center', padding: spacing.lg },
    card: {
      backgroundColor: c.popover,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: c.border,
      padding: spacing.lg,
      gap: spacing.sm,
    },
    title: { ...typography.bodySemibold, color: c.text },
    inputRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
    input: {
      ...typography.body,
      flex: 1,
      color: c.text,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.sm,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
    },
    inputError: { borderColor: c.error },
    suffix: { ...typography.body, color: c.textMuted },
    error: { ...typography.caption, color: c.error },
    actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.lg, paddingTop: spacing.sm },
    cancel: { ...typography.bodyMedium, color: c.textSecondary },
    confirm: { ...typography.bodyMedium, color: c.primary },
    disabled: { opacity: 0.4 },
  });
}
