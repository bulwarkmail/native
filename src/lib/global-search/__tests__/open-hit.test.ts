import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalendarHit, ContactHit, FileHit, MailHit } from '../types';

// ---------------------------------------------------------------------------
// Two signed-in accounts on Stalwart, whose ids repeat: each has a message
// "1" and a contact "c1". The client serves one account at a time; a switch
// moves it (new connection generation) and the email store's shown account.
// ---------------------------------------------------------------------------

interface Server {
  jmap: string;
  emails: Record<string, { id: string; threadId: string; subject: string }>;
}
const servers: Record<string, Server> = {
  'login-a': { jmap: 'ja', emails: { '1': { id: '1', threadId: 'thread-a', subject: 'From A' } } },
  'login-b': { jmap: 'jb', emails: { '1': { id: '1', threadId: 'thread-b', subject: 'From B' } } },
};
/** Messages of a group account inside login A. */
const groupEmails: Record<string, { id: string; threadId: string; subject: string }> = {
  '1': { id: '1', threadId: 'thread-group', subject: 'Group' },
};

const client = { connectionGen: 1, accountId: 'ja', served: 'login-a' as string | null };
const emailState = { activeAccountId: 'login-a' as string | null };
const contactsState = {
  contacts: [] as Array<{ id: string; name: string }>,
  /** Connection the cards were read on (the real store stamps it on a full load). */
  contactsGen: null as number | null,
  fetchContacts: vi.fn(async () => {}),
};

function storeHook(state: object) {
  const hook = (selector?: (s: object) => unknown) => (typeof selector === 'function' ? selector(state) : state);
  hook.getState = () => state;
  hook.subscribe = () => () => {};
  return hook;
}

function stale(): Error {
  return Object.assign(new Error('stale'), { name: 'StaleLoadError' });
}

/** Lands the switch: the shown account first, then the connection, like auth-store. */
function serve(appAccountId: string) {
  emailState.activeAccountId = appAccountId;
  client.connectionGen += 1;
  client.served = appAccountId;
  client.accountId = servers[appAccountId].jmap;
}

const switchAccount = vi.fn(async (appAccountId: string) => { serve(appAccountId); });

vi.mock('../../../api/jmap-client', () => ({ jmapClient: client }));
vi.mock('../../../lib/active-client-account', () => ({
  clientServesAccount: (id: string | null | undefined) => !!id && id === client.served,
}));
vi.mock('../../../stores/email-store', () => ({
  isShownAccount: (id: string | null | undefined) => !!id && id === emailState.activeAccountId,
  requireShownAccountScope: (id: string | null | undefined, jmapAccountId?: string) => {
    if (!id || id !== emailState.activeAccountId) throw new Error('This belongs to another account. Switch back to it and try again.');
    if (client.served !== id) throw new Error('This account is still loading. Try again in a moment.');
    return { gen: client.connectionGen, accountId: jmapAccountId ?? client.accountId };
  },
}));
vi.mock('../../../stores/auth-store', () => ({
  useAuthStore: storeHook({ switchAccount: (id: string) => switchAccount(id) }),
}));
vi.mock('../../../stores/contacts-store', () => ({ useContactsStore: storeHook(contactsState) }));
vi.mock('../../../stores/locale-store', () => ({
  useLocaleStore: storeHook({ t: (_key: string, fallback: string) => fallback }),
}));

/** Email/get on `scope`: the served account's messages, refused on a replaced connection. */
const getEmails = vi.fn(async (ids: string[], scope: { gen: number; accountId: string }) => {
  if (scope.gen !== client.connectionGen) throw stale();
  const store = scope.accountId === 'group-x'
    ? groupEmails
    : Object.values(servers).find((s) => s.jmap === scope.accountId && client.served
      && servers[client.served].jmap === scope.accountId)?.emails ?? {};
  return ids.map((id) => store[id]).filter(Boolean);
});
vi.mock('../../../api/email', () => ({ getEmails: (ids: string[], scope: never) => getEmails(ids, scope) }));
const prefetchMessage = vi.fn();
vi.mock('../../email-detail-cache', () => ({ prefetchMessage: (...args: unknown[]) => prefetchMessage(...args) }));

const { openHit } = await import('../open-hit');
const { usePendingCalendarOpen } = await import('../../../navigation/pending-calendar-open');
const { usePendingFilesOpen } = await import('../../../navigation/pending-files-open');

function mailHit(appAccountId: string, jmapAccountId: string, id = '1'): MailHit {
  return {
    kind: 'mail', appAccountId, jmapAccountId, id, accountLabel: appAccountId, title: 'x', subtitle: '',
    date: null, source: 'remote', email: { id, threadId: 'from-hit' } as never, snippet: null,
  };
}

function nav(active = true) {
  return { openThread: vi.fn(), openContact: vi.fn(), openTab: vi.fn(), active: () => active };
}

const SWITCH_BACK = 'This belongs to another account. Switch back to it and try again.';

beforeEach(() => {
  client.connectionGen = 1;
  client.accountId = 'ja';
  client.served = 'login-a';
  emailState.activeAccountId = 'login-a';
  contactsState.contacts = [];
  contactsState.contactsGen = null;
  contactsState.fetchContacts.mockReset();
  contactsState.fetchContacts.mockImplementation(async () => {});
  switchAccount.mockReset();
  switchAccount.mockImplementation(async (id: string) => { serve(id); });
  getEmails.mockClear();
  usePendingCalendarOpen.setState({ target: null });
  usePendingFilesOpen.setState({ target: null });
});

describe('openHit: mail', () => {
  it("opens the shown account's message without switching", async () => {
    const n = nav();
    const result = await openHit(mailHit('login-a', 'ja'), n);
    expect(result).toEqual({ opened: true });
    expect(switchAccount).not.toHaveBeenCalled();
    expect(n.openThread).toHaveBeenCalledWith({ emailId: '1', threadId: 'thread-a', subject: 'From A', jmapAccountId: undefined, emailIds: ['1'] });
  });

  it("switches first, then opens B's message 1, never A's", async () => {
    const n = nav();
    const order: string[] = [];
    switchAccount.mockImplementation(async (id: string) => { order.push('switch'); serve(id); });
    getEmails.mockImplementationOnce(async (ids, scope) => {
      order.push(`get@${scope.gen}:${scope.accountId}`);
      return ids.map((id) => servers['login-b'].emails[id]);
    });
    const result = await openHit(mailHit('login-b', 'jb'), n);
    expect(result).toEqual({ opened: true });
    expect(order).toEqual(['switch', 'get@2:jb']);
    expect(n.openThread).toHaveBeenCalledWith(expect.objectContaining({ emailId: '1', threadId: 'thread-b' }));
  });

  it('stops with the switch-back text when the switch did not land', async () => {
    switchAccount.mockImplementation(async () => {});
    const n = nav();
    const result = await openHit(mailHit('login-b', 'jb'), n);
    expect(result).toEqual({ opened: false, message: SWITCH_BACK });
    expect(getEmails).not.toHaveBeenCalled();
    expect(n.openThread).not.toHaveBeenCalled();
  });

  it('opens nothing when another account is shown before the message arrives', async () => {
    getEmails.mockImplementationOnce(async (ids) => {
      serve('login-b');
      return ids.map((id) => servers['login-a'].emails[id]);
    });
    const n = nav();
    const result = await openHit(mailHit('login-a', 'ja'), n);
    expect(result).toEqual({ opened: false, message: SWITCH_BACK });
    expect(n.openThread).not.toHaveBeenCalled();
  });

  it("reads a group account's message on that account and opens it there", async () => {
    const n = nav();
    await openHit(mailHit('login-a', 'group-x'), n);
    expect(getEmails).toHaveBeenCalledWith(['1'], { gen: 1, accountId: 'group-x' });
    expect(n.openThread).toHaveBeenCalledWith({
      emailId: '1', threadId: 'thread-group', subject: 'Group', jmapAccountId: 'group-x', emailIds: ['1'],
    });
    expect(prefetchMessage).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-group' }), 'group-x');
  });

  it('says the message is gone when the server no longer has it', async () => {
    const n = nav();
    const result = await openHit(mailHit('login-a', 'ja', '404'), n);
    expect(result).toEqual({ opened: false, message: 'This message is no longer available.' });
    expect(n.openThread).not.toHaveBeenCalled();
  });

  it('resolves, never rejects, when the read or the switch fails', async () => {
    getEmails.mockRejectedValueOnce(new Error('offline'));
    await expect(openHit(mailHit('login-a', 'ja'), nav())).resolves.toEqual({
      opened: false, message: 'This message is no longer available.',
    });
    switchAccount.mockRejectedValueOnce(new Error('boom'));
    await expect(openHit(mailHit('login-b', 'jb'), nav())).resolves.toEqual({ opened: false, message: SWITCH_BACK });
  });
});

describe('openHit: the opener left', () => {
  it('opens and parks nothing once the search screen is gone, and says nothing', async () => {
    const n = nav(false);
    expect(await openHit(mailHit('login-b', 'jb'), n)).toEqual({ opened: false, message: null });
    expect(n.openThread).not.toHaveBeenCalled();
    const event: CalendarHit = {
      kind: 'calendar', appAccountId: 'login-b', jmapAccountId: 'jb', id: 'e1', accountLabel: '', title: '',
      subtitle: '', date: null, source: 'remote', isRecurring: false, event: { id: 'e1' } as never,
    };
    expect(await openHit(event, n)).toEqual({ opened: false, message: null });
    expect(usePendingCalendarOpen.getState().target).toBeNull();
    expect(n.openTab).not.toHaveBeenCalled();
  });
});

describe('openHit: contacts', () => {
  const hit = (appAccountId: string): ContactHit => ({
    kind: 'contacts', appAccountId, jmapAccountId: servers[appAccountId].jmap, id: 'c1', accountLabel: '',
    title: 'Ann', subtitle: '', date: null, source: 'remote', contact: { id: 'c1' } as never, storeId: 'c1',
  });

  it('loads the contacts of the account it switched to, then opens the card', async () => {
    contactsState.fetchContacts.mockImplementation(async () => {
      contactsState.contacts = [{ id: 'c1', name: 'B card' }];
      contactsState.contactsGen = client.connectionGen;
    });
    const n = nav();
    const result = await openHit(hit('login-b'), n);
    expect(result).toEqual({ opened: true });
    expect(switchAccount).toHaveBeenCalledWith('login-b');
    expect(contactsState.fetchContacts).toHaveBeenCalled();
    expect(n.openContact).toHaveBeenCalledWith('c1');
  });

  it('opens a loaded card without fetching', async () => {
    contactsState.contacts = [{ id: 'c1', name: 'A card' }];
    contactsState.contactsGen = 1;
    const n = nav();
    await openHit(hit('login-a'), n);
    expect(contactsState.fetchContacts).not.toHaveBeenCalled();
    expect(n.openContact).toHaveBeenCalledWith('c1');
  });

  it('opens nothing once another account is shown while the contacts load', async () => {
    contactsState.fetchContacts.mockImplementation(async () => {
      contactsState.contacts = [{ id: 'c1', name: 'B card' }];
      contactsState.contactsGen = client.connectionGen;
      serve('login-b');
    });
    const n = nav();
    const result = await openHit(hit('login-a'), n);
    expect(result).toEqual({ opened: false, message: SWITCH_BACK });
    expect(n.openContact).not.toHaveBeenCalled();
  });

  it('says the contact is gone when the loaded book lacks it', async () => {
    const n = nav();
    expect(await openHit(hit('login-a'), n)).toEqual({ opened: false, message: 'Contact not found' });
  });
});

describe('openHit: calendar and files', () => {
  const eventHit = (jmapAccountId: string, source: 'local' | 'remote' = 'remote'): CalendarHit => ({
    kind: 'calendar', appAccountId: 'login-b', jmapAccountId, id: 'e1', accountLabel: '', title: 'Standup',
    subtitle: '', date: '2026-10-07T09:00:00', source, isRecurring: false,
    event: { id: source === 'local' ? 'store-e1' : 'e1', start: '2026-10-07T09:00:00' } as never,
  });

  it("parks B's event for the Calendar tab after switching to B", async () => {
    const n = nav();
    expect(await openHit(eventHit('jb'), n)).toEqual({ opened: true });
    expect(usePendingCalendarOpen.getState().target).toEqual(expect.objectContaining({
      kind: 'event', eventId: 'e1', serverId: 'e1', accountId: undefined, appAccountId: 'login-b',
    }));
    expect(n.openTab).toHaveBeenCalledWith('Calendar');
  });

  it("names a shared calendar's owner and the store's namespaced id", async () => {
    await openHit(eventHit('shared-1'), nav());
    expect(usePendingCalendarOpen.getState().target).toEqual(expect.objectContaining({
      eventId: 'shared-1:e1', serverId: 'e1', accountId: 'shared-1', appAccountId: 'login-b',
    }));
  });

  it('keeps the store id of a hit from the loaded calendar', async () => {
    await openHit(eventHit('jb', 'local'), nav());
    expect(usePendingCalendarOpen.getState().target?.eventId).toBe('store-e1');
  });

  it('parks nothing when the switch did not land', async () => {
    switchAccount.mockImplementation(async () => {});
    const n = nav();
    expect(await openHit(eventHit('jb'), n)).toEqual({ opened: false, message: SWITCH_BACK });
    expect(usePendingCalendarOpen.getState().target).toBeNull();
    expect(n.openTab).not.toHaveBeenCalled();
  });

  it("parks B's file with its folder for the Files tab", async () => {
    const hit: FileHit = {
      kind: 'files', appAccountId: 'login-b', jmapAccountId: 'jb', id: 'f1', accountLabel: '', title: 'a.txt',
      subtitle: '/Docs', date: null, source: 'remote', folderPath: '/Docs', isFolder: false,
      node: { id: 'f1', name: 'a.txt', parentId: 'd1' } as never,
    };
    const n = nav();
    expect(await openHit(hit, n)).toEqual({ opened: true });
    expect(usePendingFilesOpen.getState().target).toEqual({
      appAccountId: 'login-b', nodeId: 'f1', folderPath: '/Docs', fileName: 'a.txt',
    });
    expect(n.openTab).toHaveBeenCalledWith('Files');
  });
});
