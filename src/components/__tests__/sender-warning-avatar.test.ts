import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('../../api/jmap-client', () => ({
  jmapClient: { accountId: 'acc-1', request: vi.fn(), getMaxObjectsInGet: vi.fn(() => 50) },
}));

import { avatarContent } from '../../lib/avatar-utils';
import { LIST_AUTH_RESULTS_PROPERTY, senderWarningOf } from '../../lib/email-headers';
import { EMAIL_FULL_PROPERTIES, EMAIL_LIST_PROPERTIES } from '../../api/email';
import type { Email } from '../../api/types';

// A forged From kept the real sender's favicon or contact photo: the reader
// worked out that the sender check failed, but the avatar beside it still
// showed the claimed sender's logo, and list rows had no auth data at all
// (webmail 605a3983b, #1439). Now the avatar shows a warning shield.

const FORGED = 'mx.example.org; spf=fail smtp.mailfrom=evil.example; dkim=none; dmarc=fail header.from=bank.example';
const GOOD = 'mx.example.org; spf=pass smtp.mailfrom=bank.example; dkim=pass header.d=bank.example; dmarc=pass header.from=bank.example';

function row(auth: string[] | undefined): Email {
  return {
    id: 'm1', threadId: 't1', mailboxIds: {}, keywords: {}, size: 1, receivedAt: '2026-10-31T10:00:00Z',
    hasAttachment: false, from: [{ name: 'Bank', email: 'ceo@bank.example' }],
    ...(auth ? { [LIST_AUTH_RESULTS_PROPERTY]: auth } : {}),
  } as Email;
}

describe('sender warning in avatars (bulwarkmail/webmail#1439)', () => {
  it('asks for the Authentication-Results headers in the list fetch, not in the full one', () => {
    expect(EMAIL_LIST_PROPERTIES).toContain('header:Authentication-Results:all');
    // The full fetch has `headers`, which carry the same header.
    expect(EMAIL_FULL_PROPERTIES).not.toContain('header:Authentication-Results:all');
    expect(EMAIL_FULL_PROPERTIES).toContain('headers');
  });

  it('judges a list row from the listed header and a full message from its headers', () => {
    expect(senderWarningOf(row([FORGED]))?.status).toBe('failed');
    expect(senderWarningOf(row([GOOD]))).toBeNull();
    expect(senderWarningOf(row(undefined))).toBeNull();
    expect(senderWarningOf(row([]))).toBeNull();
    const full = { ...row(undefined), headers: [{ name: 'Authentication-Results', value: ` ${FORGED}` }] };
    expect(senderWarningOf(full)?.status).toBe('failed');
  });

  it('shows the shield before a contact photo or favicon', () => {
    expect(avatarContent({ senderWarning: 'Sender check failed', hasPhoto: true, showFavicon: true })).toBe('warning');
    expect(avatarContent({ senderWarning: undefined, hasPhoto: true, showFavicon: true })).toBe('photo');
    expect(avatarContent({ senderWarning: null, hasPhoto: false, showFavicon: true })).toBe('favicon');
    expect(avatarContent({ hasPhoto: false, showFavicon: false })).toBe('initials');
  });

  it('passes the warning to the avatar in the reader, collapsed conversation cards and list rows', () => {
    const src = (p: string) => fs.readFileSync(path.resolve(__dirname, '..', '..', p), 'utf8');
    expect(src('components/email/MessageHeader.tsx')).toMatch(/senderWarning=\{verificationText\?\.label\}/);
    expect(src('components/email/ThreadMessageCard.tsx')).toMatch(/senderWarning=\{senderWarning\}/);
    expect(src('screens/EmailListScreen.tsx')).toMatch(/senderWarning=\{senderWarning\}/);
    expect(src('screens/UnifiedInboxScreen.tsx')).toMatch(/senderWarning=\{verification \?/);
  });
});
