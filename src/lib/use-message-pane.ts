import React from 'react';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';

export type ThreadParams = RootStackParamList['EmailThread'];

/** What the message pane shows: the viewer's route params plus the row it came from. */
export interface PaneMessage {
  params: ThreadParams;
  rowKey: string;
  /** Position of the row in the list when it was opened. */
  index: number;
}

/**
 * The row to show once the open message has left the list (deleted, archived,
 * moved, marked spam): the one that took its place, or the new last row, as
 * Apple Mail does. With `eligible`, the nearest such row that passes it, first
 * towards the end of the list. Null when there is none or the message is
 * still there.
 */
export function rowAfterRemoval<T>(
  rows: readonly T[],
  open: Pick<PaneMessage, 'rowKey' | 'index'>,
  keyOf: (row: T) => string,
  eligible: (row: T) => boolean = () => true,
): T | null {
  const start = Math.min(open.index, rows.length - 1);
  let next: T | undefined;
  for (let i = start; i < rows.length && next === undefined; i++) if (eligible(rows[i])) next = rows[i];
  for (let i = start - 1; i >= 0 && next === undefined; i--) if (eligible(rows[i])) next = rows[i];
  return next !== undefined && keyOf(next) !== open.rowKey ? next : null;
}

/**
 * The message shown next to a list on a wide window (`useLayout().isSplit`),
 * for the Mail tab and the unified views; `MessagePane` draws it. When the
 * window gets narrow (split-screen, a fold) with a message open, the message
 * moves to the stack so it stays on screen.
 */
export function useMessagePane(
  navigation: Pick<NativeStackNavigationProp<RootStackParamList>, 'navigate'>,
  isSplit: boolean,
) {
  const [open, setOpen] = React.useState<PaneMessage | null>(null);
  // The pager in the pane can move to another message; the list follows it.
  const [activeKey, setActiveKey] = React.useState<string | null>(null);
  const openRef = React.useRef(open);
  openRef.current = open;

  const show = React.useCallback((message: PaneMessage) => {
    setOpen(message);
    setActiveKey(message.rowKey);
  }, []);
  const close = React.useCallback(() => {
    setOpen(null);
    setActiveKey(null);
  }, []);
  // The viewer opened another message itself: it takes the open one's place.
  const replace = React.useCallback((params: ThreadParams) => {
    setOpen({ params, rowKey: params.emailId, index: openRef.current?.index ?? 0 });
  }, []);

  React.useEffect(() => {
    if (isSplit || !openRef.current) return;
    navigation.navigate('EmailThread', openRef.current.params);
    close();
  }, [isSplit, navigation, close]);

  return { open, openRef, activeKey, setActiveKey, show, close, replace };
}
