import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Report phishing (webmail lib/phishing-report.ts, 50f95f446): one report
// per message to the organisation's address, no copy in Sent.

vi.mock('../jmap-client', () => ({
  jmapClient: {
    accountId: 'own',
    username: 'usera@example.org',
    request: vi.fn(),
    getMaxSizeUpload: vi.fn(() => 0),
    getMaxObjectsInGet: vi.fn(() => 500),
    getMaxCallsInRequest: vi.fn(() => 16),
  },
}));
vi.mock('../blob', () => ({ uploadBytes: vi.fn(async () => ({ blobId: 'arf-blob' })) }));
vi.mock('../../lib/email-export', () => ({
  fetchBlobBytes: vi.fn(async () => new TextEncoder().encode('From: x@evil.example\r\nSubject: Win\r\n\r\nclick\r\n')),
}));

import { jmapClient } from '../jmap-client';
import { uploadBytes } from '../blob';
import { sendPhishingReport } from '../phishing-report';
import {
  arfReportBytes, buildArfParts, isReportable, phishingReportSetup, rawEncoding, reporterIdentity, reportSubject,
} from '../../lib/phishing-report';
import type { Email, Identity, Mailbox } from '../types';

const request = jmapClient.request as ReturnType<typeof vi.fn>;
const identities = [
  { id: 'i-star', name: '', email: '*@example.org', mayDelete: true },
  { id: 'i-alias', name: 'Alias', email: 'alias@example.org', mayDelete: true },
  { id: 'i-own', name: 'User A', email: 'usera@example.org', mayDelete: true },
] as Identity[];
const mailboxes = [
  { id: 'inbox', name: 'Inbox', role: 'inbox' },
  { id: 'drafts', name: 'Drafts', role: 'drafts' },
  { id: 'sent', name: 'Sent', role: 'sent' },
] as Mailbox[];
const email = {
  id: 'e1', blobId: 'b1', subject: 'You won\r\n a prize', size: 120, receivedAt: '2026-11-10T10:00:00Z',
  from: [{ email: 'x@Evil.Example' }], to: [{ email: 'usera@example.org' }], keywords: {}, mailboxIds: { inbox: true },
} as unknown as Email;

function serverTakes() {
  request.mockImplementation(async (calls: [string, Record<string, any>, string][]) => ({
    methodResponses: calls.flatMap(([name, args, id]): unknown[][] => {
      if (name === 'Blob/copy') return [['Blob/copy', { copied: { [args.blobIds[0]]: 'copied-blob' } }, id]];
      if (name === 'EmailSubmission/set') {
        return [['EmailSubmission/set', { created: { sub: { id: 's1' } } }, id], ['Email/set', { destroyed: ['r1'] }, id]];
      }
      const created = name === 'Email/import' ? { report: { id: 'r1' } } : { report: { id: 'r1' } };
      return [[name, { created }, id]];
    }),
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  serverTakes();
});

describe('phishingReportSetup', () => {
  it('reads the address and format from the organisation part of the policy', () => {
    expect(phishingReportSetup({ organisation: { phishingReport: { address: ' soc@example.org ', format: 'arf' } } }))
      .toEqual({ address: 'soc@example.org', format: 'arf' });
    expect(phishingReportSetup({ organisation: { phishingReport: { address: 'soc@example.org' } } }))
      .toEqual({ address: 'soc@example.org', format: 'forward' });
    expect(phishingReportSetup({ organisation: { phishingReport: { address: '' } } })).toBeNull();
    expect(phishingReportSetup({ organisation: {} })).toBeNull();
    expect(phishingReportSetup(null)).toBeNull();
  });
});

describe('isReportable', () => {
  it('leaves out own mail, drafts and a message reported already', () => {
    expect(isReportable(email, 'inbox')).toBe(true);
    expect(isReportable(email, 'sent')).toBe(false);
    expect(isReportable(email, 'inbox', ['drafts'])).toBe(false);
    expect(isReportable({ ...email, keywords: { $draft: true } }, 'inbox')).toBe(false);
    expect(isReportable({ ...email, keywords: { $phishing: true } }, 'junk')).toBe(false);
    expect(isReportable({ ...email, blobId: '' }, 'inbox')).toBe(false);
  });

  it("picks the login's own identity, never a catch-all", () => {
    expect(reporterIdentity(identities, 'USERA@example.org')?.id).toBe('i-own');
    expect(reporterIdentity(identities.slice(0, 2), 'usera@example.org')?.id).toBe('i-alias');
    expect(reportSubject(' Hi\r\nthere ')).toBe('Phishing: Hi there');
    expect(reportSubject('')).toBe('Phishing');
  });
});

describe('sendPhishingReport', () => {
  it('forwards the original as an attachment by its blob from Drafts and destroys the copy once sent', async () => {
    await sendPhishingReport(email, { setup: { address: 'soc@example.org', format: 'forward' }, identities, mailboxes });

    expect(request).toHaveBeenCalledTimes(1);
    const [[create, submission]] = request.mock.calls[0];
    expect(create[0]).toBe('Email/set');
    const report = create[1].create.report;
    expect(report.mailboxIds).toEqual({ drafts: true });
    expect(report.to).toEqual([{ email: 'soc@example.org' }]);
    expect(report.from).toEqual([{ name: 'User A', email: 'usera@example.org' }]);
    expect(report.subject).toBe('Phishing: You won  a prize');
    expect(report.attachments).toEqual([{ blobId: 'b1', type: 'message/rfc822', name: 'You won a prize.eml', disposition: 'attachment' }]);
    expect(submission[0]).toBe('EmailSubmission/set');
    expect(submission[1].create.sub).toMatchObject({ emailId: '#report', identityId: 'i-own' });
    expect(submission[1].create.sub.envelope.rcptTo).toEqual([{ email: 'soc@example.org' }]);
    expect(submission[1].onSuccessDestroyEmail).toEqual(['#sub']);
    // No Sent copy: nothing files it there.
    expect(JSON.stringify(request.mock.calls)).not.toMatch(/"sent"/);
  });

  it("copies a shared account's message to the own account before attaching it", async () => {
    await sendPhishingReport(email, { setup: { address: 'soc@example.org', format: 'forward' }, sourceAccountId: 'team', identities, mailboxes });
    const [[copy]] = request.mock.calls[0];
    expect(copy).toEqual(['Blob/copy', { fromAccountId: 'team', accountId: 'own', blobIds: ['b1'] }, '0']);
    const [[create]] = request.mock.calls[1];
    expect(create[1].create.report.attachments[0].blobId).toBe('copied-blob');
  });

  it('wraps the original in an RFC 5965 report and imports it for the ARF format', async () => {
    await sendPhishingReport(email, { setup: { address: 'soc@example.org', format: 'arf' }, identities, mailboxes, appVersion: '1.2.3' });
    const bytes = (uploadBytes as ReturnType<typeof vi.fn>).mock.calls[0][0] as Uint8Array;
    const raw = new TextDecoder().decode(bytes);
    expect(raw).toMatch(/^Date: .+\r\nFrom: User A <usera@example\.org>\r\nTo: soc@example\.org\r\nSubject: Phishing: You won {2}a prize\r\n/);
    expect(raw).toMatch(/Content-Type: multipart\/report; report-type=feedback-report;/);
    expect(raw).toMatch(/Feedback-Type: fraud\r\nUser-Agent: Bulwark\/1\.2\.3\r\nVersion: 1\r\nArrival-Date: .+\r\nOriginal-Rcpt-To: usera@example\.org\r\nReported-Domain: evil\.example/);
    expect(raw).toMatch(/Content-Transfer-Encoding: 7bit\r\n\r\nFrom: x@evil\.example\r\nSubject: Win\r\n\r\nclick\r\n--/);
    const [[create, submission]] = request.mock.calls[0];
    expect(create).toEqual(['Email/import', {
      accountId: 'own',
      emails: { report: { blobId: 'arf-blob', mailboxIds: { drafts: true }, keywords: { $draft: true, $seen: true } } },
    }, '0']);
    expect(submission[1].onSuccessDestroyEmail).toEqual(['#sub']);
  });

  it('throws and removes the copy when the server refuses the submission', async () => {
    request.mockImplementationOnce(async () => ({
      methodResponses: [
        ['Email/set', { created: { report: { id: 'r9' } } }, '0'],
        ['EmailSubmission/set', { notCreated: { sub: { type: 'forbiddenToSend', description: 'Not allowed' } } }, '1'],
      ],
    }));
    await expect(sendPhishingReport(email, { setup: { address: 'soc@example.org', format: 'forward' }, identities, mailboxes }))
      .rejects.toThrow('Not allowed');
    expect(request.mock.calls[1][0]).toEqual([['Email/set', { accountId: 'own', destroy: ['r9'] }, '0']]);
  });
});

describe('reader', () => {
  it('offers Report phishing in the More sheet only with a report address, and reports through the store', () => {
    const screen = fs.readFileSync(path.resolve(__dirname, '../../screens/EmailThreadScreen.tsx'), 'utf8');
    expect(screen).toMatch(/const phishingSetup = React\.useMemo\(\(\) => phishingReportSetup\(policy\), \[policy\]\);/);
    expect(screen).toMatch(/onReportPhishing=\{canReportPhishing \? onReportPhishing : undefined\}/);
    expect(screen).toMatch(/\{onReportPhishing && \(\r?\n\s*<MoreMenuItem/);
    expect(screen).toMatch(/reportEmailAsPhishing\(target, ownerAccountId, setup, t\)/);
    const flow = fs.readFileSync(path.resolve(__dirname, '../../lib/phishing-report-flow.ts'), 'utf8');
    expect(flow).toMatch(/markSpam\(\[email\.id\], \{ email, accountId \}, \{\r?\n\s*keywords: \[PHISHING_KEYWORD\],\r?\n\s*markRead: true,/);
  });
});

describe('ARF helpers', () => {
  it('tells 7bit, 8bit and binary apart and puts the original between head and tail', () => {
    const enc = new TextEncoder();
    expect(rawEncoding(enc.encode('a\r\nb\r\n'))).toBe('7bit');
    expect(rawEncoding(enc.encode('ä\r\n'))).toBe('8bit');
    expect(rawEncoding(enc.encode('a\nb'))).toBe('binary');
    const parts = buildArfParts({ email, reporter: { email: 'u@x.org' }, to: 'soc@x.org', encoding: '7bit' });
    const withBreak = new TextDecoder().decode(arfReportBytes(parts, enc.encode('X\r\n')));
    expect(withBreak.endsWith('X\r\n--' + parts.tail.slice(4))).toBe(true);
    const without = new TextDecoder().decode(arfReportBytes(parts, enc.encode('X')));
    expect(without.endsWith('X' + parts.tail)).toBe(true);
  });
});
