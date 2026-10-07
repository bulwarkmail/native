import { describe, expect, it } from 'vitest';
import {
  MAX_SNIPPET_CHARS,
  collectSnippets,
  filterHasSnippetTerms,
  hasMarkedRun,
  parseSearchSnippet,
  snippetKey,
} from '../search-snippet';

describe('parseSearchSnippet', () => {
  it('splits marked and plain runs and decodes the escaped text', () => {
    const runs = parseSearchSnippet('Re: <mark>Invoice</mark> &amp; receipt &lt;2026&gt; &quot;x&quot; &#39;y&#39; &#x41;');
    expect(runs).toEqual([
      { text: 'Re: ', marked: false },
      { text: 'Invoice', marked: true },
      { text: ' & receipt <2026> "x" \'y\' A', marked: false },
    ]);
    expect(hasMarkedRun(runs)).toBe(true);
  });

  it('treats every other tag as literal text, never as markup', () => {
    expect(parseSearchSnippet('<script>x</script> <mark>hit</mark><b>b</b>')).toEqual([
      { text: '<script>x</script> ', marked: false },
      { text: 'hit', marked: true },
      { text: '<b>b</b>', marked: false },
    ]);
  });

  it('does not double-decode and leaves unknown or invalid entities alone', () => {
    expect(parseSearchSnippet('&amp;lt; &bogus; &#0; &#xD800; &#99999999;')).toEqual([
      { text: '&lt; &bogus; &#0; &#xD800; &#99999999;', marked: false },
    ]);
  });

  it('copes with unbalanced and nested marks', () => {
    expect(parseSearchSnippet('a</mark>b<mark>c')).toEqual([
      { text: 'ab', marked: false },
      { text: 'c', marked: true },
    ]);
    expect(parseSearchSnippet('<mark>a<mark>b</mark>c</mark>d')).toEqual([
      { text: 'abc', marked: true },
      { text: 'd', marked: false },
    ]);
    expect(parseSearchSnippet('<mark></mark>')).toEqual([]);
  });

  it('returns nothing for empty or non-string input', () => {
    expect(parseSearchSnippet('')).toEqual([]);
    expect(parseSearchSnippet(undefined)).toEqual([]);
    expect(parseSearchSnippet(null)).toEqual([]);
    expect(hasMarkedRun(parseSearchSnippet('plain'))).toBe(false);
  });

  it('keeps at most 4 KB of input and drops a tag cut in half', () => {
    const long = parseSearchSnippet('a'.repeat(MAX_SNIPPET_CHARS * 3));
    expect(long.reduce((n, r) => n + r.text.length, 0)).toBe(MAX_SNIPPET_CHARS);
    const cut = parseSearchSnippet('b'.repeat(MAX_SNIPPET_CHARS - 3) + '<mark>zzz');
    expect(cut.map((r) => r.text).join('')).toBe('b'.repeat(MAX_SNIPPET_CHARS - 3));
  });

  it('stays fast on 200 KB of hostile input', () => {
    const inputs = [
      '<mark>'.repeat(34000),
      '</mark>'.repeat(30000),
      '<'.repeat(200_000),
      '&'.repeat(200_000),
      '<mark>&amp;'.repeat(20000),
      '&#x' + '1'.repeat(200_000),
    ];
    for (const input of inputs) {
      const start = performance.now();
      parseSearchSnippet(input);
      expect(performance.now() - start).toBeLessThan(1000);
    }
  });
});

describe('filterHasSnippetTerms', () => {
  it('finds text/subject/body terms at any nesting level', () => {
    expect(filterHasSnippetTerms({ text: 'foo' })).toBe(true);
    expect(filterHasSnippetTerms({ operator: 'AND', conditions: [{ inMailbox: 'x' }, { subject: 'foo' }] })).toBe(true);
    expect(filterHasSnippetTerms({
      operator: 'AND',
      conditions: [{ inMailbox: 'x' }, { operator: 'NOT', conditions: [{ body: 'foo' }] }],
    })).toBe(true);
  });

  it('ignores structural-only filters and empty terms', () => {
    expect(filterHasSnippetTerms(undefined)).toBe(false);
    expect(filterHasSnippetTerms({ inMailbox: 'x', hasKeyword: '$seen' })).toBe(false);
    expect(filterHasSnippetTerms({ from: 'alice' })).toBe(false);
    expect(filterHasSnippetTerms({ text: '   ' })).toBe(false);
  });
});

describe('collectSnippets', () => {
  it('keys snippets by account and id, so a repeated id never crosses accounts', () => {
    const into = {};
    collectSnippets(into, 'acc-1', [{ emailId: 'e1', subject: '<mark>Hi</mark>', preview: null }]);
    collectSnippets(into, 'acc-2', [{ emailId: 'e1', subject: null, preview: 'x <mark>y</mark>' }]);
    expect(Object.keys(into).sort()).toEqual([snippetKey('acc-1', 'e1'), snippetKey('acc-2', 'e1')].sort());
    const a = (into as Record<string, { subject: unknown; preview: unknown }>)[snippetKey('acc-1', 'e1')];
    const b = (into as Record<string, { subject: unknown; preview: unknown }>)[snippetKey('acc-2', 'e1')];
    expect(a.subject).toEqual([{ text: 'Hi', marked: true }]);
    expect(a.preview).toBeNull();
    expect(b.subject).toBeNull();
    expect(b.preview).toEqual([{ text: 'x ', marked: false }, { text: 'y', marked: true }]);
  });

  it('drops snippets without a highlighted term and tolerates garbage', () => {
    const into = {};
    collectSnippets(into, 'a', [
      { emailId: 'e1', subject: 'plain', preview: 'plain' },
      { emailId: 5 as unknown as string, subject: '<mark>x</mark>' },
      null as never,
    ]);
    collectSnippets(into, 'a', undefined);
    expect(into).toEqual({});
  });

  it('keys differ for ids that would collide when joined naively', () => {
    expect(snippetKey('a:b', 'c')).not.toBe(snippetKey('a', 'b:c'));
  });
});
