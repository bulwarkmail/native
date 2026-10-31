import { describe, it, expect, vi, beforeEach } from 'vitest';

const { auth } = vi.hoisted(() => ({
  auth: { activeAccountId: 'login-a' as string | null, switchAccount: vi.fn() },
}));
vi.mock('../../stores/auth-store', () => ({ useAuthStore: { getState: () => auth } }));

import { openHit, filesLinkFor } from '../global-search/open-hit';
import { usePendingCalendarOpen } from '../../navigation/pending-calendar-open';
import { usePendingFilesLink } from '../../navigation/pending-files-link';
import type { GlobalSearchHit } from '../global-search/types';

const base = { localAccountId: 'login-a', jmapAccountId: 'own', shared: false, accountLabel: 'Me', subtitle: '', date: null, source: 'remote' as const };

beforeEach(() => {
  auth.activeAccountId = 'login-a';
  auth.switchAccount.mockReset();
  usePendingCalendarOpen.setState({ target: null });
  usePendingFilesLink.setState({ link: null });
});

describe('opening a search hit', () => {
  it("opens a group account's message under that account, paging over the same account's hits", async () => {
    const navigate = vi.fn();
    const mail = (id: string, jmapAccountId: string, shared: boolean): GlobalSearchHit => ({
      ...base, kind: 'mail', id, jmapAccountId, shared, title: id, snippet: null,
      email: { id, threadId: `t-${id}`, subject: id } as never,
    });
    const target = mail('5', 'team', true);
    await openHit(target, { navigate }, [mail('4', 'team', true), target, mail('5', 'own', false)]);
    expect(navigate).toHaveBeenCalledWith('EmailThread', expect.objectContaining({
      emailId: '5', threadId: 't-5', jmapAccountId: 'team', emailIds: ['4', '5'],
    }));
  });

  it("switches to the hit's login first, and opens nothing when the switch fails", async () => {
    const navigate = vi.fn();
    const contact: GlobalSearchHit = {
      ...base, localAccountId: 'login-b', kind: 'contacts', id: 'c1', title: 'Anna', storeId: 'c1', contact: { id: 'c1' } as never,
    };
    auth.switchAccount.mockImplementation(async (id: string) => { auth.activeAccountId = id; });
    await openHit(contact, { navigate });
    expect(auth.switchAccount).toHaveBeenCalledWith('login-b');
    expect(navigate).toHaveBeenCalledWith('ContactDetail', { contactId: 'c1' });

    navigate.mockReset();
    auth.activeAccountId = 'login-a';
    auth.switchAccount.mockImplementation(async () => undefined);
    expect(await openHit(contact, { navigate })).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('hands a shared calendar event to the Calendar tab by its server id and account', async () => {
    const navigate = vi.fn();
    await openHit({
      ...base, kind: 'calendar', id: 'ev', jmapAccountId: 'boss', shared: true, title: 'Sync', isRecurring: false,
      event: { id: 'ev', start: '2026-03-02T10:00:00', calendarIds: {} } as never,
    }, { navigate });
    expect(usePendingCalendarOpen.getState().target).toMatchObject({ kind: 'event', eventId: 'boss:ev', serverId: 'ev', accountId: 'boss' });
    expect(navigate).toHaveBeenCalledWith('MainTabs', { screen: 'Calendar' });
  });

  it('opens a file in its folder with a preview, a folder by its path, and a shared node by its listed id', async () => {
    const file = (over: Record<string, unknown>): Extract<GlobalSearchHit, { kind: 'files' }> => ({
      ...base, kind: 'files', id: 'n', title: 'x', folderPath: '/Docs', isFolder: false,
      node: { id: 'n', name: 'report.pdf' } as never, ...over,
    } as never);
    expect(filesLinkFor(file({}))).toEqual({ path: '/Docs', preview: 'report.pdf' });
    expect(filesLinkFor(file({ isFolder: true, folderPath: '/', node: { id: 'n', name: 'Tax' } }))).toEqual({ path: '/Tax' });
    expect(filesLinkFor(file({ node: { id: 'boss:n', name: 'a', isShared: true } }))).toEqual({ path: '/', shared: 'boss:n' });

    const navigate = vi.fn();
    await openHit(file({}), { navigate });
    expect(usePendingFilesLink.getState().link).toEqual({ path: '/Docs', preview: 'report.pdf' });
    expect(navigate).toHaveBeenCalledWith('MainTabs', { screen: 'Files' });
  });
});
