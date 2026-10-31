import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import PostalMime from 'postal-mime';

// React Native's Blob only takes strings and other Blobs; building one from an
// ArrayBuffer or typed array throws. postal-mime used to join every decoded
// part through such a Blob, so an .eml with an attachment could not be
// previewed on the device (patches/postal-mime+4.2.0.patch).
class ReactNativeBlob {
  constructor(parts: unknown[] = []) {
    if (parts.some((p) => p instanceof ArrayBuffer || ArrayBuffer.isView(p))) {
      throw new Error("Creating blobs from 'ArrayBuffer' and 'ArrayBufferView' are not supported");
    }
  }
}

const MESSAGE = [
  'From: Carol <carol@example.org>',
  'Subject: With parts',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="b1"',
  '',
  '--b1',
  'Content-Type: text/plain; charset=utf-8',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  'Gr=C3=BC=C3=9Fe',
  '--b1',
  'Content-Type: application/octet-stream; name="a.bin"',
  'Content-Transfer-Encoding: base64',
  'Content-Disposition: attachment; filename="a.bin"',
  '',
  'AAECAwQF',
  '--b1',
  'Content-Type: text/plain; name="inner.txt"',
  'Content-Disposition: attachment; filename="inner.txt"',
  '',
  'Inner text.',
  '--b1--',
  '',
].join('\r\n');

describe('postal-mime under React Native', () => {
  const realBlob = globalThis.Blob;
  beforeEach(() => { (globalThis as { Blob: unknown }).Blob = ReactNativeBlob; });
  afterEach(() => { globalThis.Blob = realBlob; });

  it('decodes base64, quoted-printable and plain parts without a Blob', async () => {
    const parsed = await PostalMime.parse(new TextEncoder().encode(MESSAGE), { attachmentEncoding: 'arraybuffer' });
    expect(parsed.text?.trim()).toBe('Grüße');
    const [bin, txt] = parsed.attachments;
    expect(Array.from(new Uint8Array(bin.content as ArrayBuffer))).toEqual([0, 1, 2, 3, 4, 5]);
    expect(new TextDecoder().decode(txt.content as ArrayBuffer).trim()).toBe('Inner text.');
  });
});
