import { describe, it, expect } from 'vitest';
import { stripBidiControls } from '../bidi';
import { getAttachmentDisplayName } from '../attachment-display';

// A sender-chosen attachment name kept its direction-override characters,
// so `report<U+202E>fdp.exe` showed as `reportexe.pdf`: an executable
// dressed up as a PDF (webmail lib/bidi.ts).

const ch = (code: number) => String.fromCharCode(code);
const RLO = ch(0x202e);

describe('direction-override characters in attachment names', () => {
  it('strips the embeddings, overrides, isolates and LRM/RLM marks', () => {
    const controls = [0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069].map(ch).join('');
    expect(stripBidiControls(`a${controls}b`)).toBe('ab');
    // Hebrew and Arabic letters stay.
    expect(stripBidiControls('שלום.pdf')).toBe('שלום.pdf');
  });

  it('shows the real extension in the chip name', () => {
    expect(getAttachmentDisplayName(`report${RLO}fdp.exe`, 'application/octet-stream')).toBe('reportfdp.exe');
    // A name of nothing but controls falls back to the type label.
    expect(getAttachmentDisplayName(RLO, 'application/pdf')).toBe('Document.pdf');
  });
});
