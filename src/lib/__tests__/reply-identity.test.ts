import { describe, it, expect } from 'vitest';
import {
  findReplyIdentityId, findDraftIdentityId, resolveReplyFrom, findComposeIdentityId, resolveReplyIdentity,
  resolveComposeAccountEmail,
} from '../reply-identity';
import type { Identity } from '../../api/types';

const identities: Identity[] = [
  { id: 'main', name: 'Me', email: 'me@example.com', mayDelete: false },
  { id: 'alias', name: 'Alias', email: 'me@example.com', mayDelete: true },
  { id: 'info', name: 'Info', email: 'info@example.com', mayDelete: true },
];

describe('findReplyIdentityId', () => {
  it('matches exact address across to/cc/bcc', () => {
    expect(findReplyIdentityId(identities, { bcc: [{ email: 'INFO@example.com' }] })).toBe('info');
  });

  it('falls back to the +tag-stripped address', () => {
    expect(findReplyIdentityId(identities, { to: [{ email: 'info+news@example.com' }] })).toBe('info');
  });

  it('returns null when nothing matches', () => {
    expect(findReplyIdentityId(identities, { to: [{ email: 'x@other.com' }] })).toBeNull();
    expect(findReplyIdentityId([], { to: [{ email: 'me@example.com' }] })).toBeNull();
  });

  // The shared-mailbox shape: the team address in To, the member's own
  // address in Cc. Scanning identities rather than recipients would answer
  // with whichever identity comes first.
  const shared: Identity[] = [
    { id: 'owner', name: 'Owner', email: 'owner@example.com', mayDelete: false },
    { id: 'team', name: 'Team', email: 'team@example.com', mayDelete: false },
  ];

  it('prefers a To recipient over a Cc one, whatever order the identities are in', () => {
    expect(findReplyIdentityId(shared, {
      to: [{ email: 'team@example.com' }],
      cc: [{ email: 'owner@example.com' }],
    })).toBe('team');
  });

  it('ranks a Bcc identity below the address in To', () => {
    const withArchive: Identity[] = [
      { id: 'archive', name: 'Archive', email: 'archive@example.com', mayDelete: false },
      { id: 'team', name: 'Team', email: 'team@example.com', mayDelete: false },
    ];
    expect(findReplyIdentityId(withArchive, {
      to: [{ email: 'team@example.com' }],
      bcc: [{ email: 'archive@example.com' }],
    })).toBe('team');
  });

  it('takes an exact match anywhere over a sub-address match in To', () => {
    expect(findReplyIdentityId(identities, {
      to: [{ email: 'me+news@example.com' }],
      cc: [{ email: 'info@example.com' }],
    })).toBe('info');
  });

  // A `+tag` identifies who the address was given to, so a delivery to an
  // unknown tag must not answer with a sibling's tag and disclose it.
  it('prefers the untagged identity over a differently-tagged sibling', () => {
    const tagged: Identity[] = [
      { id: 'eu', name: 'Sales EU', email: 'sales+eu@example.com', mayDelete: false },
      { id: 'sales', name: 'Sales', email: 'sales@example.com', mayDelete: false },
    ];
    expect(findReplyIdentityId(tagged, { to: [{ email: 'sales+us@example.com' }] })).toBe('sales');
  });
});

describe('findComposeIdentityId', () => {
  it('matches the account address', () => {
    expect(findComposeIdentityId(identities, 'info+x@example.com')).toBe('info');
    expect(findComposeIdentityId(identities, undefined)).toBeNull();
  });
});

describe('findDraftIdentityId', () => {
  it('disambiguates by name when two identities share an address', () => {
    expect(findDraftIdentityId(identities, { email: 'me@example.com', name: 'Alias' })).toBe('alias');
    expect(findDraftIdentityId(identities, { email: 'me@example.com', name: 'Someone' })).toBe('main');
  });
});

describe('resolveReplyFrom', () => {
  it('returns the identity without override on an exact match', () => {
    expect(resolveReplyFrom(identities, { to: [{ email: 'info@example.com' }] })).toEqual({ identityId: 'info' });
  });

  it('proposes a catch-all From override on an owned domain', () => {
    expect(resolveReplyFrom(identities, { to: [{ email: 'sales@example.com', name: 'Sales' }] })).toEqual({
      identityId: 'main',
      overrideEmail: 'sales@example.com',
      overrideName: 'Sales',
    });
  });

  it('returns null for foreign domains', () => {
    expect(resolveReplyFrom(identities, { to: [{ email: 'x@other.com' }] })).toBeNull();
  });

  it('skips the catch-all in exact match mode but still matches identities', () => {
    expect(resolveReplyFrom(identities, { to: [{ email: 'sales@example.com' }] }, 'exact')).toBeNull();
    expect(resolveReplyFrom(identities, { to: [{ email: 'info+x@example.com' }] }, 'exact')).toEqual({ identityId: 'info' });
  });
});

describe('resolveReplyIdentity', () => {
  const ownEmails = ['me@example.com', 'info@example.com'];

  it('sends from the own identity the message was delivered to, without the setting', () => {
    expect(resolveReplyIdentity(identities, {
      from: { email: 'alice@other.com' },
      to: [{ email: 'info@example.com' }],
    }, { ownEmails, catchAll: false })).toEqual({ identityId: 'info' });
  });

  it('never rewrites From unless the catch-all is asked for', () => {
    const original = { from: { email: 'alice@other.com' }, to: [{ email: 'sales@example.com', name: 'Sales' }] };
    expect(resolveReplyIdentity(identities, original, { ownEmails, catchAll: false })).toBeNull();
    expect(resolveReplyIdentity(identities, original, { ownEmails, catchAll: true })).toEqual({
      identityId: 'main', overrideEmail: 'sales@example.com', overrideName: 'Sales',
    });
    expect(resolveReplyIdentity(identities, original, { ownEmails, catchAll: true, matchMode: 'exact' })).toBeNull();
  });

  it('replies to our own message from the identity that sent it', () => {
    expect(resolveReplyIdentity(identities, {
      from: { email: 'me@example.com', name: 'Alias' },
      to: [{ email: 'bob@example.com' }],
    }, { ownEmails, catchAll: true })).toEqual({ identityId: 'alias' });
  });

  it('returns null without identities or a match', () => {
    expect(resolveReplyIdentity([], { to: [{ email: 'info@example.com' }] }, { ownEmails, catchAll: true })).toBeNull();
    expect(resolveReplyIdentity(identities, { to: [{ email: 'x@other.com' }] }, { ownEmails, catchAll: true })).toBeNull();
  });
});

describe('resolveComposeAccountEmail', () => {
  const mailboxes = [
    { id: 'a-inbox' },
    { id: 'owner-x:x-inbox', isShared: true, accountName: 'team@shared.example' },
    { id: 'owner-y:y-inbox', isShared: true, accountName: 'Support Team' },
  ];

  it('uses the shared folder owner address when a shared folder is open', () => {
    expect(resolveComposeAccountEmail(mailboxes, 'owner-x:x-inbox', 'me@primary.example')).toBe('team@shared.example');
    expect(resolveComposeAccountEmail(mailboxes, 'owner-x:x-inbox')).toBe('team@shared.example');
  });

  it('keeps the fallback for an own folder, a non-address account name or no selection', () => {
    expect(resolveComposeAccountEmail(mailboxes, 'a-inbox', 'me@primary.example')).toBe('me@primary.example');
    expect(resolveComposeAccountEmail(mailboxes, 'owner-y:y-inbox', 'me@primary.example')).toBe('me@primary.example');
    expect(resolveComposeAccountEmail(mailboxes, null, 'me@primary.example')).toBe('me@primary.example');
    expect(resolveComposeAccountEmail(mailboxes, 'a-inbox')).toBeUndefined();
  });

  it('preselects the shared identity end-to-end', () => {
    const ids: Identity[] = [
      { id: 'primary', name: 'D R', email: 'me@primary.example', mayDelete: false },
      { id: 'shared', name: 'D R', email: 'team@shared.example', mayDelete: false },
    ];
    expect(findComposeIdentityId(ids, resolveComposeAccountEmail(mailboxes, 'owner-x:x-inbox'))).toBe('shared');
    expect(findComposeIdentityId(ids, resolveComposeAccountEmail(mailboxes, 'a-inbox'))).toBeNull();
  });
});
