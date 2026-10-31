import { describe, it, expect } from 'vitest';
import { identityDraftChanged } from '../settings/identity-draft';

const opened = { name: 'Ada', email: 'ada@example.com', replyTo: '', bcc: '', textSignature: '', htmlSignature: '' };

describe('identity editor', () => {
  it('asks before closing only when something changed (webmail 9d3ae2203)', () => {
    expect(identityDraftChanged(opened, { ...opened })).toBe(false);
    expect(identityDraftChanged(opened, { ...opened, textSignature: '-- \nAda' })).toBe(true);
    expect(identityDraftChanged(opened, { ...opened, bcc: 'archive@example.com' })).toBe(true);
    expect(identityDraftChanged(null, opened)).toBe(false);
  });
});
