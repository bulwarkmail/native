import { describe, it, expect } from 'vitest';
import { splitSearchText, textConditions, textFilter } from '../search-utils';
import { textFilterMatches, type StalwartTextVersion } from './stalwart-text-model';

type Filter = Record<string, unknown>;

/** Stalwart rejects a filter object with both `operator` and property keys. */
function expectNoMixedKeys(filter: Filter): void {
  if ('operator' in filter) {
    expect(Object.keys(filter).sort()).toEqual(['conditions', 'operator']);
    for (const c of filter.conditions as Filter[]) expectNoMixedKeys(c);
  } else {
    expect(filter).not.toHaveProperty('conditions');
  }
}

const MESSAGES = [
  { id: 'report', from: 'Anna Muster <anna@firma.de>', to: 'team@firma.de', subject: 'Draft: annual report 2024', body: 'The numbers are final.' },
  { id: 'shuffled', from: 'Ben <ben@firma.de>', to: 'team@firma.de', subject: 'Report on annual goals, 2024 draft', body: '' },
  { id: 'budget', from: 'Carla <carla@firma.de>', to: 'team@firma.de', subject: 'Project budget', body: 'Numbers for Q3.' },
  { id: 'board', from: 'Dieter <dieter@firma.de>', to: 'team@firma.de', subject: 'Protokoll', body: 'Die Geschäftsführung hat entschieden.' },
];

const hits = (version: StalwartTextVersion, filter: Filter) =>
  MESSAGES.filter((m) => textFilterMatches(version, filter, m)).map((m) => m.id);

/** What the app sent before: a `*` after every word (the old toWildcardQuery). */
const withWildcards = (query: string) => query.trim().split(/\s+/)
  .map((word) => (word.endsWith('*') || word.endsWith('"') ? word : `${word}*`))
  .join(' ');

describe('splitSearchText', () => {
  it('gives every quoted phrase a part of its own', () => {
    expect(splitSearchText('"annual report" 2024 "draft"')).toEqual(['"annual report"', '2024', '"draft"']);
  });

  it('keeps plain queries as one part, as typed', () => {
    expect(splitSearchText('project budget')).toEqual(['project budget']);
    expect(splitSearchText('anna@firma.de')).toEqual(['anna@firma.de']);
    expect(splitSearchText('Geschäftsführung')).toEqual(['Geschäftsführung']);
    expect(splitSearchText('  project   budget ')).toEqual(['project budget']);
    expect(splitSearchText('e-mail')).toEqual(['e-mail']);
  });

  it('gives every word ending in * a part of its own', () => {
    expect(splitSearchText('project budg*')).toEqual(['project', 'budg*']);
    expect(splitSearchText('"a b" c d*')).toEqual(['"a b"', 'c', 'd*']);
  });

  it('keeps the other words together in one part where the first of them was typed', () => {
    expect(splitSearchText('q3 "annual report" budget')).toEqual(['q3 budget', '"annual report"']);
    expect(splitSearchText('budg* "annual report" project')).toEqual(['budg*', '"annual report"', 'project']);
  });

  it('closes an unterminated quote at the end of the input', () => {
    expect(splitSearchText('"half typed')).toEqual(['"half typed"']);
    expect(splitSearchText('invoice "half typed')).toEqual(['invoice', '"half typed"']);
  });

  it('drops empty quotes and lone stars', () => {
    expect(splitSearchText('""')).toEqual([]);
    expect(splitSearchText('"  " budget')).toEqual(['budget']);
    expect(splitSearchText('*')).toEqual([]);
    expect(splitSearchText('budget * **')).toEqual(['budget']);
  });

  it('strips outer single quotes, which would make the words one phrase', () => {
    expect(splitSearchText("'annual' 2024 'draft'")).toEqual(["annual' 2024 'draft"]);
    expect(splitSearchText("'annual report'")).toEqual(['annual report']);
    expect(splitSearchText("''")).toEqual([]);
  });
});

describe('textConditions / textFilter', () => {
  it('makes one condition per part on the given property', () => {
    expect(textConditions('"annual report" 2024 "draft"')).toEqual([
      { text: '"annual report"' }, { text: '2024' }, { text: '"draft"' },
    ]);
    expect(textConditions('anna mül*', 'from')).toEqual([{ from: 'anna' }, { from: 'mül*' }]);
  });

  it('sends the input as before when no part is left', () => {
    expect(textConditions('""')).toEqual([{ text: '""' }]);
    expect(textConditions(' * ')).toEqual([{ text: '*' }]);
  });

  it('returns a single condition as is and ANDs several, never mixing keys', () => {
    expect(textFilter('project budget')).toEqual({ text: 'project budget' });
    const filter = textFilter('"annual report" 2024');
    expect(filter).toEqual({ operator: 'AND', conditions: [{ text: '"annual report"' }, { text: '2024' }] });
    expectNoMixedKeys(filter);
  });
});

describe('text search results (P1-7)', () => {
  it.each<[string, string[]]>([
    ['project budget', ['budget']],
    ['anna@firma.de', ['report']],
    ['Geschäftsführung', ['board']],
  ])('finds %s on Stalwart 1.0, where the old wildcards found nothing, and the same on 0.16', (query, expected) => {
    // `project* budget*` is one prefix containing a space; the address is not
    // one word; `geschäftsführung` is 18 bytes, over the 16-byte prefix cap.
    expect(hits('1.0', { text: withWildcards(query) })).toEqual([]);
    expect(textFilter(query)).toEqual({ text: query });
    expect(hits('1.0', textFilter(query))).toEqual(expected);
    // 0.16 drops the `*`, so sending the text as typed changes nothing there.
    expect(hits('0.16', { text: withWildcards(query) })).toEqual(expected);
    expect(hits('0.16', textFilter(query))).toEqual(expected);
  });

  it('finds "annual report" 2024 "draft" on Stalwart 1.0 as three conditions', () => {
    expect(hits('1.0', { text: withWildcards('"annual report" 2024') })).toEqual([]);
    expect(hits('1.0', { text: '"annual report" 2024 "draft"' })).toEqual([]);
    expect(hits('1.0', textFilter('"annual report" 2024 "draft"'))).toEqual(['report']);
  });

  it('keeps the 0.16 hits for "annual report" 2024 "draft": an AND of the words', () => {
    expect(hits('0.16', { text: '"annual report" 2024 "draft"' })).toEqual(['report', 'shuffled']);
    expect(hits('0.16', textFilter('"annual report" 2024 "draft"'))).toEqual(['report', 'shuffled']);
  });

  it('finds project budg* on Stalwart 1.0 and changes nothing on 0.16', () => {
    expect(hits('1.0', { text: 'project budg*' })).toEqual([]);
    expect(hits('1.0', textFilter('project budg*'))).toEqual(['budget']);
    expect(hits('0.16', textFilter('project budg*'))).toEqual([]);
  });
});
