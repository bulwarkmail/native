import React from 'react';
import { StyleSheet, Text } from 'react-native';
import { snippetLineSegments } from '../../lib/search-snippet';
import { useResolvedTheme } from '../../theme/colors';

/**
 * A SearchSnippet/get excerpt (RFC 8621 §5) with the matched terms
 * highlighted, as the spans of the row's own Text: nest it inside a Text
 * that sets the font and `numberOfLines`, so the row keeps its height when
 * the excerpt replaces the plain subject or preview. The snippet is parsed
 * into text and marked segments, never rendered as HTML (webmail
 * components/email/search-snippet-text.tsx).
 */
export function SearchSnippetText({ snippet }: { snippet: string }) {
  const dark = useResolvedTheme() === 'dark';
  const segments = React.useMemo(() => snippetLineSegments(snippet), [snippet]);
  const markStyle = dark ? styles.markDark : styles.markLight;
  return (
    <>
      {segments.map((segment, i) => (
        segment.marked
          ? <Text key={i} style={markStyle} testID="search-snippet-mark">{segment.text}</Text>
          : <Text key={i}>{segment.text}</Text>
      ))}
    </>
  );
}

// The webmail's highlight: bg-yellow-200, dark:bg-yellow-500/40, text-inherit.
const styles = StyleSheet.create({
  markLight: { backgroundColor: '#fef08a' },
  markDark: { backgroundColor: 'rgba(234, 179, 8, 0.4)' },
});
