import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { checkNewTag, composeKeywordId, MAX_KEYWORD_ID_LENGTH, newTagDefinition } from '../new-tag';
import { DEFAULT_KEYWORDS } from '../../stores/keywords-store';

// The tag pickers listed existing tags only; a new one meant a trip to
// Settings (webmail tag-picker.tsx "New tag", 19676a14f).

describe('new tag from the tag picker', () => {
  it('makes the id the way the webmail does', () => {
    expect(composeKeywordId(null, '  Client Acme / 2026! ')).toBe('client-acme-2026');
    expect(composeKeywordId('work', 'Clients')).toBe('work/clients');
    expect(composeKeywordId(null, '!!!')).toBe('');
  });

  it('refuses an existing id and a name with no id or too long a one', () => {
    expect(checkNewTag('Red', DEFAULT_KEYWORDS).error).toBe('tag_exists');
    expect(checkNewTag('???', DEFAULT_KEYWORDS).error).toBe('tag_name_invalid');
    expect(checkNewTag('x'.repeat(MAX_KEYWORD_ID_LENGTH + 1), DEFAULT_KEYWORDS).error).toBe('tag_name_invalid');
    expect(checkNewTag('', DEFAULT_KEYWORDS).error).toBeNull();
    expect(newTagDefinition('Red', DEFAULT_KEYWORDS)).toBeNull();
  });

  it('gives the new tag the next colour of the palette row', () => {
    // Seven default tags: index 7 of red, orange, amber, yellow, lime, green, teal, cyan…
    expect(newTagDefinition(' Invoices ', DEFAULT_KEYWORDS)).toEqual({ id: 'invoices', label: 'Invoices', color: 'cyan' });
    expect(newTagDefinition('First', [])?.color).toBe('red');
  });

  it('is offered in the list tag sheet and the message tag sheet, and applies the tag', () => {
    const src = (p: string) => fs.readFileSync(path.resolve(__dirname, '../..', p), 'utf8');
    expect(src('components/TagSheet.tsx')).toMatch(/<NewTagRow keywords=\{keywords\} onCreated=\{\(token\) => onToggle\(token, true\)\} \/>/);
    expect(src('screens/EmailThreadScreen.tsx')).toMatch(/<NewTagRow keywords=\{keywords\} onCreated=\{onToggle\} \/>/);
    const row = src('components/NewTagRow.tsx');
    expect(row).toMatch(/addKeyword\(def\);/);
    expect(row).toMatch(/onCreated\(keywordToken\(def\.id\)\);/);
  });
});
