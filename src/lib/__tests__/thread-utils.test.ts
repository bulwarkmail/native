import { describe, it, expect } from 'vitest';
import {
  collapseThreads,
  expandThreadSelection,
  getEmailTagIds,
  getThreadTagIds,
  tagIdFromKeyword,
  threadKeyOf,
  rowKeyOf,
} from '../thread-utils';
import type { Email } from '../../api/types';

function email(id: string, threadId: string, receivedAt: string, keywords: Record<string, boolean> = {}): Email {
  return {
    id, threadId, receivedAt, keywords, mailboxIds: {}, size: 0, hasAttachment: false,
  };
}

describe('tag ids', () => {
  it('reads both the $label: and legacy $color: prefixes once', () => {
    expect(getEmailTagIds({ '$label:work': true, '$color:work': true, '$label:todo': true, $seen: true, '$label:off': false }))
      .toEqual(['work', 'todo']);
    expect(getEmailTagIds(undefined)).toEqual([]);
  });

  it('unions the tags of a whole thread', () => {
    expect(getThreadTagIds([
      email('a', 't', '2026-01-01T00:00:00Z', { '$label:work': true }),
      email('b', 't', '2026-01-02T00:00:00Z', { '$label:todo': true, '$label:work': true }),
    ])).toEqual(['work', 'todo']);
  });

  it('extracts the tag id from a keyword', () => {
    expect(tagIdFromKeyword('$label:work')).toBe('work');
    expect(tagIdFromKeyword('$color:work')).toBe('work');
    expect(tagIdFromKeyword('$seen')).toBeNull();
    expect(tagIdFromKeyword('$label:')).toBeNull();
  });
});

describe('collapseThreads', () => {
  const oldest = email('a', 't1', '2026-01-01T00:00:00Z');
  const newest = email('b', 't1', '2026-01-03T00:00:00Z');
  const other = email('c', 't2', '2026-01-02T00:00:00Z');

  it('represents a thread by its newest message even in an ascending list', () => {
    const rows = collapseThreads([oldest, other, newest], false);
    expect(rows.map((e) => e.id)).toEqual(['b', 'c']);
  });

  it('keeps the position of the first message the list showed', () => {
    const rows = collapseThreads([other, oldest, newest], false);
    expect(rows.map((e) => e.id)).toEqual(['c', 'b']);
  });

  it('leaves every message as its own row when threading is off', () => {
    expect(collapseThreads([oldest, other, newest], true).map((e) => e.id)).toEqual(['a', 'c', 'b']);
  });

  it("keeps two accounts' threads with the same id apart (#1082)", () => {
    // Stalwart hands out per-account counters, so an "All folders" list can
    // hold an own and a team thread that share an id.
    const own = { ...email('a', 't1', '2026-01-01T00:00:00Z'), jmapAccountId: 'c' };
    const team = { ...email('a', 't1', '2026-01-02T00:00:00Z'), jmapAccountId: 'team' };
    expect(collapseThreads([team, own], false)).toEqual([team, own]);
    expect(threadKeyOf(own, false)).toBe('c:t1');
    expect(threadKeyOf(team, true)).toBe('team:a');
    expect(threadKeyOf(email('a', 't1', '2026-01-01T00:00:00Z'), false)).toBe('t1');
  });

  it('puts threads with a pinned message first', () => {
    const pinned = email('d', 't3', '2025-12-01T00:00:00Z', { $pinned: true });
    expect(collapseThreads([other, oldest, pinned], false).map((e) => e.id)).toEqual(['d', 'c', 'a']);
    expect(collapseThreads([other, oldest, pinned], false, { pinnedFirst: false }).map((e) => e.id)).toEqual(['c', 'a', 'd']);
  });
});

describe('expandThreadSelection', () => {
  const emails = [
    email('a', 't1', '2026-01-01T00:00:00Z'),
    email('b', 't1', '2026-01-03T00:00:00Z'),
    email('c', 't2', '2026-01-02T00:00:00Z'),
  ];

  it('expands a representative to every loaded message of its thread', () => {
    expect(expandThreadSelection(['b'], emails, false)).toEqual(['a', 'b']);
    expect(expandThreadSelection(['b', 'c'], emails, false)).toEqual(['a', 'b', 'c']);
  });

  it('passes ids through when threading is off or the id is unknown', () => {
    expect(expandThreadSelection(['b'], emails, true)).toEqual(['b']);
    expect(expandThreadSelection(['zzz'], emails, false)).toEqual(['zzz']);
  });

  it('works on row keys, so two accounts\' same ids stay apart (#1082)', () => {
    const own = [email('a', 't1', '2026-01-01T00:00:00Z'), email('b', 't1', '2026-01-03T00:00:00Z')]
      .map((e) => ({ ...e, jmapAccountId: 'c' }));
    const team = [email('a', 't1', '2026-01-02T00:00:00Z')].map((e) => ({ ...e, jmapAccountId: 'team' }));
    const rows = [...own, ...team];

    expect(rowKeyOf(team[0])).toBe('team:a');
    expect(rowKeyOf(emails[0])).toBe('a');
    expect(expandThreadSelection(['c:b'], rows, false)).toEqual(['c:a', 'c:b']);
    expect(expandThreadSelection(['team:a'], rows, false)).toEqual(['team:a']);
  });
});
