import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../api/vacation', () => ({
  getVacationResponse: vi.fn(),
  setVacationResponse: vi.fn(async () => undefined),
  isVacationSupported: vi.fn(() => true),
}));

vi.mock('../../api/sieve', () => ({ isSieveSupported: vi.fn(() => false) }));

vi.mock('../filter-store', () => ({
  isVacationIncludedInFilters: vi.fn(async () => false),
  syncVacationWithFilters: vi.fn(async () => undefined),
}));

import * as vacation from '../../api/vacation';
import * as sieve from '../../api/sieve';
import * as filters from '../filter-store';
import { useVacationStore } from '../vacation-store';

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
  filterStore.isVacationIncludedInFilters.mockResolvedValue(false);
  useVacationStore.getState().reset();
});

describe('vacation-store account scoping', () => {
  it('loads and saves the own responder by default', async () => {
    api.getVacationResponse.mockResolvedValue(responder({ isEnabled: true, subject: 'Away' }));
    await useVacationStore.getState().fetch();
    expect(api.getVacationResponse).toHaveBeenCalledWith(undefined);
    expect(useVacationStore.getState()).toMatchObject({ accountId: null, isEnabled: true, subject: 'Away' });

    await useVacationStore.getState().save({ isEnabled: false });
    expect(api.setVacationResponse).toHaveBeenCalledWith({ isEnabled: false }, undefined);
  });

  it('loads and saves a shared account\'s responder', async () => {
    api.getVacationResponse.mockResolvedValue(responder({ subject: 'Team away' }));
    await useVacationStore.getState().fetch('team');
    expect(api.isVacationSupported).toHaveBeenCalledWith('team');
    expect(api.getVacationResponse).toHaveBeenCalledWith('team');
    expect(useVacationStore.getState()).toMatchObject({ accountId: 'team', subject: 'Team away' });

    await useVacationStore.getState().save({ subject: 'Closed' });
    expect(api.setVacationResponse).toHaveBeenCalledWith({ subject: 'Closed' }, 'team');
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
    api.getVacationResponse.mockImplementation((accountId?: string) =>
      accountId === 'team'
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
    filterStore.isVacationIncludedInFilters.mockResolvedValue(true);
    api.getVacationResponse.mockResolvedValue(responder({ isEnabled: false, subject: 'Away' }));

    await useVacationStore.getState().fetch('team');

    expect(filterStore.isVacationIncludedInFilters).toHaveBeenCalledWith('team');
    expect(useVacationStore.getState()).toMatchObject({ isEnabled: true, subject: 'Away' });
  });

  it('keeps the filters running next to the auto-reply when it is switched', async () => {
    sieveApi.isSieveSupported.mockReturnValue(true);
    api.getVacationResponse.mockResolvedValue(responder());
    await useVacationStore.getState().fetch();

    await useVacationStore.getState().save({ isEnabled: true });
    expect(filterStore.syncVacationWithFilters).toHaveBeenCalledWith(true, undefined);

    await useVacationStore.getState().save({ subject: 'Only the subject' });
    expect(filterStore.syncVacationWithFilters).toHaveBeenCalledTimes(1);
  });

  it('still saves the responder when keeping the filters running fails', async () => {
    sieveApi.isSieveSupported.mockReturnValue(true);
    filterStore.syncVacationWithFilters.mockRejectedValueOnce(new Error('boom'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(useVacationStore.getState().save({ isEnabled: false })).resolves.toBeUndefined();
    expect(useVacationStore.getState()).toMatchObject({ isEnabled: false, isSaving: false, error: null });
    warn.mockRestore();
  });

  it('leaves the filters alone on servers without Sieve', async () => {
    await useVacationStore.getState().save({ isEnabled: true });
    expect(filterStore.syncVacationWithFilters).not.toHaveBeenCalled();
  });
});
