import { describe, it, expect, vi, beforeEach } from 'vitest';

// The report flow (#124): one report per message, and only the messages
// whose report went out move to Junk; a failed one stays where it is, and
// nothing starts offline (the webmail's lib/phishing-report-flow.ts).

vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '0.1.95' } } }));
vi.mock('../../api/jmap-client', () => ({ jmapClient: { accountId: 'acc-own' } }));
vi.mock('../../api/phishing-report', () => ({
  getReportOriginals: vi.fn(async (ids: string[]) => new Map(ids.map((id) => [id, { id, blobId: `b-${id}`, size: 10, subject: id }]))),
  sendPhishingReport: vi.fn(async () => undefined),
}));
vi.mock('../../stores/locale-store', () => ({
  t: (_key: string, fallback?: string) => fallback ?? _key,
}));
vi.mock('../../stores/policy-store', () => ({ usePolicyStore: vi.fn() }));
const fileReported = vi.fn(async (targets: Array<{ email: { id: string }; accountId?: string }>, _opts?: unknown) =>
  targets.map((target) => `${target.accountId ?? ''}:${target.email.id}`));
const auth = { activeAccountId: 'login-1' as string | null };
vi.mock('../../stores/auth-store', () => ({ useAuthStore: { getState: () => auth } }));
vi.mock('../../stores/email-store', () => ({
  useEmailStore: {
    getState: () => ({
      fileReported,
      mailboxes: [
        { id: 'in', role: 'inbox', isShared: false },
        { id: 'dr', role: 'drafts', isShared: false },
        { id: 'grp-1:dr', originalId: 'dr', role: 'drafts', isShared: true, accountId: 'grp-1' },
      ],
    }),
  },
}));
const network = { online: true };
vi.mock('../../stores/network-store', () => ({ useNetworkStore: { getState: () => network } }));

import { getReportOriginals, sendPhishingReport } from '../../api/phishing-report';
import { toast } from '../../stores/toast-store';
import { reportAsPhishing } from '../phishing-report-flow';
import { reportedKey, usePhishingReportStore } from '../../stores/phishing-report-store';
import type { Email } from '../../api/types';

const mockSend = sendPhishingReport as ReturnType<typeof vi.fn>;
const SETUP = { address: 'security@example.org', format: 'forward' as const };
const row = (id: string) => ({ id, subject: `Subject ${id}`, keywords: {}, mailboxIds: { in: true } }) as unknown as Email;

beforeEach(() => {
  vi.clearAllMocks();
  network.online = true;
  auth.activeAccountId = 'login-1';
  usePhishingReportStore.setState({ reported: {} });
});

describe('reportAsPhishing', () => {
  it('sends one report per message, staged in the own Drafts, then files them all with one Undo', async () => {
    const outcome = await reportAsPhishing([{ email: row('m1') }, { email: row('m2'), accountId: 'grp-1' }], SETUP);
    expect(getReportOriginals).toHaveBeenCalledWith(['m1'], 'acc-own');
    expect(getReportOriginals).toHaveBeenCalledWith(['m2'], 'grp-1');
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockSend.mock.calls[0][1]).toMatchObject({ sourceAccountId: 'acc-own', stagingMailboxId: 'dr', appVersion: '0.1.95' });
    expect(mockSend.mock.calls[1][1]).toMatchObject({ sourceAccountId: 'grp-1', stagingMailboxId: 'dr' });
    expect(fileReported).toHaveBeenCalledWith(
      [{ email: row('m1') }, { email: row('m2'), accountId: 'grp-1' }],
      expect.objectContaining({ keywords: ['$phishing'], markRead: true }),
    );
    expect(outcome).toMatchObject({ moved: 2, failed: [] });
    expect(usePhishingReportStore.getState().reported).toEqual({ ':m1': true, 'grp-1:m2': true });
  });

  it('leaves a message whose report failed where it is, and names it', async () => {
    mockSend.mockRejectedValueOnce(new Error('forbiddenFrom'));
    const error = vi.spyOn(toast, 'error');
    const outcome = await reportAsPhishing([{ email: row('m1') }, { email: row('m2') }], SETUP);
    expect(fileReported).toHaveBeenCalledWith([{ email: row('m2') }], expect.anything());
    expect(usePhishingReportStore.getState().reported).toEqual({ ':m2': true });
    expect(outcome.failed.map((target) => target.email.id)).toEqual(['m1']);
    expect(error).toHaveBeenCalledWith("The message couldn't be reported.", { message: 'Subject m1' });
    error.mockRestore();
  });

  it('moves nothing when every report failed', async () => {
    mockSend.mockRejectedValue(new Error('down'));
    await reportAsPhishing([{ email: row('m1') }], SETUP);
    expect(fileReported).not.toHaveBeenCalled();
    expect(usePhishingReportStore.getState().reported).toEqual({});
    mockSend.mockResolvedValue(undefined);
  });

  it('sends nothing and moves nothing offline', async () => {
    network.online = false;
    const outcome = await reportAsPhishing([{ email: row('m1') }], SETUP);
    expect(mockSend).not.toHaveBeenCalled();
    expect(fileReported).not.toHaveBeenCalled();
    expect(outcome.failed).toHaveLength(1);
  });

  it('counts a message reported when the move failed: no second report, links off', async () => {
    fileReported.mockResolvedValueOnce([':m1']);
    const warning = vi.spyOn(toast, 'warning');
    const outcome = await reportAsPhishing([{ email: row('m1') }, { email: row('m2') }], SETUP);
    expect(outcome.moved).toBe(1);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(usePhishingReportStore.getState().reported[reportedKey('m1')]).toBe(true);
    expect(usePhishingReportStore.getState().reported[reportedKey('m2')]).toBe(true);
    warning.mockRestore();
  });

  it('clears on Undo only the marks of the messages it moved back, and says the report already went', async () => {
    fileReported.mockResolvedValueOnce([':m1']);
    const info = vi.spyOn(toast, 'info');
    await reportAsPhishing([{ email: row('m1') }, { email: row('m2') }], SETUP);
    const opts = (fileReported.mock.calls[0] as unknown as [unknown, { afterUndo: () => void }])[1];
    opts.afterUndo();
    // m2's move was refused: it has no $phishing on the server, so it stays reported here.
    expect(usePhishingReportStore.getState().reported).toEqual({ ':m2': true });
    expect(info).toHaveBeenCalledWith('Moved back. The report was already sent.');
    info.mockRestore();
  });

  it('stops when another login is opened meanwhile: the rest count as failed, nothing is filed', async () => {
    mockSend.mockImplementationOnce(async () => { auth.activeAccountId = 'login-2'; });
    const outcome = await reportAsPhishing([{ email: row('m1') }, { email: row('m2') }], SETUP);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(outcome.reported.map((target) => target.email.id)).toEqual(['m1']);
    expect(outcome.failed.map((target) => target.email.id)).toEqual(['m2']);
    expect(fileReported).not.toHaveBeenCalled();
    expect(usePhishingReportStore.getState().reported).toEqual({ ':m1': true });
  });
});
