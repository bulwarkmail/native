import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { templateFromComposer } from '../compose-template';

// "Save as template" from the composer (webmail #1506): templates could only
// be made in Settings.

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '..', '..', rel), 'utf8');

describe('save as template', () => {
  it('keeps an HTML message as HTML and a plain one as text', () => {
    expect(templateFromComposer({ name: ' Check-in ', subject: 'Your stay', body: '<p><b>Hi</b></p>', plainTextMode: false }))
      .toEqual({ template: { name: 'Check-in', subject: 'Your stay', body: '<p><b>Hi</b></p>', isHTML: true, category: '', isFavorite: false } });
    expect(templateFromComposer({ name: 'Plain', subject: '', body: 'Hi', plainTextMode: true }))
      .toMatchObject({ template: { isHTML: false, body: 'Hi' } });
  });

  it('needs a name of at most 200 characters', () => {
    expect(templateFromComposer({ name: '  ', subject: '', body: '', plainTextMode: false })).toEqual({ error: 'empty' });
    expect(templateFromComposer({ name: 'x'.repeat(201), subject: '', body: '', plainTextMode: false })).toEqual({ error: 'too_long' });
  });

  // No RN renderer in the suite: the wiring, read from the source.
  it('is offered in the composer options when templates are on', () => {
    expect(read('components/compose/ComposerOptionsSheet.tsx'))
      .toMatch(/\{onSaveAsTemplate && \([\s\S]{0,200}<Pressable style=\{styles\.row\} onPress=\{onSaveAsTemplate\}/);
    const src = read('screens/ComposeScreen.tsx');
    expect(src).toMatch(/onSaveAsTemplate=\{templatesEnabled \? openSaveAsTemplate : undefined\}/);
    expect(src).toMatch(/setSaveTemplateName\(subject\.trim\(\)\);/);
    expect(src).toMatch(/addTemplate\(made\.template\);/);
  });
});
