import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../api/vacation', () => ({
  getVacationResponse: vi.fn(),
  setVacationResponse: vi.fn(async () => undefined),
  isVacationSupported: vi.fn(() => true),
}));

vi.mock('../../api/jmap-client', () => ({
  jmapClient: { connectionGen: 1, accountId: 'own', isCurrent: (gen: number) => gen === 1 },
}));

vi.mock('../../api/sieve', () => ({
  isSieveSupported: vi.fn(() => false),
  sieveScopeIn: (at: { gen: number }, id?: string) => ({ gen: at.gen, accountId: id ?? 'own-sieve' }),
}));

vi.mock('../filter-store', () => ({
  readVacationFilters: vi.fn(async () => FILTERS),
  checkVacationSync: vi.fn(async () => ({ opaque: false })),
  syncVacationWithFilters: vi.fn(async () => undefined),
}));

vi.mock('../email-store', async () => {
  const { inAccount, opScope } = await import('../../api/op-scope');
  return {
    useEmailStore: { getState: () => ({ activeAccountId: 'login' }) },
    isShownAccount: (id: string | null | undefined) => id === 'login',
    requireShownAccountScope: (id: string | null | undefined, jmapAccountId?: string) => {
      if (id !== 'login') throw new Error('switched');
      return inAccount(opScope(), jmapAccountId);
    },
  };
});

const FILTERS = vi.hoisted(() => ({
  includesVacation: false,
  forward: null,
  forwardAvailable: false,
  audience: null,
  audienceAvailable: false,
  notRunning: false,
  otherForwards: 0,
  filtersStopped: false,
  includeAvailable: true,
}));

import * as vacation from '../../api/vacation';
import * as sieve from '../../api/sieve';
import * as filters from '../filter-store';
import { useVacationStore, VacationFiltersError } from '../vacation-store';

/** The scope every request of the store carries: the account on connection 1. */
const scope = (accountId: string) => ({ gen: 1, accountId });

const api = vi.mocked(vacation);
const sieveApi = vi.mocked(sieve);
const filterStore = vi.mocked(filters);

function responder(overrides: Partial<vacation.VacationResponse> = {}): vacation.VacationResponse {
  return {
    id: 'singleton',
    isEnabled: false,
    fromDate: null,
    toDate: null,
    subject: '',
    textBody: '',
    htmlBody: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.isVacationSupported.mockReturnValue(true);
  sieveApi.isSieveSupported.mockReturnValue(false);
  filterStore.readVacationFilters.mockResolvedValue(FILTERS);
  useVacationStore.getState().reset();
});

describe('vacation-store account scoping', () => {
  it('loads and saves the own responder by default', async () => {
    api.getVacationResponse.mockResolvedValue(responder({ isEnabled: true, subject: 'Away' }));
    await useVacationStore.getState().fetch();
    expect(api.getVacationResponse).toHaveBeenCalledWith(scope('own'));
    expect(useVacationStore.getState()).toMatchObject({
      appAccountId: 'login', accountId: null, isEnabled: true, subject: 'Away',
    });

    await useVacationStore.getState().save({ isEnabled: false });
    expect(api.setVacationResponse).toHaveBeenCalledWith({ isEnabled: false }, scope('own'));
  });

  it('loads and saves a shared account\'s responder', async () => {
    api.getVacationResponse.mockResolvedValue(responder({ subject: 'Team away' }));
    await useVacationStore.getState().fetch('team');
    expect(api.isVacationSupported).toHaveBeenCalledWith('team');
    expect(api.getVacationResponse).toHaveBeenCalledWith(scope('team'));
    expect(useVacationStore.getState()).toMatchObject({ accountId: 'team', subject: 'Team away' });

    await useVacationStore.getState().save({ subject: 'Closed' });
    expect(api.setVacationResponse).toHaveBeenCalledWith({ subject: 'Closed' }, scope('team'));
  });

  it('does not show the previous account\'s responder while another one loads', async () => {
    api.getVacationResponse.mockResolvedValueOnce(responder({ isEnabled: true, subject: 'Mine' }));
    await useVacationStore.getState().fetch();

    api.getVacationResponse.mockReturnValueOnce(new Promise(() => {}));
    void useVacationStore.getState().fetch('team');

    expect(useVacationStore.getState()).toMatchObject({
      accountId: 'team', isEnabled: false, subject: '', hasLoaded: false, isLoading: true,
    });
  });

  it('ignores a reply for an account the user already switched away from', async () => {
    let releaseTeam: (v: vacation.VacationResponse) => void = () => {};
    api.getVacationResponse.mockImplementation((account?: unknown) =>
      (account as { accountId?: string } | undefined)?.accountId === 'team'
        ? new Promise((r) => { releaseTeam = r; })
        : Promise.resolve(responder({ subject: 'Mine' })));

    const teamLoad = useVacationStore.getState().fetch('team');
    await useVacationStore.getState().fetch();
    releaseTeam(responder({ subject: 'Team away' }));
    await teamLoad;

    expect(useVacationStore.getState()).toMatchObject({ accountId: null, subject: 'Mine' });
  });
});

describe('vacation-store and the filters script (webmail 198a3c0d)', () => {
  it('reports the auto-reply as on while the filters script includes it', async () => {
    sieveApi.isSieveSupported.mockReturnValue(true);
    filterStore.readVacationFilters.mockResolvedValue({ ...FILTERS, includesVacation: true });
    api.getVacationResponse.mockResolvedValue(responder({ isEnabled: false, subject: 'Away' }));

    await useVacationStore.getState().fetch('team');

    expect(filterStore.readVacationFilters).toHaveBeenCalledWith('team', scope('team'));
    expect(useVacationStore.getState()).toMatchObject({ isEnabled: true, subject: 'Away' });
  });

  it('keeps the filters running next to the auto-reply when it is switched', async () => {
    sieveApi.isSieveSupported.mockReturnValue(true);
    api.getVacationResponse.mockResolvedValue(responder());
    await useVacationStore.getState().fetch();

    await useVacationStore.getState().save({ isEnabled: true });
    expect(filterStore.syncVacationWithFilters).toHaveBeenCalledWith(
      { enabled: true, forward: undefined, audience: undefined, period: { from: null, until: null } },
      scope('own-sieve'),
    );
    // Checked first, on the same connection, before anything is written.
    expect(filterStore.checkVacationSync.mock.invocationCallOrder[0])
      .toBeLessThan(api.setVacationResponse.mock.invocationCallOrder[0]);
    expect(filterStore.checkVacationSync.mock.calls[0][1]).toEqual(scope('own-sieve'));

    await useVacationStore.getState().save({ subject: 'Only the subject' });
    expect(filterStore.syncVacationWithFilters).toHaveBeenCalledTimes(1);
  });

  it('saves the responder and says so when only keeping the filters running fails', async () => {
    sieveApi.isSieveSupported.mockReturnValue(true);
    await useVacationStore.getState().fetch();
    filterStore.syncVacationWithFilters.mockRejectedValueOnce(new Error('boom'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(useVacationStore.getState().save({ isEnabled: true })).rejects.toBeInstanceOf(VacationFiltersError);
    expect(api.setVacationResponse).toHaveBeenCalledTimes(1);
    expect(useVacationStore.getState()).toMatchObject({ isEnabled: true, isSaving: false, error: null });
    warn.mockRestore();
  });

  it('writes nothing when the filters part is refused up front', async () => {
    sieveApi.isSieveSupported.mockReturnValue(true);
    await useVacationStore.getState().fetch();
    filterStore.checkVacationSync.mockRejectedValueOnce(new Error('hand-edited'));
    await expect(useVacationStore.getState().save({ isEnabled: true })).rejects.toThrow('hand-edited');
    expect(api.setVacationResponse).not.toHaveBeenCalled();
    expect(useVacationStore.getState()).toMatchObject({ isEnabled: false, isSaving: false });
  });

  it('leaves the filters alone on servers without Sieve', async () => {
    await useVacationStore.getState().fetch();
    await useVacationStore.getState().save({ isEnabled: true });
    expect(filterStore.syncVacationWithFilters).not.toHaveBeenCalled();
    expect(filterStore.checkVacationSync).not.toHaveBeenCalled();
  });
});
