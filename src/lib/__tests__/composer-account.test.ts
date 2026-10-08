import { describe, it, expect, vi } from 'vitest';
import { hasQueueAccounts } from '../queue-send';
import {
  composerAccountLabel, composerOwnerAtMount, composerSwitchBackActions, isComposerAccountActive, isComposerOwnerActive,
  queueJmapAccountId,
} from '../composer-account';

describe('composerOwnerAtMount', () => {
  it('owns the message by the active account when nothing switched', () => {
    const owner = composerOwnerAtMount({ activeAppAccountId: 'app-a', activeJmapAccountId: 'jmap-a' });
    expect(owner).toEqual({ appAccountId: 'app-a', jmapAccountId: 'jmap-a' });
    expect(isComposerAccountActive(owner!, 'app-a')).toBe(true);
  });

  it('leaves the JMAP id empty when the client has none yet', () => {
    expect(composerOwnerAtMount({ activeAppAccountId: 'app-a', activeJmapAccountId: null }))
      .toEqual({ appAccountId: 'app-a', jmapAccountId: '' });
  });

  it('has no owner without an active account', () => {
    expect(composerOwnerAtMount({ activeAppAccountId: null, activeJmapAccountId: null })).toBeNull();
  });
});

describe('composerOwnerAtMount with a recorded JMAP id', () => {
  const recorded = (ids: Record<string, string>) => (appId: string) => ids[appId];

  it('the live id wins over the recorded one', () => {
    expect(composerOwnerAtMount({
      activeAppAccountId: 'app-a', activeJmapAccountId: 'jmap-live', recordedJmapAccountId: recorded({ 'app-a': 'jmap-old' }),
    })).toEqual({ appAccountId: 'app-a', jmapAccountId: 'jmap-live' });
  });

  it('offline, the id recorded for the active account stands in', () => {
    expect(composerOwnerAtMount({
      activeAppAccountId: 'app-a', activeJmapAccountId: null, recordedJmapAccountId: recorded({ 'app-a': 'jmap-a' }),
    })).toEqual({ appAccountId: 'app-a', jmapAccountId: 'jmap-a' });
  });

  it("never uses another account's recorded id", () => {
    const lookup = vi.fn(recorded({ 'app-b': 'jmap-b' }));
    expect(composerOwnerAtMount({ activeAppAccountId: 'app-a', activeJmapAccountId: null, recordedJmapAccountId: lookup }))
      .toEqual({ appAccountId: 'app-a', jmapAccountId: '' });
    expect(lookup.mock.calls).toEqual([['app-a']]);
  });
});

describe('queueJmapAccountId', () => {
  const owner = { appAccountId: 'app-a', jmapAccountId: '' };
  const recorded = (ids: Record<string, string>) => vi.fn((appId: string) => ids[appId]);

  it('the live id wins while the client serves the owner', () => {
    expect(queueJmapAccountId(owner, {
      liveJmapAccountId: 'jmap-live', clientServesOwner: true, recorded: recorded({ 'app-a': 'jmap-old' }),
    })).toBe('jmap-live');
  });

  it('a live id the client holds for another account is never used', () => {
    expect(queueJmapAccountId(owner, { liveJmapAccountId: 'jmap-b', clientServesOwner: false })).toBe('');
    expect(queueJmapAccountId(owner, {
      liveJmapAccountId: 'jmap-b', clientServesOwner: false, recorded: recorded({ 'app-a': 'jmap-a' }),
    })).toBe('jmap-a');
  });

  it('offline, the id recorded for the owner is used', () => {
    expect(queueJmapAccountId(owner, {
      liveJmapAccountId: null, clientServesOwner: false, recorded: recorded({ 'app-a': 'jmap-a' }),
    })).toBe('jmap-a');
  });

  it("never uses another account's recorded id", () => {
    const lookup = recorded({ 'app-b': 'jmap-b' });
    expect(queueJmapAccountId(owner, { liveJmapAccountId: null, clientServesOwner: false, recorded: lookup })).toBe('');
    expect(lookup.mock.calls).toEqual([['app-a']]);
  });

  it('falls back to the id pinned at mount', () => {
    expect(queueJmapAccountId({ appAccountId: 'app-a', jmapAccountId: 'jmap-mount' }, {
      liveJmapAccountId: null, clientServesOwner: false, recorded: recorded({}),
    })).toBe('jmap-mount');
  });

  it('with nothing recorded, or no owner, gives "" and the send is refused', () => {
    expect(queueJmapAccountId(owner, { liveJmapAccountId: null, clientServesOwner: false, recorded: recorded({}) })).toBe('');
    expect(queueJmapAccountId(null, { liveJmapAccountId: 'jmap-a', clientServesOwner: true })).toBe('');
    expect(hasQueueAccounts('app-a', queueJmapAccountId(owner, { liveJmapAccountId: null, clientServesOwner: false }))).toBe(false);
  });
});

describe('isComposerAccountActive', () => {
  const owner = { appAccountId: 'app-a', jmapAccountId: 'jmap-a' };

  it('reports the owner inactive once another account is active', () => {
    expect(isComposerAccountActive(owner, 'app-b')).toBe(false);
  });

  it('reports the owner inactive with no active account', () => {
    expect(isComposerAccountActive(owner, null)).toBe(false);
  });
});

describe('isComposerOwnerActive', () => {
  const owner = { appAccountId: 'app-a', jmapAccountId: 'jmap-a' };

  it('allows writes while both stores point at the owner', () => {
    expect(isComposerOwnerActive(owner, 'app-a', 'app-a')).toBe(true);
  });

  it('blocks writes as soon as the view swaps, before the client switched', () => {
    expect(isComposerOwnerActive(owner, 'app-a', 'app-b')).toBe(false);
  });

  it('blocks writes after the switch completed', () => {
    expect(isComposerOwnerActive(owner, 'app-b', 'app-b')).toBe(false);
  });

  it('blocks writes on the way back until the client is the owner again', () => {
    expect(isComposerOwnerActive(owner, 'app-b', 'app-a')).toBe(false);
  });

  it('gates nothing without an owner', () => {
    expect(isComposerOwnerActive(null, 'app-b', 'app-b')).toBe(true);
  });
});

describe('composerAccountLabel', () => {
  const owner = { appAccountId: 'app-a', jmapAccountId: 'jmap-a' };

  it('prefers the email address', () => {
    expect(composerAccountLabel(owner, { email: 'a@x.y', displayName: 'A', username: 'a' })).toBe('a@x.y');
  });

  it('falls back to the display name, then the username', () => {
    expect(composerAccountLabel(owner, { email: '', displayName: 'A', username: 'a' })).toBe('A');
    expect(composerAccountLabel(owner, { email: '', displayName: '', username: 'a' })).toBe('a');
  });

  it('falls back to the registry id when the entry is gone', () => {
    expect(composerAccountLabel(owner, undefined)).toBe('app-a');
  });
});

describe('composerSwitchBackActions', () => {
  it('offers the way back while the owner is still signed in', () => {
    expect(composerSwitchBackActions({ ownerRegistered: true })).toEqual(['cancel', 'switch']);
  });

  it('offers leaving without a server write when the owner was removed', () => {
    expect(composerSwitchBackActions({ ownerRegistered: false })).toEqual(['cancel', 'discard', 'copyAndClose']);
  });

  it('offers leaving without a server write when switching back did not take effect', () => {
    expect(composerSwitchBackActions({ ownerRegistered: true, switchFailed: true }))
      .toEqual(['cancel', 'discard', 'copyAndClose']);
  });
});
