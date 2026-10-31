import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { showsPaperclip } from '../list-attachments';
import type { Attachment } from '../../api/types';

// A message with nothing but inline images (a signature logo) kept its
// paperclip in the list, and the row grew when its chips arrived (webmail
// attachment-chips.tsx, 7b25d3a95).

const inline = { blobId: 'b1', type: 'image/png', name: 'logo.png', disposition: 'inline', cid: 'logo' } as Attachment;
const file = { blobId: 'b2', type: 'application/pdf', name: 'invoice.pdf' } as Attachment;

describe('list row paperclip and chips', () => {
  it("follows the server's flag until the parts are in, then only real attachments", () => {
    expect(showsPaperclip(true, undefined)).toBe(true);
    expect(showsPaperclip(true, [inline])).toBe(false);
    expect(showsPaperclip(true, [inline, file])).toBe(true);
    expect(showsPaperclip(false, undefined)).toBe(false);
  });

  it('is wired into the row, which holds the chips line while they load', () => {
    const list = fs.readFileSync(path.resolve(__dirname, '../../screens/EmailListScreen.tsx'), 'utf8');
    expect(list).toMatch(/showsPaperclip\(item\.hasAttachment, attachments\)/);
    expect(list).toMatch(/pending=\{!!loadAttachments && item\.hasAttachment && !item\.attachments\}/);
    const chips = fs.readFileSync(path.resolve(__dirname, '../../components/email/ListAttachmentChips.tsx'), 'utf8');
    expect(chips).toMatch(/if \(pending && attachments === undefined\) \{/);
  });
});
