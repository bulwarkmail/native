import { describe, expect, it } from 'vitest';
import { MaskedEmailError, type MaskedAddress } from '../../../lib/masked-email';
import { maskedFailureNotice, maskedLoadFailure, maskedPage } from '../masked-addresses';

const ENTERPRISE = 'This feature is only available in the Enterprise edition. Obtain your trial license at https://license.stalw.art/trial.';
const addresses = (count: number): MaskedAddress[] => Array.from({ length: count }, (_, i) => ({
  id: `m${i}`, email: `m${i}@example.test`, description: null, forDomain: null, enabled: true,
}));

describe('maskedLoadFailure', () => {
  it('hides the section where the server has no masked addresses', () => {
    expect(maskedLoadFailure(new MaskedEmailError('unknownMethod'))).toBe('unavailable');
    expect(maskedLoadFailure(new MaskedEmailError('forbidden', ENTERPRISE))).toBe('unavailable');
  });

  it('tells a refused read from a failed one', () => {
    expect(maskedLoadFailure(new MaskedEmailError('forbidden', 'Missing permission'))).toBe('forbidden');
    expect(maskedLoadFailure(new MaskedEmailError('listChanged'))).toBe('error');
    expect(maskedLoadFailure(new Error('Network request failed'))).toBe('error');
  });
});

describe('maskedFailureNotice', () => {
  it('names what the server refused', () => {
    expect(maskedFailureNotice('create', new MaskedEmailError('forbidden'))).toBe('create_forbidden');
    expect(maskedFailureNotice('update', new MaskedEmailError('forbidden'))).toBe('update_forbidden');
    expect(maskedFailureNotice('destroy', new MaskedEmailError('forbidden'))).toBe('delete_forbidden');
    expect(maskedFailureNotice('create', new MaskedEmailError('overQuota'))).toBe('over_quota');
    expect(maskedFailureNotice('create', new MaskedEmailError('rateLimit'))).toBe('rate_limit');
  });

  it('does not call an unanswered delete failed', () => {
    expect(maskedFailureNotice('destroy', new MaskedEmailError('deleteUnconfirmed'))).toBe('delete_unconfirmed');
    expect(maskedFailureNotice('destroy', new MaskedEmailError('notFound'))).toBe('delete_failed');
  });

  it('asks for a refresh after any other failed save', () => {
    expect(maskedFailureNotice('update', new Error('Network request failed'))).toBe('save_failed');
    expect(maskedFailureNotice('create', new MaskedEmailError('invalidProperties'))).toBe('save_failed');
  });
});

describe('maskedPage', () => {
  it('shows ten rows a page', () => {
    expect(maskedPage(addresses(23), 0)).toMatchObject({ page: 0, pageCount: 3 });
    expect(maskedPage(addresses(23), 1).rows.map((row) => row.id)).toEqual(['m10', 'm11', 'm12', 'm13', 'm14', 'm15', 'm16', 'm17', 'm18', 'm19']);
    expect(maskedPage(addresses(23), 2).rows).toHaveLength(3);
  });

  it('falls back to the last page once the one shown is gone', () => {
    expect(maskedPage(addresses(20), 2)).toMatchObject({ page: 1, pageCount: 2 });
    expect(maskedPage([], 4)).toEqual({ rows: [], page: 0, pageCount: 1 });
  });
});
