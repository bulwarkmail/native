import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// "@" mentions as wired in ComposeScreen (webmail email-composer.tsx
// mentionCandidates / findMentionContacts / addMentionedRecipient), checked
// on its source (the suite has no RN renderer).
const source = fs.readFileSync(path.resolve(__dirname, '../../screens/ComposeScreen.tsx'), 'utf8');

describe('ComposeScreen mention wiring', () => {
  it('turns mentions on in the message editor and follows its query', () => {
    const at = source.search(/<RichTextEditor\s/);
    const editor = source.slice(at, source.indexOf('/>', at));
    expect(editor).toMatch(/\bmentions\b/);
    expect(editor).toMatch(/onMentionQuery=\{setMentionQuery\}/);
  });

  it('offers To and Cc, never Bcc, and leaves out contacts already on the message', () => {
    expect(source).toMatch(/buildMentionCandidates\(toRecipients, ccRecipients\)/);
    const items = source.slice(source.indexOf('const mentionItems'), source.indexOf('const pickMention'));
    expect(items).toMatch(/\.\.\.bccRecipients/);
    expect(items).toMatch(/primaryIdentity\?\.bcc/);
    expect(items).toMatch(/!onMessage\.has\(s\.email\.trim\(\)\.toLowerCase\(\)\)/);
    expect(items).toMatch(/mentionSuggestions\(mentionCandidates, contacts, mentionQuery, mentionAddsRecipientTo === 'cc' \? 'cc' : 'to'\)/);
  });

  it('inserts the picked mention as a mailto link and adds a contact to To', () => {
    const pick = source.slice(source.indexOf('const pickMention'), source.indexOf('const pickMention') + 800);
    expect(pick).toMatch(/editorRef\.current\?\.insertMention\(candidate\.label, mentionHref\(candidate\.email\)\)/);
    expect(pick).toMatch(/setToRecipients\(\(prev\) => addMentionedRecipient\(prev, candidate,/);
    expect(source).toMatch(/<MentionSuggestionList items=\{mentionItems\} onPick=\{pickMention\}/);
  });
});
