import React from 'react';
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ArrowLeft } from '../icons';
import { SafeAreaModal } from '../SafeAreaModal';
import { useColors } from '../../theme/colors';
import { spacing, typography, type ThemePalette } from '../../theme/tokens';
import { useLocaleStore } from '../../stores/locale-store';
import { MODAL_ORIENTATIONS } from '../../lib/modal-orientations';
import { useModalKeyboardPadding } from '../../lib/sheet-bottom-inset';
import type { RecipientSuggestion } from '../../stores/contacts-store';
import { RecipientChip, RecipientSuggestionList, type ChipRecipient } from './RecipientSuggestionList';

/**
 * Full-screen recipient picker (U-069) for where the inline suggestions have
 * no room: a phone in landscape with the keyboard up. The field sits at the
 * top and the same suggestions fill the space down to the keyboard; Done or
 * Back goes back to the composer with what was typed turned into chips.
 */
export function RecipientPicker<R extends ChipRecipient>({
  visible, label, placeholder, recipients, isValid, input, onChangeInput, onSubmitInput,
  suggestions, onPick, onSearchServer, searchingServer, onRemove, onDone,
}: {
  visible: boolean;
  /** "To", "Cc" or "Bcc". */
  label: string;
  placeholder: string;
  recipients: R[];
  isValid: (r: R) => boolean;
  input: string;
  onChangeInput: (text: string) => void;
  /** Return in the field: turn the typed text into a chip. */
  onSubmitInput: () => void;
  suggestions: RecipientSuggestion[];
  onPick: (s: RecipientSuggestion) => void;
  onSearchServer?: () => void;
  searchingServer?: boolean;
  onRemove: (index: number) => void;
  onDone: () => void;
}) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const keyboardPadding = useModalKeyboardPadding(visible);
  const inputRef = React.useRef<TextInput>(null);
  const showList = suggestions.length > 0 || (!!onSearchServer && !!input.trim());

  return (
    <SafeAreaModal
      supportedOrientations={MODAL_ORIENTATIONS}
      visible={visible}
      animationType="fade"
      onRequestClose={onDone}
      onShow={() => inputRef.current?.focus()}
    >
      <SafeAreaView style={styles.screen} edges={['top', 'bottom', 'left', 'right']}>
        <KeyboardAvoidingView
          style={[styles.screen, { paddingBottom: keyboardPadding }]}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={styles.header}>
            <Pressable
              onPress={onDone}
              hitSlop={10}
              style={styles.headerBtn}
              accessibilityRole="button"
              accessibilityLabel={t('common.back', 'Back')}
            >
              <ArrowLeft size={22} color={c.text} />
            </Pressable>
            <Text style={styles.title} numberOfLines={1} accessibilityRole="header">{label}</Text>
            <Pressable onPress={onDone} hitSlop={10} style={styles.headerBtn} accessibilityRole="button">
              <Text style={styles.done}>{t('common.done', 'Done')}</Text>
            </Pressable>
          </View>
          <View style={styles.field}>
            {recipients.map((r, i) => (
              <RecipientChip
                key={`${r.email}-${i}`}
                recipient={r}
                invalid={!isValid(r)}
                onRemove={() => onRemove(i)}
              />
            ))}
            <TextInput
              ref={inputRef}
              disableFullscreenUI
              accessibilityLabel={label}
              style={styles.input}
              placeholder={placeholder}
              placeholderTextColor={c.textMuted}
              value={input}
              onChangeText={onChangeInput}
              returnKeyType="done"
              onSubmitEditing={() => {
                if (input.trim()) onSubmitInput();
                else onDone();
              }}
              blurOnSubmit={false}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              importantForAutofill="no"
              textContentType="none"
            />
          </View>
          {showList ? (
            <RecipientSuggestionList
              fill
              suggestions={suggestions}
              onPick={onPick}
              onSearchServer={onSearchServer}
              searchingServer={searchingServer}
            />
          ) : (
            <View style={styles.empty} />
          )}
        </KeyboardAvoidingView>
      </SafeAreaView>
    </SafeAreaModal>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.background },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.xs,
      borderBottomWidth: 1,
      borderBottomColor: c.borderLight,
    },
    headerBtn: { minHeight: 40, minWidth: 40, alignItems: 'center', justifyContent: 'center' },
    title: { ...typography.h3, color: c.text, flex: 1 },
    done: { ...typography.bodyMedium, color: c.primary },
    field: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: spacing.xs,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.xs,
      borderBottomWidth: 1,
      borderBottomColor: c.borderLight,
    },
    input: {
      flexGrow: 1,
      minWidth: 140,
      ...typography.body,
      color: c.text,
      paddingVertical: 8,
    },
    empty: { flex: 1 },
  });
}
