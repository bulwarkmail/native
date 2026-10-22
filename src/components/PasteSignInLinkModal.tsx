import React from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  Platform,
  KeyboardAvoidingView,
  ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';
import { ClipboardPaste, X } from './icons';
import { spacing, radius, typography, type ThemePalette } from '../theme/tokens';
import { useColors } from '../theme/colors';
import Button from './Button';
import { useLocaleStore } from '../stores/locale-store';
import { insecurePairingLinkError, parsePastedSignInLink, type QrLoginPayload } from '../lib/oauth';
import { describeLoginError } from '../lib/login-errors';
import { SafeAreaModal } from './SafeAreaModal';
import { MODAL_ORIENTATIONS } from '../lib/modal-orientations';

interface PasteSignInLinkModalProps {
  visible: boolean;
  onClose: () => void;
  // Fires with a link that parsed; the parent closes the modal and signs in
  // with it exactly as with a scanned code.
  onSubmit: (payload: QrLoginPayload) => void;
}

/**
 * For when the code can't be scanned (a phone showing the webmail itself, a
 * broken camera): the same `bulwarkmail://` link, pasted as text.
 */
export function PasteSignInLinkModal({ visible, onClose, onSubmit }: PasteSignInLinkModalProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((st) => st.t);
  const [text, setText] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [focused, setFocused] = React.useState(false);

  React.useEffect(() => {
    if (!visible) return;
    setText('');
    setError(null);
  }, [visible]);

  const paste = React.useCallback(async () => {
    let value = '';
    try {
      value = await Clipboard.getStringAsync();
    } catch {
      value = '';
    }
    if (!value.trim()) {
      setError(t('login.mobile.paste_clipboard_empty', 'Nothing to paste. Copy the link in the webmail first.'));
      return;
    }
    setText(value.trim());
    setError(null);
  }, [t]);

  const submit = React.useCallback(() => {
    const payload = parsePastedSignInLink(text);
    if (!payload) {
      // A pairing link for a plain-http webmail: say why it won't be used.
      const insecure = insecurePairingLinkError(text);
      if (insecure) {
        const copy = describeLoginError(insecure, { t });
        setError(copy.detail ?? copy.title);
        return;
      }
      setError(t('login.mobile.paste_invalid', "That isn't a Bulwark sign-in link"));
      return;
    }
    onSubmit(payload);
  }, [onSubmit, t, text]);

  const title = t('login.mobile.paste_title', 'Paste sign-in link');

  return (
    <SafeAreaModal supportedOrientations={MODAL_ORIENTATIONS} visible={visible} animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <SafeAreaView style={styles.container}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.flex}>
          <View style={styles.header}>
            <Pressable
              onPress={onClose}
              hitSlop={10}
              style={styles.closeButton}
              accessibilityRole="button"
              accessibilityLabel={t('common.close', 'Close')}
            >
              <X size={24} color={c.text} />
            </Pressable>
            <Text style={styles.title} accessibilityRole="header">{title}</Text>
            <View style={styles.closeButton} />
          </View>

          <ScrollView
            style={styles.flex}
            contentContainerStyle={styles.content}
            keyboardShouldPersistTaps="handled"
          >
            <Text style={styles.hint}>
              {t('login.mobile.paste_hint', 'In the webmail, open Settings → Security → Link Mobile App, copy the sign-in link and paste it here.')}
            </Text>

            <TextInput
              value={text}
              onChangeText={(value) => {
                setText(value);
                setError(null);
              }}
              placeholder="bulwarkmail://pair?server=…&code=…"
              placeholderTextColor={c.textMuted}
              accessibilityLabel={t('login.mobile.paste_label', 'Sign-in link')}
              multiline
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              textAlignVertical="top"
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              style={[styles.input, focused && styles.inputFocused, error ? styles.inputError : null]}
            />

            {error ? (
              <Text style={styles.error} accessibilityLiveRegion="polite">{error}</Text>
            ) : null}

            <Button
              variant="outline"
              size="md"
              onPress={() => void paste()}
              icon={<ClipboardPaste size={16} color={c.text} />}
            >
              {t('login.mobile.paste_button', 'Paste')}
            </Button>

            <Button variant="default" size="md" onPress={submit} disabled={!text.trim()}>
              {t('login.sign_in', 'Sign in')}
            </Button>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </SafeAreaModal>
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
      paddingTop: Platform.OS === 'android' ? spacing.xl : spacing.sm,
      paddingBottom: spacing.md,
    },
    closeButton: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
    title: { ...typography.h3, color: c.text },
    content: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxxl, gap: spacing.lg },
    hint: { ...typography.body, color: c.textSecondary },
    input: {
      ...typography.body,
      color: c.text,
      minHeight: 96,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.sm,
      backgroundColor: c.background,
      paddingHorizontal: spacing.md,
      paddingTop: spacing.sm,
      paddingBottom: spacing.sm,
    },
    inputFocused: { borderColor: c.borderFocus, borderWidth: 2 },
    inputError: { borderColor: c.error },
    error: { ...typography.caption, color: c.error, marginTop: -spacing.sm },
  });
}
