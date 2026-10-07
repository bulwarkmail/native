import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContactCard } from '../../../api/types';
import type { ContactHit } from '../types';

// ---------------------------------------------------------------------------
// The real contacts store under an account switch. Account A's full card load
// is in flight when the app switches to B (the store is reset, a new
// connection replaces A's); both accounts have a card "c1" (Stalwart numbers
// ids per account). A's late answer must never land in B's store, and a
// search hit for B's "c1" must open B's card, or say it is gone - never A's.
// ---------------------------------------------------------------------------

const client = vi.hoisted(() => ({
  connectionGen: 1, accountId: 'ja', isConnected: true, username: 'a', serverUrl: 'https://a.test',
  served: 'login-a' as string | null,
}));
const emailState = vi.hoisted(() => ({ activeAccountId: 'login-a' as string | null }));

vi.mock('../../../api/contacts', () => ({
  getAddressBooks: vi.fn(async () => []),
  getAllAddressBooks: vi.fn(async () => []),
  queryContacts: vi.fn(),
  getContacts: vi.fn(),
  getAllContacts: vi.fn(),
  createContact: vi.fn(),
  updateContact: vi.fn(),
  deleteContacts: vi.fn(),
  createAddressBook: vi.fn(),
  updateAddressBook: vi.fn(),
  deleteAddressBook: vi.fn(),
  setDefaultAddressBook: vi.fn(),
  getContactsInBook: vi.fn(),
  getContactsAccountId: () => client.accountId,
  getContactCapableAccountIds: () => [client.accountId],
  namespaceId: (accountId: string, id: string) => `${accountId}:${id}`,
  stripClientFields: (c: Record<string, unknown>) => c,
}));
vi.mock('../../../api/recent-recipients', () => ({ queryRecentRecipients: vi.fn(), searchSentRecipients: vi.fn() }));
vi.mock('../../../api/principals', () => ({ getPrincipals: vi.fn() }));
vi.mock('../../../api/jmap-client', () => ({ jmapClient: client }));
vi.mock('../../../stores/account-store', () => ({
  useAccountStore: { getState: () => ({ activeAccountId: emailState.activeAccountId, getAccountById: () => undefined }) },
}));
vi.mock('../../../lib/active-client-account', () => ({
  clientServesAccount: (id: string | null | undefined) => !!id && id === client.served,
  clientServesActiveAccount: () => client.served === emailState.activeAccountId,
  activeAppAccountId: () => emailState.activeAccountId,
}));
vi.mock('../../../stores/email-store', () => ({
  isShownAccount: (id: string | null | undefined) => !!id && id === emailState.activeAccountId,
  requireShownAccountScope: (id: string | null | undefined, jmapAccountId?: string) => {
    if (!id || id !== emailState.activeAccountId || client.served !== id) throw new Error('switch back');
    return { gen: client.connectionGen, accountId: jmapAccountId ?? client.accountId };
  },
}));
vi.mock('../../../stores/auth-store', () => ({
  useAuthStore: { getState: () => ({ switchAccount: vi.fn(async () => {}) }) },
}));
vi.mock('../../../stores/locale-store', () => ({
  useLocaleStore: { getState: () => ({ t: (_key: string, fallback: string) => fallback }) },
}));
vi.mock('../../../api/email', () => ({ getEmails: vi.fn() }));
vi.mock('../../email-detail-cache', () => ({ prefetchMessage: vi.fn() }));

const contactsApi = await import('../../../api/contacts');
const { useContactsStore } = await import('../../../stores/contacts-store');
const { openHit } = await import('../open-hit');
const getAllContacts = contactsApi.getAllContacts as ReturnType<typeof vi.fn>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const cardOf = (owner: string): ContactCard => ({ id: 'c1', uid: owner, addressBookIds: {} }) as unknown as ContactCard;

/** The switch as auth-store runs it: shown account, store reset, then the new connection. */
function switchToB() {
  emailState.activeAccountId = 'login-b';
  useContactsStore.getState().reset();
  client.connectionGen = 2;
  client.accountId = 'jb';
  client.served = 'login-b';
}

const bHit: ContactHit = {
  kind: 'contacts', appAccountId: 'login-b', jmapAccountId: 'jb', id: 'c1', accountLabel: 'B', title: 'B',
  subtitle: '', date: null, source: 'remote', contact: { id: 'c1' } as never, storeId: 'c1',
};

const nav = () => ({ openThread: vi.fn(), openContact: vi.fn(), openTab: vi.fn(), active: () => true });

beforeEach(() => {
  getAllContacts.mockReset();
  client.connectionGen = 1;
  client.accountId = 'ja';
  client.served = 'login-a';
  emailState.activeAccountId = 'login-a';
  useContactsStore.getState().reset();
});

describe("a contacts load the switch overtook", () => {
  it("never writes A's cards into B's store", async () => {
    const a = deferred<ContactCard[]>();
    getAllContacts.mockReturnValueOnce(a.promise);
    const aLoad = useContactsStore.getState().fetchContacts();
    switchToB();
    a.resolve([cardOf('A')]);
    await aLoad;
    expect(useContactsStore.getState().contacts).toEqual([]);
    expect(useContactsStore.getState().contactsGen).toBeNull();
    expect(useContactsStore.getState().loading).toBe(false);
  });

  it("is not joined by B's load, and B's hit opens B's card even when A answers last", async () => {
    const a = deferred<ContactCard[]>();
    const b = deferred<ContactCard[]>();
    getAllContacts.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const aLoad = useContactsStore.getState().fetchContacts();
    switchToB();
    const n = nav();
    const opening = openHit(bHit, n);
    // B's own load went out instead of waiting on A's.
    await vi.waitFor(() => expect(getAllContacts).toHaveBeenCalledTimes(2));
    b.resolve([cardOf('B')]);
    a.resolve([cardOf('A')]);
    await aLoad;
    expect(await opening).toEqual({ opened: true });
    expect(n.openContact).toHaveBeenCalledWith('c1');
    expect(useContactsStore.getState().contacts.map((c) => c.uid)).toEqual(['B']);
  });

  it("says the contact is gone when B lacks it, though A's late answer had one", async () => {
    const a = deferred<ContactCard[]>();
    getAllContacts.mockReturnValueOnce(a.promise).mockResolvedValueOnce([]);
    const aLoad = useContactsStore.getState().fetchContacts();
    switchToB();
    a.resolve([cardOf('A')]);
    await aLoad;
    const n = nav();
    expect(await openHit(bHit, n)).toEqual({ opened: false, message: 'Contact not found' });
    expect(n.openContact).not.toHaveBeenCalled();
  });

  it('does not take persisted cards for the account on screen', async () => {
    // Hydrated from the cache: no connection read them.
    useContactsStore.setState({ contacts: [cardOf('A')], contactsGen: null });
    switchToB();
    useContactsStore.setState({ contacts: [cardOf('A')], contactsGen: null });
    getAllContacts.mockResolvedValueOnce([cardOf('B')]);
    const n = nav();
    expect(await openHit(bHit, n)).toEqual({ opened: true });
    expect(getAllContacts).toHaveBeenCalledTimes(1);
    expect(useContactsStore.getState().contacts.map((c) => c.uid)).toEqual(['B']);
  });
});
