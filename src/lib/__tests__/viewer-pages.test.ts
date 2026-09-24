import { describe, it, expect } from 'vitest';
import { viewerInstance, viewerPages } from '../viewer-pages';
import type { Email } from '../../api/types';

function row(id: string, threadId = id): Email {
  return { id, threadId, subject: id } as Email;
}

const LIST = [row('n1'), row('q2', 'tq'), row('q1', 'tq'), row('o3')];

describe('viewerPages', () => {
  it('collapses the open folder to one page per thread, the opened message standing in', () => {
    const pages = viewerPages({
      emailId: 'q1', threadId: 'tq', list: LIST, threading: true,
    });
    expect(pages.map((e) => e.id)).toEqual(['n1', 'q1', 'o3']);
  });

  it('pages over every row when threading is off', () => {
    const pages = viewerPages({
      emailId: 'q1', threadId: 'tq', list: LIST, threading: false,
    });
    expect(pages.map((e) => e.id)).toEqual(['n1', 'q2', 'q1', 'o3']);
  });

  it('does not follow the list once taken, so new mail cannot shift the page (B5)', () => {
    const list = [...LIST];
    const pages = viewerPages({
      emailId: 'q2', threadId: 'tq', list, threading: false,
    });
    list.unshift(row('new1'), row('new2'));
    expect(pages.map((e) => e.id)).toEqual(['n1', 'q2', 'q1', 'o3']);
    expect(pages.findIndex((e) => e.id === 'q2')).toBe(1);
  });

  it('pages over the ids another list handed over, using the store row when there is one', () => {
    const pages = viewerPages({
      emailId: 'u1', threadId: 't-u1', emailIds: ['u1', 'o3'],
      list: LIST, threading: true,
    });
    expect(pages).toEqual([{ id: 'u1', threadId: 't-u1' }, LIST[3]]);
  });

  it('is a single page for a message the list does not hold', () => {
    const pages = viewerPages({
      emailId: 'm9', threadId: 't9', list: LIST, threading: true,
    });
    expect(pages).toEqual([{ id: 'm9', threadId: 't9' }]);
  });

  it('pages over nothing of a list of another account (B3)', () => {
    // The caller hands over only the rows of the message's account.
    const opened = viewerPages({
      emailId: 'q1', threadId: 'tq', list: [], threading: true,
    });
    expect(opened).toEqual([{ id: 'q1', threadId: 'tq' }]);

    const handed = viewerPages({
      emailId: 'o3', threadId: 't-o3', emailIds: ['o3'],
      list: [], threading: true,
    });
    expect(handed).toEqual([{ id: 'o3', threadId: 't-o3' }]);
  });
});

describe('viewerInstance', () => {
  it('keeps the instance while the params stay the same', () => {
    const params = { emailId: 'e1' };
    const first = viewerInstance(null, params);
    expect(viewerInstance(first, params)).toBe(first);
  });

  it('starts a new instance for every new open, even of the same message', () => {
    const first = viewerInstance(null, { emailId: 'e1' });
    const other = viewerInstance(first, { emailId: 'e2', jmapAccountId: 'group' });
    const again = viewerInstance(other, { emailId: 'e2', jmapAccountId: 'group' });

    expect(other.key).not.toBe(first.key);
    expect(other.key).toContain('group|e2');
    expect(again.key).not.toBe(other.key);
  });
});
