import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { buildEditorHtml } from '../editor-html';
import { linkPromptInput } from '../compose-link';
import { LIGHT_COLORS } from '../../theme/tokens';

// Insert link asks for the text and the address (webmail link-dialog.tsx):
// a text typed for a selection replaces it as the link's text; without one
// the selection becomes the link.

function boot(selectionCollapsed: boolean) {
  const commands: Array<[string, string]> = [];
  const editor = {
    innerHTML: '',
    get textContent() { return this.innerHTML.replace(/<[^>]*>/g, ''); },
    scrollHeight: 100,
    querySelector: () => null,
    setAttribute: () => undefined,
    focus: () => undefined,
    addEventListener: () => undefined,
    getElementsByTagName: () => [],
  };
  const document = {
    activeElement: editor as unknown,
    getElementById: () => editor,
    addEventListener: () => undefined,
    queryCommandState: () => false,
    execCommand: (name: string, _ui: boolean, value: string) => { commands.push([name, value]); return true; },
  };
  const window: Record<string, unknown> = {
    ReactNativeWebView: { postMessage: () => undefined },
    addEventListener: () => undefined,
    getSelection: () => ({ rangeCount: 1, getRangeAt: () => ({ collapsed: selectionCollapsed }) }),
  };
  const html = buildEditorHtml({ initialHtml: '<p><br></p>', placeholder: '', c: LIGHT_COLORS });
  const script = html.match(/<script(?: nonce="[0-9a-f]+")?>([\s\S]*?)<\/script>/)![1];
  new Function('window', 'document', script)(window, document);
  const rne = window.__rne as { insertLink: (url: string, label?: string) => void };
  return { rne, commands };
}

describe('insert link with a text', () => {
  it('links the selection when no text is given', () => {
    const page = boot(false);
    page.rne.insertLink('https://example.com', '');
    expect(page.commands).toEqual([['createLink', 'https://example.com']]);
  });

  it('puts a typed text in place of the selection', () => {
    const page = boot(false);
    page.rne.insertLink('https://example.com', 'our site');
    expect(page.commands).toEqual([['insertHTML', '<a href="https://example.com" rel="noopener noreferrer nofollow">our site</a>']]);
  });

  it('inserts the text, or the address, as a new link without a selection', () => {
    const page = boot(true);
    page.rne.insertLink('https://example.com', 'Tom & Jerry');
    page.rne.insertLink('https://example.com', '');
    expect(page.commands.map(([, v]) => v)).toEqual([
      '<a href="https://example.com" rel="noopener noreferrer nofollow">Tom &amp; Jerry</a>',
      '<a href="https://example.com" rel="noopener noreferrer nofollow">https://example.com</a>',
    ]);
  });

  it('adds https:// to a bare address and refuses one with a space', () => {
    expect(linkPromptInput(' example.com ')).toEqual({ url: 'https://example.com', error: false });
    expect(linkPromptInput('mailto:a@b.c')).toEqual({ url: 'mailto:a@b.c', error: false });
    expect(linkPromptInput('https://')).toEqual({ error: false });
    expect(linkPromptInput('exa mple.com')).toEqual({ error: true });
  });

  // No RN renderer in the suite: the prompt, read from the composer's source.
  it('asks for the text and hands it to the editor', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../screens/ComposeScreen.tsx'), 'utf8');
    expect(src).toMatch(/editorRef\.current\?\.insertLink\(link\.url, linkPromptText\);/);
    expect(src).toMatch(/value=\{linkPromptText\}\s+onChangeText=\{setLinkPromptText\}/);
  });
});
