import React from 'react';
import { NavigationProvider, type NavigationProp, type ParamListBase } from '@react-navigation/native';

/** True inside the detail pane of a split view. */
const PaneContext = React.createContext(false);

/** A screen in a split view's detail pane has no back button. */
export function useInPane(): boolean {
  return React.useContext(PaneContext);
}

/** Routes a pane shows itself instead of pushing them on the stack. */
export type PaneTarget = { name: string; params?: object };

/**
 * Runs a stack screen inside a split view's detail pane. The screen's own
 * `useNavigation()` / `useRoute()` get the pane: `goBack` closes it, the
 * routes `onOpen` accepts open in it, everything else goes to the stack.
 */
export function PaneScreen({
  navigation,
  name,
  params,
  onOpen,
  onClose,
  children,
}: {
  navigation: NavigationProp<ParamListBase>;
  name: string;
  params: object;
  /** Return true when the pane shows this route itself. */
  onOpen: (target: PaneTarget) => boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const route = React.useMemo(() => ({ key: `pane-${name}`, name, params }), [name, params]);
  const paneNavigation = React.useMemo(() => {
    const open = (method: 'navigate' | 'push' | 'replace') => (...args: unknown[]) => {
      const [target, targetParams] = args as [string, object | undefined];
      if (typeof target === 'string' && onOpen({ name: target, params: targetParams })) return;
      // `push` and `replace` only exist on a stack; from a tab they become a
      // navigate, which reaches the root stack all the same.
      const real = navigation as unknown as Record<string, ((...a: unknown[]) => void) | undefined>;
      (real[method] ?? real.navigate)!(...args);
    };
    return {
      ...navigation,
      goBack: onClose,
      navigate: open('navigate'),
      push: open('push'),
      replace: open('replace'),
      canGoBack: () => true,
    } as unknown as NavigationProp<ParamListBase>;
  }, [navigation, onOpen, onClose]);
  return (
    <PaneContext.Provider value>
      <NavigationProvider route={route} navigation={paneNavigation}>
        {children}
      </NavigationProvider>
    </PaneContext.Provider>
  );
}
