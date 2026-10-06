import { describe, expect, it } from 'vitest';
import { parseSearchQuery } from '../query-parser';
import { mergeHits, rankHits, scoreHit } from '../rank';
import type { ContactHit, GlobalSearchHit, MailHit } from '../types';

function mail(overrides: Partial<MailHit>): MailHit {
  return {
    kind: 'mail',
    appAccountId: 'login-a',
    jmapAccountId: 'a',
    id: 'm1',
    accountLabel: 'A',
    title: 'Subject',
    subtitle: 'Inbox',
    date: '2026-01-01T00:00:00Z',
    source: 'local',
    email: { id: 'm1' } as MailHit['email'],
    snippet: null,
    ...overrides,
  };
}

function contact(overrides: Partial<ContactHit>): ContactHit {
  return {
    kind: 'contacts',
    appAccountId: 'login-a',
    jmapAccountId: 'a',
    id: 'c1',
    accountLabel: 'A',
    title: 'Bob Miller',
    subtitle: 'Personal',
    date: null,
    source: 'local',
    contact: { id: 'c1' } as ContactHit['contact'],
    storeId: 'login-a::c1',
    ...overrides,
  };
}

describe('scoreHit', () => {
  const parsed = parseSearchQuery('bob miller');
  it('prefers exact, then prefix, then whole-word, then substring, then subtitle', () => {
    expect(scoreHit(contact({ title: 'Bob Miller' }), parsed)).toBe(100);
    expect(scoreHit(contact({ title: 'Bob Miller Jr' }), parsed)).toBe(80);
    expect(scoreHit(contact({ title: 'Miller, Bob' }), parsed)).toBe(60);
    expect(scoreHit(contact({ title: 'Jobob Smiller' }), parsed)).toBe(50);
    expect(scoreHit(contact({ title: 'Bob Smith' }), parsed)).toBe(30);
    expect(scoreHit(contact({ title: 'Someone', subtitle: 'bob@x' }), parsed)).toBe(20);
    expect(scoreHit(contact({ title: 'Someone', subtitle: 'zzz' }), parsed)).toBe(10);
  });

  it('gives every hit the floor score for operator-only queries', () => {
    expect(scoreHit(contact({ title: 'Anything' }), parseSearchQuery('is:unread'))).toBe(10);
  });
});

describe('rankHits', () => {
  it('orders by score, then recency, then title', () => {
    const parsed = parseSearchQuery('report');
    const hits: GlobalSearchHit[] = [
      mail({ id: '1', title: 'Old report', date: '2025-01-01T00:00:00Z' }),
      mail({ id: '2', title: 'report', date: '2024-01-01T00:00:00Z' }),
      mail({ id: '3', title: 'New report', date: '2026-01-01T00:00:00Z' }),
      mail({ id: '4', title: 'Nothing here', date: '2027-01-01T00:00:00Z' }),
      mail({ id: '5', title: 'Undated report', date: null }),
    ];
    expect(rankHits(hits, parsed).map((h) => h.id)).toEqual(['2', '3', '1', '5', '4']);
  });
});

describe('mergeHits', () => {
  it('lets a remote hit replace its local twin but not the other way round', () => {
    const local = mail({ id: 'm1', source: 'local' });
    const remote = mail({ id: 'm1', source: 'remote', snippet: { subject: '<mark>x</mark>', preview: null } });
    expect(mergeHits([local], [remote])).toEqual([remote]);
    expect(mergeHits([remote], [local])).toEqual([remote]);
  });

  it('keeps same ids from different logins apart when no server identity is known (#847)', () => {
    const a = mail({ id: 'm1', appAccountId: 'login-a' });
    const b = mail({ id: 'm1', appAccountId: 'login-b' });
    expect(mergeHits([a], [b])).toHaveLength(2);
  });

  it('collapses the same server object reached through two logins to one hit', () => {
    const viaA = mail({ id: 'm1', appAccountId: 'login-a', jmapAccountId: 'c', serverUrl: 'https://mail.example' });
    const viaB = mail({ id: 'm1', appAccountId: 'login-b', jmapAccountId: 'c', serverUrl: 'https://mail.example' });
    expect(mergeHits([viaA], [viaB])).toHaveLength(1);
  });

  it('keeps the same id on two different servers apart (#847)', () => {
    const serverOne = mail({ id: 'm1', appAccountId: 'login-a', jmapAccountId: 'c', serverUrl: 'https://one.example' });
    const serverTwo = mail({ id: 'm1', appAccountId: 'login-b', jmapAccountId: 'c', serverUrl: 'https://two.example' });
    expect(mergeHits([serverOne], [serverTwo])).toHaveLength(2);
  });

  it('keeps the same id across kinds apart', () => {
    expect(mergeHits([mail({ id: 'x' })], [contact({ id: 'x' })])).toHaveLength(2);
  });

  it('collapses a local occurrence and the remote master of the same series', () => {
    const occurrence = {
      kind: 'calendar', appAccountId: 'login-a', jmapAccountId: 'a', id: 'e1-occ2', accountLabel: 'A',
      title: 'Weekly sync', subtitle: 'Work', date: '2026-02-08T09:00:00', source: 'local',
      event: { id: 'e1-occ2', uid: 'series-1' }, isRecurring: true,
    } as unknown as GlobalSearchHit;
    const master = {
      ...occurrence, id: 'e1', source: 'remote', event: { id: 'e1', uid: 'series-1' },
    } as unknown as GlobalSearchHit;
    const merged = mergeHits([occurrence], [master]);
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe('e1');
    // Different logins with the same invite stay apart (#847).
    const otherLogin = { ...master, appAccountId: 'login-b' } as GlobalSearchHit;
    expect(mergeHits([master], [otherLogin])).toHaveLength(2);
  });
});

describe('hostile titles', () => {
  it('scores a 200 KB sender-controlled title in linear time', () => {
    const parsed = parseSearchQuery('aaaa bbbb');
    const title = 'a'.repeat(200_000);
    const started = Date.now();
    const score = scoreHit(contact({ title, subtitle: title }), parsed);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(score).toBe(30);
  });
});
