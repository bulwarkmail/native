import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { LayoutChangeEvent, View } from 'react-native';

/**
 * A settings search result the user tapped: the pane that just opened shows
 * the row whose label matches, scrolled into view and briefly highlighted
 * (webmail: settings-search-highlight).
 */
export interface SearchHighlight {
  label: string;
  /** Scroll `view` into view; called once, by the first row that matches. */
  reveal: (view: View) => void;
}

export const SearchHighlightContext = createContext<SearchHighlight | null>(null);

const HIGHLIGHT_MS = 1800;

/**
 * For a settings row with `label`: attach `ref` and `onLayout` to its outer
 * View and paint the highlight while `highlighted` is true.
 */
export function useSearchHighlight(label: string) {
  const target = useContext(SearchHighlightContext);
  const ref = useRef<View>(null);
  const [highlighted, setHighlighted] = useState(false);

  const onLayout = useCallback((_e: LayoutChangeEvent) => {
    if (!target || target.label.trim() !== label.trim() || !ref.current) return;
    target.reveal(ref.current);
    setHighlighted(true);
  }, [target, label]);

  useEffect(() => {
    if (!highlighted) return undefined;
    const timer = setTimeout(() => setHighlighted(false), HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [highlighted]);

  return { ref, onLayout, highlighted };
}
