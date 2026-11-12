import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { Email } from '../../api/types';
import { initialTagTokens, outgoingTagKeywordMap, toggleTagToken } from '../compose-tags';
import { replyComposeParams } from '../reply-compose';
import { draftContextFromEmail } from '../draft-context';

// Tags in the composer (webmail #1610): replies and forwards start with the
// original's tags, drafts keep them and the sent copy carries them.

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '..', '..', rel), 'utf8');

const source = {
  id: 'm1', threadId: 't1', mailboxIds: {}, size: 1, receivedAt: '2026-11-01T10:00:00Z', subject: 'Hi',
  from: [{ email: 'ann@example.org' }],
  keywords: { $seen: true, '$label:work': true, '$color:old': true, '$label:off': false },
  textBody: [{ partId: '1', type: 'text/plain' }], bodyValues: { 1: { value: 'x' } },
} as unknown as Email;

describe('composer tags', () => {
  it('starts with the tags of the message, the legacy prefix as $label:', () => {
    expect(initialTagTokens(source.keywords)).toEqual(['$label:work', '$label:old']);
    expect(initialTagTokens(undefined)).toEqual([]);
  });

  it('toggles a tag once', () => {
    expect(toggleTagToken(['$label:a'], '$label:b', true)).toEqual(['$label:a', '$label:b']);
    expect(toggleTagToken(['$label:a'], '$label:a', true)).toEqual(['$label:a']);
    expect(toggleTagToken(['$label:a', '$label:b'], '$label:a', false)).toEqual(['$label:b']);
  });

  it('puts only valid tag keywords on the outgoing message', () => {
    expect(outgoingTagKeywordMap(['$label:work', '$LABEL:work', '$label:work', '$seen', '$label:', '$label:bad name', 'plain']))
      .toEqual({ '$label:work': true });
    expect(outgoingTagKeywordMap(undefined)).toEqual({});
  });

  it('hands the original keywords to a reply and a forward, and a draft keeps its own', () => {
    expect(replyComposeParams('reply', source)?.replyTo?.keywords).toEqual(source.keywords);
    expect(replyComposeParams('forward', source)?.replyTo?.keywords).toEqual(source.keywords);
    expect(draftContextFromEmail({ ...source, keywords: { $draft: true, '$label:x': true } } as Email).keywords)
      .toEqual({ $draft: true, '$label:x': true });
  });

  // No RN renderer in the suite: the composer wiring, read from its source.
  it('offers a Tags sheet and sends and saves the tags', () => {
    const src = read('screens/ComposeScreen.tsx');
    expect(src).toMatch(/initialTagTokens\(draft \? draft\.keywords : replyTo\?\.keywords\)/);
    expect(src).toMatch(/useAccountKeywordDefs\(replyTo\?\.jmapAccountId\)/);
    expect(src).toMatch(/<ToolbarButton active=\{tagTokens\.length > 0\} onPress=\{\(\) => setTagSheetOpen\(true\)\}/);
    expect(src).toMatch(/<TagSheet\s+visible=\{tagSheetOpen\}/);
    expect(src).toMatch(/keywords: tagTokens\.length \? tagTokens : undefined,/);
    // A tag change is an edit: the draft is saved again.
    expect(src).toMatch(/attachments, priority, tags: tagTokens,/);
    const api = read('api/email.ts');
    expect(api.match(/emailCreate\.keywords = \{ \.\.\.outgoingTagKeywordMap\(email\.keywords\), \$seen: true, \$draft: true \};/g)).toHaveLength(3);
  });
});
