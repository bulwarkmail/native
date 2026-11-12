import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { answerSendWarnings, collectSendWarnings, sendWarningsContent, type SendWarning } from '../compose-send-warnings';

// One question before sending (webmail send-warnings-dialog.tsx): an empty
// subject, placeholders and a forgotten attachment came as three Alerts in a
// row.

const t = (_key: string, fallback: string, params?: Record<string, string | number>) =>
  fallback.replace(/\{(\w+)\}/g, (m, k: string) => (params && k in params ? String(params[k]) : m));

const base = { subject: '', askSubject: true, placeholders: ['[TIME]'], confirmedPlaceholders: new Set<string>(), attachmentKeyword: 'attached' };

describe('send warnings', () => {
  it('collects everything a Send would ask about, in the composer order', () => {
    expect(collectSendWarnings(base)).toEqual([
      { kind: 'subject' },
      { kind: 'placeholders', matches: ['[TIME]'] },
      { kind: 'attachment', keyword: 'attached' },
    ]);
  });

  it('leaves out what is answered, switched off or fine', () => {
    expect(collectSendWarnings({
      ...base, subject: 'Hi', placeholders: ['[TIME]'], confirmedPlaceholders: new Set(['[TIME]']), attachmentKeyword: undefined,
    })).toEqual([]);
    expect(collectSendWarnings({ ...base, askSubject: false, placeholders: null, attachmentKeyword: undefined })).toEqual([]);
  });

  it('lists several warnings under one title with one Send anyway', () => {
    const content = sendWarningsContent(collectSendWarnings(base), t);
    expect(content.title).toBe('Send this message anyway?');
    expect(content.items.map((i) => i.text)).toEqual([
      'No subject',
      'Placeholder text that recipients will see:',
      'Mentions "attached", but no file is attached',
    ]);
    expect(content.items[1].matches).toEqual(['[TIME]']);
    expect(content.sendLabel).toBe('Send anyway');
    expect(content.dontAskAgainLabel).toBeUndefined();
    expect(sendWarningsContent(collectSendWarnings(base), t, true).sendLabel).toBe('Schedule anyway');
  });

  it('keeps the own title and "Don\'t ask again" of a single warning', () => {
    const subject = sendWarningsContent([{ kind: 'subject' }], t);
    expect(subject.title).toBe('Send without a subject?');
    expect(subject.dontAskAgainLabel).toBe("Don't ask again");
    const attachment = sendWarningsContent([{ kind: 'attachment', keyword: 'enclosed' }], t);
    expect(attachment.title).toBe('Did you forget an attachment?');
    expect(attachment.description).toContain('"enclosed"');
    expect(attachment.dontAskAgainLabel).toBeUndefined();
  });

  it('lets through what Send anyway answered and switches off only a single warning', () => {
    const all: SendWarning[] = collectSendWarnings(base);
    expect(answerSendWarnings(all, true)).toEqual({ subjectConfirmed: true, placeholders: ['[TIME]'], switchOff: [] });
    expect(answerSendWarnings([{ kind: 'placeholders', matches: ['TODO'] }], true).switchOff).toEqual(['placeholderWarningEnabled']);
    expect(answerSendWarnings([{ kind: 'subject' }], false).switchOff).toEqual([]);
  });

  // No RN renderer in the suite: the composer wiring, read from its source.
  it('asks once in the composer, before "Send this message?"', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../screens/ComposeScreen.tsx'), 'utf8');
    const inner = source.slice(source.indexOf('const performSendInner'));
    const warnings = inner.indexOf('await passesSendWarnings(plainTextMode ? plainBody : liveBodyHtml, !!scheduledAt)');
    expect(warnings).toBeGreaterThan(-1);
    expect(warnings).toBeLessThan(inner.indexOf('await passesSendConfirmation()'));
    // The three Alerts are gone.
    expect(source).not.toMatch(/Alert\.alert\(\s+t\('email_composer\.(empty_subject|placeholder_warning)\.title'/);
    expect(source).not.toMatch(/attachment_reminder_title/);
    expect(source).toMatch(/<SendWarningsSheet\s+warnings=\{sendWarnings\?\.items \?\? null\}/);
  });
});
