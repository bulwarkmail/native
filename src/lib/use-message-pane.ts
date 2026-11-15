import React from 'react';
import type { NavigationState } from '@react-navigation/native';
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
 * The viewer the list or the pane put on the stack (`handedOff`), if it is
 * still the screen on show, right over the tabs: its params, else null.
 */
export function handedOffViewer(
  state: Pick<NavigationState, 'index' | 'routes'>,
  handedOff: ThreadParams | null,
): ThreadParams | null {
  const top = state.routes[state.index];
  if (!handedOff || top?.name !== 'EmailThread' || state.routes[state.index - 1]?.name !== 'MainTabs') return null;
  const params = top.params as ThreadParams | undefined;
  return params?.emailId === handedOff.emailId ? params : null;
}

/**
 * The message shown next to a list where there is room (`mailLayoutFor`),
 * for the Mail tab and the unified views; `MessagePane` draws it. When the
 * room gets too narrow (split-screen, a fold, a rotation) with a message
 * open, the message moves to the stack so it stays on screen. When the room
 * comes back with a message on the stack that the list opened there
 * (`openOnStack`) or the pane moved there, and still on show, the message
 * goes into the pane beside the list: Apple's Mail on the iPhone Duo shows
 * the message when closed and the list beside it when opened. `turnedOff`: the reading pane setting turned the split off
 * (#93), from Settings, so the screen is not on show, and the message is let
 * go instead. `rowOf` finds a message's row (its key and place in the list);
 * a message no longer in the list keeps its own id as the key.
 */
export function useMessagePane(
  navigation: Pick<NativeStackNavigationProp<RootStackParamList>, 'navigate' | 'getState' | 'goBack'>,
  isSplit: boolean,
  turnedOff: boolean,
  rowOf: (params: ThreadParams) => { rowKey: string; index: number } | null = () => null,
) {
  const [open, setOpen] = React.useState<PaneMessage | null>(null);
  // The pager in the pane can move to another message; the list follows it.
  const [activeKey, setActiveKey] = React.useState<string | null>(null);
  const openRef = React.useRef(open);
  openRef.current = open;
  // The message the list opened on the stack, or the pane moved there.
  const handedOffRef = React.useRef<ThreadParams | null>(null);
  const rowOfRef = React.useRef(rowOf);
  rowOfRef.current = rowOf;

  const show = React.useCallback((message: PaneMessage) => {
    setOpen(message);
    setActiveKey(message.rowKey);
  }, []);
  const close = React.useCallback(() => {
    setOpen(null);
    setActiveKey(null);
  }, []);
  // One pane: the message opens on the stack.
  const openOnStack = React.useCallback((params: ThreadParams) => {
    navigation.navigate('EmailThread', params);
    handedOffRef.current = params;
  }, [navigation]);
  // The viewer opened another message itself: it takes the open one's place.
  const replace = React.useCallback((params: ThreadParams) => {
    setOpen({ params, rowKey: params.emailId, index: openRef.current?.index ?? 0 });
  }, []);

  React.useEffect(() => {
    if (isSplit) {
      const params = handedOffViewer(navigation.getState(), handedOffRef.current);
      handedOffRef.current = null;
      if (!params) return;
      navigation.goBack();
      show({ params, rowKey: params.emailId, index: 0, ...rowOfRef.current(params) });
      return;
    }
    if (!openRef.current) return;
    if (!turnedOff) openOnStack(openRef.current.params);
    close();
  }, [isSplit, turnedOff, navigation, show, close, openOnStack]);

  return { open, openRef, activeKey, setActiveKey, show, close, replace, openOnStack };
}
