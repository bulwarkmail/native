import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { descriptionAsText, descriptionFieldsToSave } from '../calendar-description';

// Webmail 1.20: an HTML description showed its markup, and an edit kept it
// labelled text/html, so other clients ran its lines together.
const html = {
  description: '<p>Agenda</p><p>1. Budget<br>2. <b>Hiring</b></p>',
  descriptionContentType: 'text/html',
};

describe('event descriptions stored as HTML', () => {
  it('shows and edits the text, not the markup', () => {
    const text = descriptionAsText(html);
    expect(text).not.toMatch(/<\/?[a-z]/i);
    expect(text).toContain('Agenda');
    expect(text).toContain('2. Hiring');
  });

  it('leaves a plain description as it is', () => {
    expect(descriptionAsText({ description: 'a <b> c' })).toBe('a <b> c');
  });

  it('saves an edited HTML description as text labelled text/plain', () => {
    expect(descriptionFieldsToSave(html, 'Agenda\n\nBudget only', true))
      .toEqual({ description: 'Agenda\n\nBudget only', descriptionContentType: 'text/plain' });
  });

  it('sends nothing for an HTML description the user did not touch', () => {
    expect(descriptionFieldsToSave(html, descriptionAsText(html), true)).toEqual({});
  });

  // No render setup in the repo: the editor and the detail sheet are checked
  // for using the helpers above.
  it('is what the detail sheet shows and what the editor loads and saves', () => {
    const read = (rel: string) => readFileSync(join(__dirname, '../../components/calendar', rel), 'utf-8');
    expect(read('EventDetailSheet.tsx')).toMatch(/text=\{descriptionAsText\(event\)\}/);
    const modal = read('EventModal.tsx');
    expect(modal).toMatch(/setDescription\(descriptionAsText\(event\)\);/);
    expect(modal).toMatch(/\.\.\.descriptionFieldsToSave\(event, description, isEdit\),/);
    expect(modal).not.toMatch(/description: description\.trim\(\)/);
  });

  it('gives a plain or untyped description no type, and clears one that was emptied', () => {
    expect(descriptionFieldsToSave({ description: 'x' }, 'y', true)).toEqual({ description: 'y' });
    expect(descriptionFieldsToSave({ description: 'x' }, '  ', true)).toEqual({ description: '' });
    expect(descriptionFieldsToSave(null, '', false)).toEqual({});
  });
});
