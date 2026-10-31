import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// "Plain Text Only" reads "Compose and read in plain text only", but only the
// composer honoured it: the reader always showed the HTML. The webmail reads
// HTML mail as plain text by default or per message (1e929b0a9). The
// conversion itself is tested in lib/__tests__/html-to-readable-text.test.ts;
// this checks the reader is wired to it.

const src = (p: string) => fs.readFileSync(path.resolve(__dirname, '..', '..', p), 'utf8');

describe('plain-text reading', () => {
  it('renders the plain-text reading when the setting or the per-message switch is on', () => {
    const body = src('components/EmailBodyView.tsx');
    expect(body).toMatch(/useSettingsStore\(\(s\) => s\.plainTextMode\)/);
    expect(body).toMatch(/const plainView = plainViewOverride \?\? plainTextMode;/);
    expect(body).toMatch(/plainTextReading\(\{ html: formattedHtml, text: picked\.text \}\)/);
    // The document is built from the text, not the HTML, while it is on.
    expect(body).toMatch(/const rawHtml = plainText !== null \? null : formattedHtml;/);
    expect(body).toMatch(/email_viewer\.shown_as_plain_text/);
  });

  it('offers "Show as plain text" per message in the More sheet and passes it to every card', () => {
    const screen = src('screens/EmailThreadScreen.tsx');
    expect(screen).toMatch(/email_viewer\.show_as_plain_text/);
    expect(screen).toMatch(/plainView=\{plainOverrides\[m\.id\] \?\? null\}/);
    expect(src('components/email/MessageContent.tsx')).toMatch(/plainView=\{plainView\}/);
  });
});
