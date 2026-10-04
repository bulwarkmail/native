import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../jmap-client', () => ({
  jmapClient: {
    accountId: 'acc-1',
    request: vi.fn(),
    updatePassword: vi.fn(),
  },
}));

import { jmapClient } from '../jmap-client';
import { changePassword, disableTotp } from '../account-security';

const mockRequest = jmapClient.request as ReturnType<typeof vi.fn>;
const mockUpdatePassword = jmapClient.updatePassword as ReturnType<typeof vi.fn>;

const USING = ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'];

function singletonUpdate(): Record<string, unknown> {
  const [calls] = mockRequest.mock.calls[0];
  expect(calls[0][0]).toBe('x:AccountPassword/set');
  return calls[0][1].update.singleton;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequest.mockResolvedValue({ methodResponses: [['x:AccountPassword/set', {}, '0']] });
});

describe('changePassword', () => {
  it('sends only the current and new password without a code', async () => {
    await changePassword('old', 'new-password');
    expect(mockRequest).toHaveBeenCalledWith(
      [['x:AccountPassword/set', { accountId: 'acc-1', update: { singleton: { currentSecret: 'old', secret: 'new-password' } } }, '0']],
      USING,
    );
    expect(mockUpdatePassword).toHaveBeenCalledWith('new-password');
  });

  it('adds the trimmed code as the otpAuth/otpCode pointer, never a whole otpAuth object', async () => {
    await changePassword('old', 'new-password', ' 123456 ');
    expect(singletonUpdate()).toEqual({ currentSecret: 'old', secret: 'new-password', 'otpAuth/otpCode': '123456' });
  });

  it('treats a whitespace-only code as none', async () => {
    await changePassword('old', 'new-password', '   ');
    expect(singletonUpdate()).toEqual({ currentSecret: 'old', secret: 'new-password' });
  });

  it('does not update the stored credential when the server refuses', async () => {
    mockRequest.mockResolvedValue({
      methodResponses: [['x:AccountPassword/set', { notUpdated: { singleton: { type: 'invalidProperties', description: 'Bad code' } } }, '0']],
    });
    await expect(changePassword('old', 'new-password', '000000')).rejects.toThrow('Bad code');
    expect(mockUpdatePassword).not.toHaveBeenCalled();
  });
});

describe('disableTotp', () => {
  it('sends otpUrl null without a code', async () => {
    await disableTotp('pw');
    expect(singletonUpdate()).toEqual({ currentSecret: 'pw', otpAuth: { otpUrl: null } });
  });

  it('sends the trimmed code alongside otpUrl null', async () => {
    await disableTotp('pw', ' 654321 ');
    expect(singletonUpdate()).toEqual({ currentSecret: 'pw', otpAuth: { otpUrl: null, otpCode: '654321' } });
  });

  it('treats a whitespace-only code as none', async () => {
    await disableTotp('pw', '  ');
    expect(singletonUpdate()).toEqual({ currentSecret: 'pw', otpAuth: { otpUrl: null } });
  });
});
