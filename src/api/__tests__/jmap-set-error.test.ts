import { describe, it, expect } from 'vitest';
import {
  assertSetResult,
  isJMAPSetError,
  JMAPMethodError,
  JMAPSetError,
  requireMethodResult,
} from '../jmap-result';
import { isTransientNetworkError } from '../../lib/network-error';

// A SetError refuses one object of a /set call; a method error refuses the
// whole call. `forbidden` comes both ways, and only the SetError says
// something about the object. Shapes as Stalwart 0.16.16-0.16.23 and 1.0
// answer them (jmap-proto method/set.rs, error/set.rs).
const EMAIL_PUSH_REFUSED = {
  type: 'forbidden',
  description: 'No access to one of the accounts in the emailPush map.',
};

describe('JMAPSetError', () => {
  it.each([
    ['notCreated', 'new', 'create'],
    ['notUpdated', 's1', 'update'],
    ['notDestroyed', 's1', 'destroy'],
  ])('is what assertSetResult throws for %s (Stalwart 0.16.16+ and 1.0)', (bucket, id, verb) => {
    const body = { [bucket]: { [id]: EMAIL_PUSH_REFUSED } };
    let thrown: unknown;
    try {
      assertSetResult(body, [id], 'push subscription');
    } catch (err) {
      thrown = err;
    }
    expect(isJMAPSetError(thrown)).toBe(true);
    // Still a JMAPMethodError under that name, so older checks keep working.
    expect(thrown).toBeInstanceOf(JMAPMethodError);
    expect(thrown).toMatchObject({ name: 'JMAPMethodError', type: 'forbidden' });
    expect((thrown as Error).message).toBe(
      `Failed to ${verb} push subscription ${id}: forbidden – No access to one of the accounts in the emailPush map.`,
    );
  });

  it('carries the properties the server named (Stalwart 1.0 keyword cap)', () => {
    const body = {
      notUpdated: {
        m1: { type: 'invalidProperties', description: 'Keywords cannot be longer than 128 bytes.', properties: ['keywords'] },
      },
    };
    expect(() => assertSetResult(body, ['m1'], 'email')).toThrow(JMAPSetError);
    try {
      assertSetResult(body, ['m1'], 'email');
    } catch (err) {
      expect((err as JMAPSetError).properties).toEqual(['keywords']);
      expect((err as JMAPSetError).type).toBe('invalidProperties');
    }
  });

  it('is not what a refused method call throws, even with the same type', () => {
    const res = {
      methodResponses: [['error', { type: 'forbidden', description: 'Not allowed' }, '0']] as Array<
        [string, Record<string, unknown>, string]
      >,
    };
    let thrown: unknown;
    try {
      requireMethodResult(res, '0', 'PushSubscription/set');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(JMAPMethodError);
    expect(isJMAPSetError(thrown)).toBe(false);
    expect((thrown as JMAPMethodError).type).toBe('forbidden');
  });

  it('counts as a server refusal for the outbox, not a connectivity blip', () => {
    // The outbox classifies by error name; a SetError must stay terminal.
    expect(isTransientNetworkError(new JMAPSetError('forbidden', 'request timed out'))).toBe(false);
  });

  it('reads nothing else as a SetError', () => {
    expect(isJMAPSetError(new JMAPMethodError('forbidden'))).toBe(false);
    expect(isJMAPSetError(new Error('forbidden'))).toBe(false);
    expect(isJMAPSetError({ type: 'forbidden' })).toBe(false);
    expect(isJMAPSetError(undefined)).toBe(false);
  });
});
