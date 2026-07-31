import { describe, it, expect } from 'vitest';
import { computeReplyThreadingHeaders } from '../email-threading';

describe('computeReplyThreadingHeaders', () => {
  it('returns undefined when the parent has no msg-id', () => {
    expect(computeReplyThreadingHeaders(undefined)).toBeUndefined();
    expect(computeReplyThreadingHeaders({})).toBeUndefined();
    expect(computeReplyThreadingHeaders({ messageId: [] })).toBeUndefined();
  });

  it('brackets the parent msg-id', () => {
    expect(computeReplyThreadingHeaders({ messageId: ['abc@host'] })).toEqual({
      inReplyTo: '<abc@host>',
      references: '<abc@host>',
    });
  });

  it('keeps the ancestor chain and closes it with the parent', () => {
    expect(
      computeReplyThreadingHeaders({
        messageId: ['c@host'],
        references: ['a@host', 'b@host'],
      }),
    ).toEqual({
      inReplyTo: '<c@host>',
      references: '<a@host> <b@host> <c@host>',
    });
  });

  it('de-dupes an ancestor that is already the parent', () => {
    expect(
      computeReplyThreadingHeaders({ messageId: ['a@host'], references: ['a@host'] }),
    ).toEqual({ inReplyTo: '<a@host>', references: '<a@host>' });
  });

  it('tolerates ids that already carry angle brackets', () => {
    expect(
      computeReplyThreadingHeaders({ messageId: ['<a@host>'], references: ['<z@host>'] }),
    ).toEqual({ inReplyTo: '<a@host>', references: '<z@host> <a@host>' });
  });
});
