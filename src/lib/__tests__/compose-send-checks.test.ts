import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { findAttachmentKeyword, passesQuickReplyChecks, type SendQuestion } from '../compose-send-checks';
import { placeholderWordsFor } from '../placeholder-check';

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, rel), 'utf8');

const base = {
  placeholderWords: placeholderWordsFor('en'),
  attachmentKeywords: ['attached', 'attachment'],
  confirmSend: false,
  recipientCount: 1,
};

describe('findAttachmentKeyword', () => {
  it('matches whole words only, ignoring case and blanks', () => {
    expect(findAttachmentKeyword('See the ATTACHED file', ['', 'attached'])).toBe('attached');
    expect(findAttachmentKeyword('The detached house', ['attach', 'tached'])).toBeUndefined();
    expect(findAttachmentKeyword('price (c++)', ['c++'])).toBeUndefined();
  });
});

describe('passesQuickReplyChecks (webmail lib/outgoing/quick-reply.ts)', () => {
  it('asks about unfilled placeholders and stops on Back', async () => {
    const ask = vi.fn(async () => false);
    const ok = await passesQuickReplyChecks({ ...base, body: 'See you at [TIME].', ask });
    expect(ok).toBe(false);
    expect(ask).toHaveBeenCalledWith({ kind: 'placeholders', found: ['[TIME]'] });
  });

  it('asks about a forgotten attachment', async () => {
    const asked: SendQuestion[] = [];
    const ok = await passesQuickReplyChecks({
      ...base,
      body: 'Here is the attachment.',
      ask: async (q) => { asked.push(q); return true; },
    });
    expect(ok).toBe(true);
    expect(asked).toEqual([{ kind: 'attachment', keyword: 'attachment' }]);
  });

  it('asks "Send this message?" last, with the recipient count', async () => {
    const asked: SendQuestion[] = [];
    const ok = await passesQuickReplyChecks({
      ...base,
      body: 'TODO attached',
      confirmSend: true,
      recipientCount: 3,
      ask: async (q) => { asked.push(q); return true; },
    });
    expect(ok).toBe(true);
    expect(asked.map((q) => q.kind)).toEqual(['placeholders', 'attachment', 'send']);
    expect(asked[2]).toEqual({ kind: 'send', count: 3 });
  });

  it('sends without asking when the warnings are off and nothing matches', async () => {
    const ask = vi.fn(async () => false);
    expect(await passesQuickReplyChecks({
      body: 'TODO [TIME] attached', placeholderWords: null, attachmentKeywords: null, confirmSend: false, recipientCount: 1, ask,
    })).toBe(true);
    expect(await passesQuickReplyChecks({ ...base, body: 'Thanks, see you then.', ask })).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it('stops when the confirm is declined', async () => {
    expect(await passesQuickReplyChecks({ ...base, body: 'Thanks', confirmSend: true, ask: async () => false })).toBe(false);
  });
});

describe('send checks wiring', () => {
  it('runs the checks in quick reply before anything is sent', () => {
    const source = read('../../components/email/QuickReplyBox.tsx');
    const checks = source.indexOf('await passesQuickReplyChecks(');
    expect(checks).toBeGreaterThan(-1);
    expect(checks).toBeLessThan(source.indexOf('await sendEmail('));
    expect(checks).toBeLessThan(source.indexOf('setSending(true)'));
    const call = source.slice(checks, source.indexOf('if (!passed) return;', checks));
    expect(call).toMatch(/placeholderWarningEnabled \? placeholderWordsFor\(locale\) : null/);
    expect(call).toMatch(/attachmentReminderEnabled \? settings\.attachmentReminderKeywords : null/);
    expect(call).toMatch(/confirmSend: settings\.sendConfirmation/);
  });

  it('asks "Send this message?" in the composer after the other checks when the setting is on', () => {
    const source = read('../../screens/ComposeScreen.tsx');
    const fn = source.slice(source.indexOf('const passesSendConfirmation'));
    expect(fn).toMatch(/^const passesSendConfirmation = \(\): Promise<boolean> => \{\s+if \(!useSettingsStore\.getState\(\)\.sendConfirmation\) return Promise\.resolve\(true\);/);
    const inner = source.slice(source.indexOf('const performSendInner'));
    const confirm = inner.indexOf('await passesSendConfirmation()');
    expect(confirm).toBeGreaterThan(inner.indexOf('await passesAttachmentReminder('));
    expect(confirm).toBeLessThan(inner.indexOf('await sendEmail('));
  });
});
