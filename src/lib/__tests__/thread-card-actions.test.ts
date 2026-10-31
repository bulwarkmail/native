import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { cardReplyActions } from '../thread-card-actions';

// A draft in a conversation showed Reply / Reply all / Forward greyed out,
// announced to screen readers as enabled buttons. The webmail renders no
// reply buttons on a draft or a scheduled message; neither does the card.

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '..', '..', rel), 'utf8');
const NONE = new Set<string>();

describe('reply row of a conversation card', () => {
  it('hides the row on a draft and on a scheduled message', () => {
    expect(cardReplyActions({ id: 'd1', keywords: { $draft: true } }, true, NONE)).toBe('hidden');
    expect(cardReplyActions({ id: 'd1', keywords: { $draft: true } }, false, NONE)).toBe('hidden');
    expect(cardReplyActions({ id: 's1', keywords: {} }, true, new Set(['s1']))).toBe('hidden');
  });

  it('shows it disabled while the body loads, then enabled', () => {
    expect(cardReplyActions({ id: 'm1', keywords: { $seen: true } }, false, NONE)).toBe('disabled');
    expect(cardReplyActions({ id: 'm1', keywords: { $seen: true } }, true, NONE)).toBe('enabled');
  });

  it('renders no row for a hidden state and marks disabled buttons for screen readers', () => {
    const card = read('components/email/ThreadMessageCard.tsx');
    expect(card).toMatch(/\{!bare && replyActions !== 'hidden' && \(/);
    expect(card).toMatch(/accessibilityState: \{ disabled: !replyable \}/);
    expect(read('screens/EmailThreadScreen.tsx')).toMatch(/replyActions=\{cardReplyActions\(m, !!full, scheduledIds\)\}/);
  });
});
