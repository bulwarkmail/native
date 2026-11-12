import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { retentionDays } from '../retention';
import { organisationFor } from '../org-organisation';
import { sanitizePolicy } from '../org-policy';

// Trash and Junk say how long the server keeps mail (webmail
// components/email/retention-notice.tsx, organisation.retention).

describe('retentionDays', () => {
  const policy = sanitizePolicy({
    organisation: { retention: { trashDays: 30, junkDays: 14.4 } },
    scopes: [{ id: 'eu', match: { domains: ['eu.example.org'] }, policy: { organisation: { retention: { trashDays: 7 } } } }],
  })!;

  it('gives the admin days for Trash and Junk only', () => {
    const retention = organisationFor(policy, { email: 'ada@example.org', groups: [] }).retention;
    expect(retentionDays(retention, 'trash')).toBe(30);
    expect(retentionDays(retention, 'junk')).toBe(14);
    expect(retentionDays(retention, 'inbox')).toBe(0);
    expect(retentionDays(retention, null)).toBe(0);
  });

  it('follows the account scope', () => {
    const retention = organisationFor(policy, { email: 'bob@eu.example.org', groups: [] }).retention;
    expect(retentionDays(retention, 'trash')).toBe(7);
    expect(retentionDays(retention, 'junk')).toBe(14);
  });

  it('says nothing without a policy', () => {
    expect(retentionDays(organisationFor(null, null).retention, 'trash')).toBe(0);
  });

  it('is shown in the mail list header', () => {
    const source = readFileSync(join(__dirname, '../../screens/EmailListScreen.tsx'), 'utf8');
    expect(source).toMatch(/<RetentionNotice role=\{currentRole\} \/>/);
  });
});
