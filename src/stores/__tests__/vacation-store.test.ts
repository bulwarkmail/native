import { describe, it, expect, vi, beforeEach } from 'vitest';

const client = vi.hoisted(() => ({
  isConnected: true,
  username: 'me@example.org',
  serverUrl: 'https://mail.example.org',
}));
vi.mock('../../api/jmap-client', () => ({ jmapClient: client }));
const LOGIN = 'me@example.org@mail.example.org';

vi.mock('../../api/vacation', () => ({
  getVacationResponse: vi.fn(),
  setVacationResponse: vi.fn(async () => undefined),
  isVacationSupported: vi.fn(() => true),
}));

vi.mock('../../api/sieve', () => ({ isSieveSupported: vi.fn(() => false) }));

const NO_FILTERS = {
  includesVacation: false, forward: null, forwardAvailable: false,
  audience: null, audienceAvailable: false, notRunning: false,
};

vi.mock('../filter-store', () => ({
  readVacationFilters: vi.fn(async () => NO_FILTERS),
  syncVacationWithFilters: vi.fn(async () => undefined),
}));

import * as vacation from '../../api/vacation';
import * as sieve from '../../api/sieve';
import * as filters from '../filter-store';
import { useVacationStore, VacationFiltersError } from '../vacation-store';

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
  client.username = 'me@example.org';
  api.isVacationSupported.mockReturnValue(true);
  sieveApi.isSieveSupported.mockReturnValue(false);
  filterStore.readVacationFilters.mockResolvedValue(NO_FILTERS);
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
    filterStore.readVacationFilters.mockResolvedValue({ ...NO_FILTERS, includesVacation: true });
    api.getVacationResponse.mockResolvedValue(responder({ isEnabled: false, subject: 'Away' }));

    await useVacationStore.getState().fetch('team');

    expect(filterStore.readVacationFilters).toHaveBeenCalledWith('team');
    expect(useVacationStore.getState()).toMatchObject({ isEnabled: true, subject: 'Away' });
  });

  it('keeps the filters running next to the auto-reply when it is switched', async () => {
    sieveApi.isSieveSupported.mockReturnValue(true);
    api.getVacationResponse.mockResolvedValue(responder());
    await useVacationStore.getState().fetch();

    await useVacationStore.getState().save({ isEnabled: true });
    expect(filterStore.syncVacationWithFilters).toHaveBeenCalledWith(
      true, undefined, undefined, undefined, { from: null, until: null }, LOGIN,
    );

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

  // #1152: forwarding and who gets the reply live in the filters script.
  it('loads the stored forwarding and audience', async () => {
    sieveApi.isSieveSupported.mockReturnValue(true);
    const forward = { enabled: true, to: 'backup@example.org', keepCopy: false };
    const audience = { only: 'internal' as const, domains: ['example.org'] };
    filterStore.readVacationFilters.mockResolvedValue({
      ...NO_FILTERS, forward, forwardAvailable: true, audience, audienceAvailable: true,
    });
    api.getVacationResponse.mockResolvedValue(responder());

    await useVacationStore.getState().fetch();
    expect(useVacationStore.getState()).toMatchObject({
      forward, forwardAvailable: true, audience, audienceAvailable: true,
    });
  });

  it('saves forwarding and audience in the vacation period, not to the responder', async () => {
    sieveApi.isSieveSupported.mockReturnValue(true);
    api.getVacationResponse.mockResolvedValue(responder({ fromDate: '2026-11-02T08:00:00Z' }));
    await useVacationStore.getState().fetch();

    const forward = { enabled: true, to: 'backup@example.org', keepCopy: true };
    const audience = { only: 'external' as const, domains: ['example.org'] };
    await useVacationStore.getState().save({ toDate: '2026-11-14T00:00:00Z', forward, audience });
    expect(api.setVacationResponse).toHaveBeenCalledWith({ toDate: '2026-11-14T00:00:00Z' }, undefined);
    expect(filterStore.syncVacationWithFilters).toHaveBeenCalledWith(
      false, undefined, forward, audience, { from: '2026-11-02T08:00:00Z', until: '2026-11-14T00:00:00Z' }, LOGIN,
    );
  });

  // Turning the auto-reply on activates Stalwart's vacation script, which
  // switches the filters off until the filters script includes it.
  it('reports filters left off when the auto-reply was turned on', async () => {
    sieveApi.isSieveSupported.mockReturnValue(true);
    filterStore.syncVacationWithFilters.mockRejectedValueOnce(new Error('boom'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const saved = useVacationStore.getState().save({ isEnabled: true });
    await expect(saved).rejects.toBeInstanceOf(VacationFiltersError);
    await expect(saved).rejects.toMatchObject({ filtersOff: true });
    expect(api.setVacationResponse).toHaveBeenCalledWith({ isEnabled: true }, undefined);
    expect(useVacationStore.getState()).toMatchObject({ isEnabled: true, isSaving: false });
    warn.mockRestore();
  });

  it('leaves the filters alone once another login took over during the save', async () => {
    sieveApi.isSieveSupported.mockReturnValue(true);
    api.getVacationResponse.mockResolvedValue(responder());
    await useVacationStore.getState().fetch();
    filterStore.readVacationFilters.mockClear();
    api.setVacationResponse.mockImplementationOnce(async () => {
      client.username = 'other@example.org';
    });

    await expect(useVacationStore.getState().save({
      isEnabled: true, forward: { enabled: true, to: 'backup@example.org', keepCopy: false },
    })).rejects.toBeInstanceOf(VacationFiltersError);
    expect(filterStore.syncVacationWithFilters).not.toHaveBeenCalled();
    expect(filterStore.readVacationFilters).not.toHaveBeenCalled();
    // Nothing of this save shows under the other login.
    expect(useVacationStore.getState()).toMatchObject({ isEnabled: false, forward: null, isSaving: false });
  });

  it('reports a forwarding that could not be saved', async () => {
    sieveApi.isSieveSupported.mockReturnValue(true);
    filterStore.syncVacationWithFilters.mockRejectedValueOnce(new Error('boom'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(useVacationStore.getState().save({
      forward: { enabled: true, to: 'backup@example.org', keepCopy: false },
    })).rejects.toThrow('boom');
    expect(useVacationStore.getState().isSaving).toBe(false);
    warn.mockRestore();
  });

  it('leaves the filters alone on servers without Sieve', async () => {
    await useVacationStore.getState().save({ isEnabled: true });
    expect(filterStore.syncVacationWithFilters).not.toHaveBeenCalled();
  });
});
