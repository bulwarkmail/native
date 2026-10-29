import { describe, it, expect } from 'vitest';
import { isPendingSend, sameScheduledSend, scheduledSendKey } from '../scheduled-send-key';

// Stalwart numbers each account's submissions from the start, so the own
// account and a group account both hold an "a".
const own = { accountId: 'own', emailSubmissionId: 'a' };
const group = { accountId: 'grp', emailSubmissionId: 'a' };

describe('scheduled send identity', () => {
  it('tells apart records of two accounts with the same id', () => {
    expect(scheduledSendKey(own)).not.toBe(scheduledSendKey(group));
    expect(sameScheduledSend(own, group)).toBe(false);
    expect(sameScheduledSend(own, { ...own })).toBe(true);
  });

  it('matches the undo snackbar only to its own account\'s row', () => {
    // A send from the composer names no account: it is the own one.
    expect(isPendingSend({ emailSubmissionId: 'a' }, own, 'own')).toBe(true);
    expect(isPendingSend({ emailSubmissionId: 'a' }, group, 'own')).toBe(false);
    expect(isPendingSend({ emailSubmissionId: 'a', accountId: 'grp' }, group, 'own')).toBe(true);
    expect(isPendingSend(null, own, 'own')).toBe(false);
  });
});
