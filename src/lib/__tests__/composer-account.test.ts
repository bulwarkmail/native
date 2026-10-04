import { describe, it, expect } from 'vitest';
import { composerOwnerAtMount, isComposerAccountActive } from '../composer-account';

const accounts = [
  { id: 'app-a', jmapAccountId: 'jmap-a' },
  { id: 'app-b', jmapAccountId: 'jmap-b' },
  { id: 'app-c' },
];

describe('composerOwnerAtMount', () => {
  it('owns a new message by the active account when nothing switched', () => {
    const owner = composerOwnerAtMount({
      activeAppAccountId: 'app-a',
      activeJmapAccountId: 'jmap-a',
      accounts,
    });
    expect(owner).toEqual({ appAccountId: 'app-a', jmapAccountId: 'jmap-a' });
    expect(isComposerAccountActive(owner!, 'app-a')).toBe(true);
  });

  it('owns a reopened draft by the app account its JMAP account belongs to', () => {
    const owner = composerOwnerAtMount({
      draftJmapAccountId: 'jmap-b',
      activeAppAccountId: 'app-a',
      activeJmapAccountId: 'jmap-a',
      accounts,
    });
    expect(owner).toEqual({ appAccountId: 'app-b', jmapAccountId: 'jmap-b' });
    expect(isComposerAccountActive(owner!, 'app-a')).toBe(false);
  });

  it('keeps a draft from a shared account with the active login', () => {
    const owner = composerOwnerAtMount({
      draftJmapAccountId: 'jmap-shared',
      activeAppAccountId: 'app-a',
      activeJmapAccountId: 'jmap-a',
      accounts,
    });
    expect(owner).toEqual({ appAccountId: 'app-a', jmapAccountId: 'jmap-a' });
  });

  it('falls back to the registry entry when the client has no JMAP account yet', () => {
    expect(composerOwnerAtMount({
      activeAppAccountId: 'app-b',
      activeJmapAccountId: null,
      accounts,
    })).toEqual({ appAccountId: 'app-b', jmapAccountId: 'jmap-b' });
  });

  it('has no owner without an active account', () => {
    expect(composerOwnerAtMount({
      activeAppAccountId: null,
      activeJmapAccountId: null,
      accounts,
    })).toBeNull();
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
