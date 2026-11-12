import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  checkNewTag, chooseKeywordId, composeKeywordId, generatedKeywordLevel, isKeywordNameTaken, MAX_KEYWORD_ID_LENGTH, newTagDefinition,
} from '../new-tag';
import { DEFAULT_KEYWORDS } from '../../stores/keywords-store';

// The tag pickers listed existing tags only; a new one meant a trip to
// Settings (webmail tag-picker.tsx "New tag", 19676a14f).

describe('new tag from the tag picker', () => {
  it('makes the id the way the webmail does', () => {
    expect(composeKeywordId(null, '  Client Acme / 2026! ')).toBe('client-acme-2026');
    expect(composeKeywordId('work', 'Clients')).toBe('work/clients');
    expect(composeKeywordId(null, '!!!')).toBe('');
  });

  it('refuses an existing name and too long an id', () => {
    expect(checkNewTag('Red', DEFAULT_KEYWORDS).error).toBe('tag_exists');
    expect(checkNewTag('x'.repeat(MAX_KEYWORD_ID_LENGTH + 1), DEFAULT_KEYWORDS).error).toBe('tag_name_invalid');
    expect(checkNewTag('', DEFAULT_KEYWORDS).error).toBeNull();
    expect(newTagDefinition('Red', DEFAULT_KEYWORDS)).toBeNull();
  });

  // #1613: "Работа" slugged to nothing and Save stayed off; "Банк 1" and
  // "Счета 1" both slugged to "1".
  it('gives a name without a slug of its own a generated id', () => {
    for (const name of ['Работа', 'Εργασία', 'عمل', '工作', '업무', '???']) {
      const { id, error } = checkNewTag(name, DEFAULT_KEYWORDS);
      expect(error).toBeNull();
      expect(id).toMatch(/^tag-[0-9a-z]+$/);
    }
    expect(newTagDefinition('Работа', [])).toEqual({ id: generatedKeywordLevel('Работа'), label: 'Работа', color: 'red' });
    expect(chooseKeywordId(null, 'Работа', [])).toBe(chooseKeywordId(null, ' работа ', []));
    expect(chooseKeywordId(null, 'Работа', [])).not.toBe(chooseKeywordId(null, 'Счета', []));
  });

  it("doesn't hand a second name the slug another tag already has", () => {
    const bank = [{ id: '1', label: 'Банк 1' }];
    expect(checkNewTag('Банк 1', []).id).toBe('1');
    expect(checkNewTag('Счета 1', bank)).toEqual({ id: generatedKeywordLevel('Счета 1'), error: null });
    const level = generatedKeywordLevel('Работа');
    expect(chooseKeywordId(null, 'Работа', [level])).toBe(`${level}-2`);
    expect(chooseKeywordId(null, 'Work', ['WORK'])).not.toBe('work');
    expect(chooseKeywordId('work', 'Клиенты', ['work'])).toBe(`work/${generatedKeywordLevel('Клиенты')}`);
  });

  it('refuses the same name twice under one parent, not the same slug', () => {
    const tags = [{ id: 'tag-abc', label: 'Работа' }, { id: 'work/x', label: 'Clients' }];
    expect(checkNewTag(' работа ', tags).error).toBe('tag_exists');
    expect(isKeywordNameTaken(tags, null, 'Clients')).toBe(false);
    expect(isKeywordNameTaken(tags, 'work', 'clients')).toBe(true);
    expect(isKeywordNameTaken(tags, 'work', 'clients', 'work/x')).toBe(false);
  });

  it('keeps the id of an edited tag that stays in place', () => {
    expect(chooseKeywordId(null, 'Красный', ['blue'], 'red')).toBe('red');
    expect(chooseKeywordId(null, 'RED!', [], 'red', 'Red')).toBe('red');
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
