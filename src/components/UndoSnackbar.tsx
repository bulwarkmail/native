import React from 'react';
import { View, Text, StyleSheet, Pressable, Animated, Easing } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { spacing, radius, typography, type ThemePalette } from '../theme/tokens';
import { useColors } from '../theme/colors';
import { useEmailStore } from '../stores/email-store';
import { useSendUndoStore, restoreUndoneSend, type PendingUndoSend } from '../stores/send-undo-store';
import { useLocaleStore } from '../stores/locale-store';
import type { RootStackParamList } from '../navigation/types';

const VISIBLE_MS = 5000;
// Clears the tab bar and the viewer's action bar, like the toasts (ToastHost).
const BOTTOM_CLEARANCE = 64;

interface Shown {
  label: string;
  createdAt: number;
  visibleMs: number;
  /** Undo-send entries carry a second "Send now" action. */
  send?: PendingUndoSend;
}

/**
 * The undo bar for the last list action (archive, delete, move, spam) and
 * for a send held by the undo-send delay. App.tsx gives every stack screen
 * one and only the focused screen's renders, so a reply sent from the viewer
 * can be undone there and the bar never shows twice.
 */
export function UndoSnackbar() {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const insets = useSafeAreaInsets();
  const t = useLocaleStore((s) => s.t);
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const entry = useEmailStore((s) => s.pendingUndo);
  const undoLast = useEmailStore((s) => s.undoLast);
  const clearUndo = useEmailStore((s) => s.clearUndo);
  const pendingSend = useSendUndoStore((s) => s.pending);
  const sendBusy = useSendUndoStore((s) => s.busy);
  const slideY = React.useRef(new Animated.Value(120)).current;
  const opacity = React.useRef(new Animated.Value(0)).current;

  // The undo-send entry (composer) and the list-action entry (store) share
  // the bar; the newer one wins.
  const current = React.useMemo<Shown | null>(() => {
    const list: Shown | null = entry
      ? { label: entry.label, createdAt: entry.createdAt, visibleMs: VISIBLE_MS }
      : null;
    const send: Shown | null = pendingSend
      ? {
          label: t('email_composer.undo_send_label', 'Sending in {seconds}s…', { seconds: pendingSend.delaySeconds }),
          createdAt: pendingSend.createdAt,
          visibleMs: Math.max(1000, pendingSend.delaySeconds * 1000 - 1000),
          send: pendingSend,
        }
      : null;
    if (list && send) return list.createdAt >= send.createdAt ? list : send;
    return list ?? send;
  }, [entry, pendingSend, t]);

  // Remember the last non-null entry so the bar's text/handlers stay valid
  // while it animates out after the entry flips to null.
  const [shown, setShown] = React.useState(current);

  React.useEffect(() => {
    if (current) setShown(current);
  }, [current]);

  // Drive the auto-dismiss off the entry's createdAt so re-renders during
  // animation don't reset the timer, and so consecutive actions reset it.
  React.useEffect(() => {
    if (!current) {
      Animated.parallel([
        Animated.timing(slideY, { toValue: 120, duration: 180, easing: Easing.in(Easing.cubic), useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0, duration: 180, useNativeDriver: true }),
      ]).start(({ finished }) => {
        if (finished) setShown(null);
      });
      return;
    }

    Animated.parallel([
      Animated.timing(slideY, { toValue: 0, duration: 220, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      Animated.timing(opacity, { toValue: 1, duration: 220, useNativeDriver: true }),
    ]).start();

    const elapsed = Date.now() - current.createdAt;
    const remaining = Math.max(0, current.visibleMs - elapsed);
    const id = setTimeout(() => {
      if (current.send) {
        if (useSendUndoStore.getState().pending === current.send) useSendUndoStore.getState().clear();
      } else if (useEmailStore.getState().pendingUndo === entry) {
        // Only clear if the entry is still the same one we scheduled for.
        clearUndo();
      }
    }, remaining);
    return () => clearTimeout(id);
  }, [current, entry, slideY, opacity, clearUndo]);

  const onUndo = async () => {
    if (!shown) return;
    if (!shown.send) {
      void undoLast();
      return;
    }
    const send = shown.send;
    const ok = await useSendUndoStore.getState().undo();
    if (!ok) return;
    // Bring the message back as an editable draft and reopen the composer.
    try {
      const draft = await restoreUndoneSend(send, useEmailStore.getState().mailboxes);
      navigation.navigate('Compose', { draft });
    } catch (err) {
      console.warn('[send-undo] reopen failed', err);
    }
  };

  const onSendNow = () => {
    void useSendUndoStore.getState().sendNow();
  };

  if (!shown) return null;

  return (
    <Animated.View
      pointerEvents="box-none"
      style={[
        styles.wrap,
        { bottom: insets.bottom + BOTTOM_CLEARANCE, opacity, transform: [{ translateY: slideY }] },
      ]}
    >
      <View style={styles.bar}>
        <Text style={styles.label} numberOfLines={1}>{shown.label}</Text>
        {shown.send && (
          <Pressable
            onPress={onSendNow}
            hitSlop={8}
            disabled={sendBusy}
            style={({ pressed }) => [styles.undoBtn, pressed && styles.undoBtnPressed]}
          >
            <Text style={styles.sendNowText}>{t('email_composer.send_now', 'Send now').toUpperCase()}</Text>
          </Pressable>
        )}
        <Pressable
          onPress={() => { void onUndo(); }}
          hitSlop={8}
          disabled={sendBusy}
          style={({ pressed }) => [styles.undoBtn, pressed && styles.undoBtnPressed]}
        >
          <Text style={styles.undoText}>{t('common.undo', 'Undo').toUpperCase()}</Text>
        </Pressable>
      </View>
    </Animated.View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    wrap: {
      position: 'absolute',
      left: spacing.md,
      right: spacing.md,
      zIndex: 50,
    },
    bar: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: spacing.sm + 2,
      paddingLeft: spacing.lg,
      paddingRight: spacing.sm,
      borderRadius: radius.md,
      backgroundColor: c.text,
      shadowColor: '#000',
      shadowOpacity: 0.3,
      shadowRadius: 12,
      shadowOffset: { width: 0, height: 6 },
      elevation: 8,
    },
    label: {
      ...typography.body,
      color: c.background,
      flex: 1,
    },
    undoBtn: {
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      borderRadius: radius.sm,
    },
    undoBtnPressed: {
      backgroundColor: 'rgba(255,255,255,0.1)',
    },
    undoText: {
      ...typography.bodySemibold,
      color: c.primary,
      letterSpacing: 0.5,
    },
    sendNowText: {
      ...typography.bodySemibold,
      color: c.background,
      letterSpacing: 0.5,
      opacity: 0.85,
    },
  });
}
