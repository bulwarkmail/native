import { describe, expect, it } from 'vitest';
import type { Email, Identity } from '../../api/types';
import {
  PHISHING_KEYWORD, folderRolesOf, isReportable, phishingReportSetup, reportSubject, reportText, reporterIdentity, reportableOf,
} from '../phishing-report';


// "Report phishing" (#124), the webmail's lib/phishing-report.ts: the
// admin's setup from the policy, which messages can be reported, and what
// the report says.

describe('phishingReportSetup', () => {
  it('is off without an organisation section or an address', () => {
    expect(phishingReportSetup(null)).toBeNull();
    expect(phishingReportSetup({ organisation: {} })).toBeNull();
    expect(phishingReportSetup({ organisation: { phishingReport: { address: '', format: 'arf' } } })).toBeNull();
    expect(phishingReportSetup({ organisation: { phishingReport: { address: '   ' } } })).toBeNull();
  });

  it('reads the address and the format, forward unless ARF', () => {
    expect(phishingReportSetup({ organisation: { phishingReport: { address: ' Security@Example.org ', format: 'arf' } } }))
      .toEqual({ address: 'security@example.org', format: 'arf' });
    expect(phishingReportSetup({ organisation: { phishingReport: { address: 'security@example.org', format: 'zip' } } }))
      .toEqual({ address: 'security@example.org', format: 'forward' });
  });

  it('refuses what is not one address (policy.json is written by hand)', () => {
    for (const address of ['security', 'a@b', 'a@b.c, x@y.z', 'Sec <a@b.c>', 'a b@c.d', 42]) {
      expect(phishingReportSetup({ organisation: { phishingReport: { address } } })).toBeNull();
    }
    expect(phishingReportSetup({ organisation: { phishingReport: ['security@example.org'] } })).toBeNull();
  });
});

describe('isReportable', () => {
  const mail = { keywords: {} };

  it('takes received mail, also in Junk', () => {
    expect(isReportable(mail, 'inbox')).toBe(true);
    expect(isReportable(mail, 'junk')).toBe(true);
    expect(isReportable(mail, null)).toBe(true);
  });

  it("leaves out the user's own mail, drafts, and a message reported already", () => {
    expect(isReportable(mail, 'sent')).toBe(false);
    expect(isReportable(mail, 'drafts')).toBe(false);
    expect(isReportable(mail, 'scheduled')).toBe(false);
    expect(isReportable(mail, null, ['inbox', 'sent'])).toBe(false);
    expect(isReportable({ keywords: { $draft: true } }, 'inbox')).toBe(false);
    expect(isReportable({ keywords: { [PHISHING_KEYWORD]: true } }, 'junk')).toBe(false);
  });

  it('reads the folders a search hit is in from the mailboxes the store knows', () => {
    const mailboxes = [
      { id: 'in', role: 'inbox' },
      { id: 'grp-1:s', originalId: 's', role: 'sent' },
    ] as never;
    const sent = { keywords: {}, mailboxIds: { s: true } } as unknown as Email;
    const received = { keywords: {}, mailboxIds: { in: true, s: false } } as unknown as Email;
    expect(folderRolesOf(sent, mailboxes)).toEqual(['sent']);
    expect(folderRolesOf(received, mailboxes)).toEqual(['inbox']);
    expect(reportableOf([sent, received], null, mailboxes)).toEqual([received]);
  });
});

describe('the report text', () => {
  it('puts "Phishing:" before the subject, on one line', () => {
    expect(reportSubject('Your account\r\nis locked')).toBe('Phishing: Your account is locked');
    expect(reportSubject('')).toBe('Phishing');
    expect(reportSubject(undefined)).toBe('Phishing');
  });

  it('names the reporter', () => {
    expect(reportText({ name: 'Alice', email: 'alice@example.org' })).toBe(
      'Reported as phishing by Alice <alice@example.org> with Bulwark.\r\nThe reported message is attached unchanged.\r\n',
    );
    expect(reportText({ name: ' ', email: 'alice@example.org' })).toContain('by alice@example.org with');
  });
});

describe('reporterIdentity', () => {
  const identity = (id: string, email: string, mayDelete = true) => ({ id, name: '', email, mayDelete }) as Identity;

  it("sends from the login's own address, its canonical identity first", () => {
    const list = [
      identity('team', 'team@example.org'),
      identity('alias', 'alice@example.org', true),
      identity('own', 'alice@example.org', false),
    ];
    expect(reporterIdentity(list, 'alice@example.org')?.id).toBe('own');
    expect(reporterIdentity(list, 'alice')?.id).toBe('own');
  });

  it('never a wildcard identity; null when none can send', () => {
    expect(reporterIdentity([identity('w', '*@example.org'), identity('t', 'team@example.org')], 'alice@example.org')?.id).toBe('t');
    expect(reporterIdentity([identity('w', '*@example.org')], 'alice@example.org')).toBeNull();
  });
});
