import { describe, expect, it } from 'vitest';
import { buildEditorHtml, FOCUS_END_SOURCE } from '../editor-html';
import { LIGHT_COLORS } from '../../theme/tokens';

// On the iPad most of the composer's body area is empty space under the
// editor; a tap there did nothing and the keyboard kept typing into Subject.
// That space now calls the page's focusEnd(), which must put the caret where
// the user's own text goes: in front of the signature or the quoted message.

interface FakeNode { name: string; previousElementSibling?: FakeNode | null }

function run(stop: FakeNode | null) {
  const calls: string[] = [];
  const editor = {
    name: 'editor',
    focus: () => calls.push('focus'),
    querySelector: () => stop,
  };
  const range = {
    selectNodeContents: (n: FakeNode) => calls.push(`select ${n.name}`),
    setStartBefore: (n: FakeNode) => calls.push(`before ${n.name}`),
    collapse: (toStart: boolean) => calls.push(toStart ? 'collapse start' : 'collapse end'),
  };
  const selection = {
    removeAllRanges: () => calls.push('clear'),
    addRange: (r: unknown) => calls.push(r === range ? 'add range' : 'add other'),
  };
  const fakeDocument = { createRange: () => range };
  const fakeWindow = { getSelection: () => selection };
  const focusEnd = new Function('document', 'window', `${FOCUS_END_SOURCE}; return focusEnd;`)(fakeDocument, fakeWindow);
  focusEnd(editor);
  return calls;
}

describe('focusEnd', () => {
  it('puts the caret at the end of the paragraph in front of the signature', () => {
    const mine = { name: 'mine' };
    expect(run({ name: 'signature', previousElementSibling: mine })).toEqual([
      'focus', 'select mine', 'collapse end', 'clear', 'add range',
    ]);
  });

  it('puts the caret in front of a signature or quote that comes first', () => {
    expect(run({ name: 'quote', previousElementSibling: null })).toEqual([
      'focus', 'before quote', 'collapse start', 'clear', 'add range',
    ]);
  });

  it('puts the caret at the end without signature or quote', () => {
    expect(run(null)).toEqual(['focus', 'select editor', 'collapse end', 'clear', 'add range']);
  });

  it('is part of the page script and of its bridge', () => {
    const html = buildEditorHtml({ initialHtml: '<p><br></p>', placeholder: 'Write…', c: LIGHT_COLORS });
    expect(html).toContain('function focusEnd(editor)');
    expect(html).toContain('focusEnd: function () { focusEnd(editor); }');
  });
});
