import { describe, it, expect } from 'vitest';
import { viewerPages } from '../viewer-pages';
import type { Email } from '../../api/types';

function row(id: string, threadId = id): Email {
  return { id, threadId, subject: id } as Email;
}

const LIST = [row('n1'), row('q2', 'tq'), row('q1', 'tq'), row('o3')];

describe('viewerPages', () => {
  it('collapses the open folder to one page per thread, the opened message standing in', () => {
    const pages = viewerPages({
      emailId: 'q1', threadId: 'tq', list: LIST, listIsMessageAccount: true, threading: true,
    });
    expect(pages.map((e) => e.id)).toEqual(['n1', 'q1', 'o3']);
  });

  it('pages over every row when threading is off', () => {
    const pages = viewerPages({
      emailId: 'q1', threadId: 'tq', list: LIST, listIsMessageAccount: true, threading: false,
    });
    expect(pages.map((e) => e.id)).toEqual(['n1', 'q2', 'q1', 'o3']);
  });

  it('does not follow the list once taken, so new mail cannot shift the page (B5)', () => {
    const list = [...LIST];
    const pages = viewerPages({
      emailId: 'q2', threadId: 'tq', list, listIsMessageAccount: true, threading: false,
    });
    list.unshift(row('new1'), row('new2'));
    expect(pages.map((e) => e.id)).toEqual(['n1', 'q2', 'q1', 'o3']);
    expect(pages.findIndex((e) => e.id === 'q2')).toBe(1);
  });

  it('pages over the ids another list handed over, using the store row when there is one', () => {
    const pages = viewerPages({
      emailId: 'u1', threadId: 't-u1', emailIds: ['u1', 'o3'],
      list: LIST, listIsMessageAccount: true, threading: true,
    });
    expect(pages).toEqual([{ id: 'u1', threadId: 't-u1' }, LIST[3]]);
  });

  it('is a single page for a message the list does not hold', () => {
    const pages = viewerPages({
      emailId: 'm9', threadId: 't9', list: LIST, listIsMessageAccount: true, threading: true,
    });
    expect(pages).toEqual([{ id: 'm9', threadId: 't9' }]);
  });

  it('never takes another account\'s rows, even under the same id (B3)', () => {
    const opened = viewerPages({
      emailId: 'q1', threadId: 'tq', list: LIST, listIsMessageAccount: false, threading: true,
    });
    expect(opened).toEqual([{ id: 'q1', threadId: 'tq' }]);

    const handed = viewerPages({
      emailId: 'o3', threadId: 't-o3', emailIds: ['o3'],
      list: LIST, listIsMessageAccount: false, threading: true,
    });
    expect(handed).toEqual([{ id: 'o3', threadId: 't-o3' }]);
  });
});
