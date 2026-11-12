import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { signatureEditorSeed, signatureFromHtml, textFromSignatureHtml, textToParagraphHtml } from '../signature-edit';

// The HTML signature was edited as raw HTML code. It now opens in the
// composer's formatting editor, and the plain-text part is made from it
// (webmail components/identity/signature-editor.tsx).

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '..', '..', rel), 'utf8');

describe('signature editing', () => {
  it('makes the plain-text part from the formatted signature', () => {
    expect(signatureFromHtml('<p><b>Jane Doe</b><br>Bulwark &amp; Co</p>')).toEqual({
      htmlSignature: '<p><b>Jane Doe</b><br>Bulwark &amp; Co</p>',
      textSignature: 'Jane Doe\nBulwark & Co',
    });
    expect(textFromSignatureHtml('<script>x</script>')).toBe('');
  });

  it('clears both parts when the editor is left empty, but keeps a picture alone', () => {
    expect(signatureFromHtml('<p><br></p>')).toEqual({ htmlSignature: '', textSignature: '' });
    expect(signatureFromHtml('<p><img src="https://x.test/logo.png"></p>').htmlSignature).toContain('<img');
  });

  it('opens a text-only signature in the editor as paragraphs', () => {
    expect(textToParagraphHtml('Jane <Doe>\nBulwark\n\nSecond')).toBe('<p>Jane &lt;Doe&gt;<br>Bulwark</p><p>Second</p>');
    expect(signatureEditorSeed('', 'Jane')).toBe('<p>Jane</p>');
    expect(signatureEditorSeed('<p>Html</p>', 'Jane')).toBe('<p>Html</p>');
  });

  // No RN renderer in the suite: the wiring, read from the source.
  it('edits the signature in the formatting editor, with the HTML source one tap away', () => {
    const settings = read('components/settings/IdentitySettings.tsx');
    expect(settings).toMatch(/<SignatureEditor\s+key=\{editing\.id \|\| 'new'\}\s+html=\{editing\.htmlSignature\}\s+text=\{editing\.textSignature\}\s+plainOnly=\{plainTextMode\}/);
    expect(settings).not.toMatch(/placeholder="<p><b>Jane Doe<\/b><br>Bulwark Mail<\/p>"/);
    const editor = read('components/settings/SignatureEditor.tsx');
    expect(editor).toMatch(/<RichTextEditor\s+key=\{seed\.version\}\s+ref=\{editorRef\}\s+initialHtml=\{seed\.html\}\s+onChange=\{editHtml\}/);
    expect(editor).toMatch(/const editHtml = \(value: string\) => onChange\(signatureFromHtml\(value\)\);/);
  });
});
