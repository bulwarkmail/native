import { describe, it, expect, vi } from 'vitest';

vi.mock('../jmap-client', () => ({ jmapClient: {} }));

import { buildFilter } from '../unified-inbox';
import type { Mailbox } from '../types';

const inbox = { id: 'inbox', role: 'inbox', name: 'Inbox' } as Mailbox;

describe('unified inbox search filter', () => {
  it('sends the typed words with no wildcard', () => {
    expect(buildFilter([inbox], { role: 'inbox', query: '  runn  fast ' } as never)).toEqual({
      operator: 'AND',
      conditions: [{ inMailbox: 'inbox' }, { text: 'runn  fast' }],
    });
  });

  const m = (id: string, role: string) => ({ id, role, name: id }) as Mailbox;
  const folders = [m('i', 'inbox'), m('s', 'sent'), m('a', 'archive'), m('t', 'trash'), m('j', 'junk')];

  it('searches All mail across every folder but Trash and Junk, Sent included', () => {
    expect(buildFilter(folders, { view: 'all', query: 'invoice' })).toEqual({
      operator: 'AND',
      conditions: [{ text: 'invoice' }, { inMailboxOtherThan: ['t', 'j'] }],
    });
  });

  it("excludes each account's own Trash and Junk ids", () => {
    expect(buildFilter([m('x', 'inbox'), m('y', 'trash')], { view: 'all', query: 'q' })).toEqual({
      operator: 'AND',
      conditions: [{ text: 'q' }, { inMailboxOtherThan: ['y'] }],
    });
  });

  it('leaves All mail without a search, and Unread/Starred searches, on the cross-view list', () => {
    expect(buildFilter(folders, { view: 'all' })).toEqual({ inMailbox: 'i' });
    expect(buildFilter(folders, { view: 'unread', query: 'q' })).toEqual({
      operator: 'AND',
      conditions: [{ inMailbox: 'i' }, { notKeyword: '$seen' }, { text: 'q' }],
    });
    expect(buildFilter(folders, { view: 'all', query: '   ' })).toEqual({ inMailbox: 'i' });
  });
});
