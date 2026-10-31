import { describe, expect, it } from 'vitest';
import {
  filterHasSnippetTerms,
  hasMarkedSegment,
  parseSearchSnippet,
  snippetFilterFor,
  snippetHighlight,
  snippetLineSegments,
  withSearchSnippets,
} from '../search-snippet';
import type { Email } from '../../api/types';

// Ported from the webmail's lib/__tests__/search-snippet.test.ts.

describe('parseSearchSnippet', () => {
  it('splits marked and plain segments and decodes the escaped text', () => {
    const segments = parseSearchSnippet('Re: <mark>Invoice</mark> &amp; receipt &lt;2026&gt;');
    expect(segments).toEqual([
      { text: 'Re: ', marked: false },
      { text: 'Invoice', marked: true },
      { text: ' & receipt <2026>', marked: false },
    ]);
    expect(hasMarkedSegment(segments)).toBe(true);
  });

  it('treats any other tag as literal text', () => {
    const segments = parseSearchSnippet('<script>x</script> <mark>hit</mark><b>bold</b>');
    expect(segments).toEqual([
      { text: '<script>x</script> ', marked: false },
      { text: 'hit', marked: true },
      { text: '<b>bold</b>', marked: false },
    ]);
  });

  it('reports no highlight for a snippet without marks', () => {
    const segments = parseSearchSnippet('plain subject');
    expect(segments).toEqual([{ text: 'plain subject', marked: false }]);
    expect(hasMarkedSegment(segments)).toBe(false);
  });
});

describe('snippetLineSegments', () => {
  it('puts a multi-line body excerpt on one line without gluing words together', () => {
    expect(snippetLineSegments('\n  Hello\r\n\r\nthe <mark>zephyr</mark>\tlaunch  \n')).toEqual([
      { text: 'Hello the ', marked: false },
      { text: 'zephyr', marked: true },
      { text: ' launch', marked: false },
    ]);
  });

  it('drops segments left empty', () => {
    expect(snippetLineSegments('  <mark>hit</mark>')).toEqual([{ text: 'hit', marked: true }]);
  });
});

describe('filterHasSnippetTerms', () => {
  it('finds text/subject/body terms at any nesting level', () => {
    expect(filterHasSnippetTerms({ text: 'foo' })).toBe(true);
    expect(filterHasSnippetTerms({ operator: 'AND', conditions: [{ inMailbox: 'x' }, { subject: 'foo' }] })).toBe(true);
    expect(
      filterHasSnippetTerms({
        operator: 'AND',
        conditions: [{ inMailbox: 'x' }, { operator: 'NOT', conditions: [{ body: 'foo' }] }],
      }),
    ).toBe(true);
  });

  it('ignores structural-only filters and empty terms', () => {
    expect(filterHasSnippetTerms(undefined)).toBe(false);
    expect(filterHasSnippetTerms({ inMailbox: 'x', hasKeyword: '$seen' })).toBe(false);
    expect(filterHasSnippetTerms({ minSize: 1024 })).toBe(false);
    expect(filterHasSnippetTerms({ from: 'alice' })).toBe(false);
    expect(filterHasSnippetTerms({ text: '   ' })).toBe(false);
  });
});

describe('snippetFilterFor', () => {
  it('strips the prefix-search wildcard from highlightable terms only', () => {
    expect(
      snippetFilterFor({
        operator: 'AND',
        conditions: [{ inMailbox: 'x' }, { text: 'inv* rece*' }, { from: 'ali*' }],
      }),
    ).toEqual({
      operator: 'AND',
      conditions: [{ inMailbox: 'x' }, { text: 'inv rece' }, { from: 'ali*' }],
    });
  });

  it('leaves a lone wildcard alone', () => {
    expect(snippetFilterFor({ text: '*' })).toEqual({ text: '*' });
  });

  it('unquotes phrases: one quoted term puts the whole request in exact mode on Stalwart 0.16 and 1.0', () => {
    expect(
      snippetFilterFor({
        operator: 'AND',
        conditions: [
          { text: '"annual report"' },
          { text: '2024' },
          { subject: "'draft'" },
          { from: '"Anna Muster"' },
          { inMailbox: 'x' },
        ],
      }),
    ).toEqual({
      operator: 'AND',
      conditions: [
        { text: 'annual report' },
        { text: '2024' },
        { subject: 'draft' },
        { from: '"Anna Muster"' },
        { inMailbox: 'x' },
      ],
    });
    expect(snippetFilterFor({ body: '"exact phrase"' })).toEqual({ body: 'exact phrase' });
    // Only a value wrapped in quotes is a phrase.
    expect(snippetFilterFor({ text: 'say "hi" twice' })).toEqual({ text: 'say "hi" twice' });
  });
});

describe('snippetHighlight', () => {
  it('keeps only the parts that mark something', () => {
    expect(snippetHighlight({ emailId: 'a', subject: '<mark>hit</mark> a', preview: null }))
      .toEqual({ subject: '<mark>hit</mark> a', preview: null });
    expect(snippetHighlight({ emailId: 'b', subject: 's-b', preview: 'nothing marked' })).toBeNull();
    expect(snippetHighlight({ emailId: 'c', subject: null, preview: 'body <mark>hit</mark>' }))
      .toEqual({ subject: null, preview: 'body <mark>hit</mark>' });
    expect(snippetHighlight({ emailId: 'd', subject: '<mark></mark>', preview: undefined })).toBeNull();
  });
});

describe('withSearchSnippets', () => {
  const email = (id: string, jmapAccountId?: string) => ({ id, subject: `Subject ${id}`, jmapAccountId }) as unknown as Email;
  const marked = (emailId: string) => ({ emailId, subject: `<mark>Subject</mark> ${emailId}`, preview: null });

  it('returns new objects only for the emails that gained a snippet', () => {
    const emails = [email('e1'), email('e2')];
    const next = withSearchSnippets(emails, [{ list: [marked('e2')] }]);

    expect(next).not.toBe(emails);
    expect(next[0]).toBe(emails[0]);
    expect(next[1]).not.toBe(emails[1]);
    expect(next[1].searchSnippet).toEqual({ subject: '<mark>Subject</mark> e2', preview: null });
    // The list already on screen is left untouched.
    expect(emails[1].searchSnippet).toBeUndefined();
  });

  it('returns the same list when nothing is highlighted', () => {
    const emails = [email('e1')];
    expect(withSearchSnippets(emails, [])).toBe(emails);
    expect(withSearchSnippets(emails, [{ list: [] }])).toBe(emails);
    expect(withSearchSnippets(emails, [{ list: [{ emailId: 'e1', subject: 'Subject e1', preview: null }] }])).toBe(emails);
    expect(withSearchSnippets(emails, [{ list: [marked('other')] }])).toBe(emails);
  });

  it("keeps each account's snippets to its own rows, since ids repeat across accounts", () => {
    const emails = [email('a', 'own'), email('a', 'group')];
    const next = withSearchSnippets(emails, [{ accountId: 'group', list: [marked('a')] }]);

    expect(next[0]).toBe(emails[0]);
    expect(next[1].searchSnippet?.subject).toBe('<mark>Subject</mark> a');
  });

  it('reads the account from the given stamp', () => {
    type Row = Email & { login: string };
    const emails = [{ ...email('a'), login: 'x' }, { ...email('a'), login: 'y' }] as Row[];
    const next = withSearchSnippets(emails, [{ accountId: 'y', list: [marked('a')] }], (e) => e.login);
    expect(next[0].searchSnippet).toBeUndefined();
    expect(next[1].searchSnippet?.subject).toBe('<mark>Subject</mark> a');
  });
});
