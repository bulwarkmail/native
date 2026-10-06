import React from 'react';
import { Text, type TextStyle } from 'react-native';
import type { SnippetRun } from '../../lib/search-snippet';

/**
 * Search-snippet runs as nested <Text>: marked runs are bold and tinted.
 * The runs are plain strings (see lib/search-snippet), so nothing the sender
 * wrote is ever interpreted as markup.
 */
export function HighlightedText({ runs, markStyle }: { runs: SnippetRun[]; markStyle: TextStyle }) {
  return (
    <>
      {runs.map((run, i) => {
        // One line, like the plain subject and preview it stands in for.
        const text = run.text.replace(/\s+/g, ' ');
        return run.marked
          ? <Text key={i} style={markStyle}>{text}</Text>
          : <React.Fragment key={i}>{text}</React.Fragment>;
      })}
    </>
  );
}
