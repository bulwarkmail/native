import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Mail } from './icons';

import EmailThreadScreen from '../screens/EmailThreadScreen';
import type { RootStackParamList } from '../navigation/types';
import type { PaneMessage, ThreadParams } from '../lib/use-message-pane';
import { useLocaleStore } from '../stores/locale-store';
import { useColors } from '../theme/colors';
import { spacing, typography, type ThemePalette } from '../theme/tokens';

interface Props {
  message: PaneMessage | null;
  /** The screen's stack navigation; the viewer gets a copy that keeps it in the pane. */
  navigation: Pick<NativeStackNavigationProp<RootStackParamList>, 'navigate'>;
  /** The message left the list (deleted, archived, moved, marked spam). */
  onRemoved: () => void;
  /** The viewer opened another message (`useMessagePane().replace`). */
  onReplace: (params: ThreadParams) => void;
  /** The pager moved to another message. */
  onActiveChange: (emailId: string) => void;
}

/**
 * The detail side of a list on a wide window: the message viewer, or a
 * placeholder while nothing is open. The same viewer screen runs here with a
 * navigation that keeps it in the pane: `goBack` means "this message is
 * done", another message replaces it, and other routes go to the stack.
 */
export default function MessagePane({ message, navigation, onRemoved, onReplace, onActiveChange }: Props) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);

  const onRemovedRef = React.useRef(onRemoved);
  onRemovedRef.current = onRemoved;
  const onReplaceRef = React.useRef(onReplace);
  onReplaceRef.current = onReplace;
  const paneNavigation = React.useMemo(() => ({
    ...navigation,
    goBack: () => onRemovedRef.current(),
    navigate: (...args: unknown[]) => {
      const [name, params] = args as [unknown, ThreadParams | undefined];
      if (name === 'EmailThread' && params) {
        onReplaceRef.current(params);
        return;
      }
      (navigation.navigate as (...a: unknown[]) => void)(...args);
    },
  }), [navigation]);

  if (message) {
    return (
      <EmailThreadScreen
        route={{ key: 'mail-pane', name: 'EmailThread', params: message.params }}
        navigation={paneNavigation as unknown as React.ComponentProps<typeof EmailThreadScreen>['navigation']}
        embedded
        onActiveChange={onActiveChange}
      />
    );
  }
  return (
    <View style={styles.empty}>
      <Mail size={40} color={c.textMuted} strokeWidth={1.5} />
      <Text style={styles.emptyTitle}>{t('email_viewer.no_email_selected', 'No email selected')}</Text>
      <Text style={styles.emptyText}>
        {t('email_viewer.no_email_description', 'Select an email from the list to view it here')}
      </Text>
    </View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.sm, padding: spacing.xl },
    emptyTitle: { ...typography.bodySemibold, color: c.text, marginTop: spacing.sm },
    emptyText: { ...typography.body, color: c.textMuted, textAlign: 'center' },
  });
}
