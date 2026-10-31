import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// List chips showed a typed, coloured icon per file; the reader's chips a
// grey paperclip for everything (webmail a78d03a18 uses the list's icons in
// the reader too).

const src = (p: string) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');

describe('reader attachment chip icons', () => {
  it('draws the same typed icon and colour as the list chips', () => {
    const reader = src('email/AttachmentChips.tsx');
    expect(reader).not.toMatch(/<Paperclip /);
    expect(reader).toMatch(/const kind = attachmentKind\(item\.type, item\.name\);/);
    expect(reader).toMatch(/<Icon size=\{14\} color=\{attachmentIconColor\(kind, c\)\} \/>/);
    const list = src('email/ListAttachmentChips.tsx');
    expect(list).toMatch(/ATTACHMENT_ICONS\[kind\]/);
    expect(list).toMatch(/attachmentIconColor\(kind, c\)/);
  });
});
