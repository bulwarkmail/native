import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../push-notifications', () => ({
  DEFAULT_RELAY_BASE_URL: 'https://default.example',
  setStoredRelayBaseUrl: vi.fn(async () => undefined),
}));

import { setStoredRelayBaseUrl } from '../push-notifications';
import { resetPushRelay } from '../push-relay-reset';

describe('resetPushRelay', () => {
  beforeEach(() => vi.clearAllMocks());

  it('re-registers on the default relay when push is on', async () => {
    const reregister = vi.fn(async () => undefined);
    await resetPushRelay('a@x', true, reregister);
    expect(reregister).toHaveBeenCalledWith('https://default.example');
    expect(setStoredRelayBaseUrl).not.toHaveBeenCalled();
  });

  it('only clears the stored relay when push is off', async () => {
    const reregister = vi.fn(async () => undefined);
    await resetPushRelay('a@x', false, reregister);
    expect(reregister).not.toHaveBeenCalled();
    expect(setStoredRelayBaseUrl).toHaveBeenCalledWith(null, 'a@x');
  });
});
