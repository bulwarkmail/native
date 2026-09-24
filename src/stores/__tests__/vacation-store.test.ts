import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../api/vacation', () => ({
  getVacationResponse: vi.fn(),
  setVacationResponse: vi.fn(async () => undefined),
  isVacationSupported: vi.fn(() => true),
}));

import * as vacation from '../../api/vacation';
import { useVacationStore } from '../vacation-store';

const api = vi.mocked(vacation);

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
