// Latin-1 parts of a decrypted message on the device (#98). The app's
// TextDecoder (Expo's polyfill) knows only UTF-8; postal-mime asks for
// windows-1252 and falls back to UTF-8, which shows U+FFFD for every
// accented letter. Its own file: postal-mime keeps the decoders it made, so
// the stand-in must be in place before postal-mime first loads.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as openpgp from 'openpgp';
import { openSecureMessage, type SecureKeyAccess } from '../secure-message';
import { wrapPgpEncrypted } from '../mime';
import { decodeWindows1252, installWindows1252Decoder } from '../../single-byte-text-decoder';
import { makePgpKey, useNodeCrypto } from './helpers';

const NodeTextDecoder = globalThis.TextDecoder;

/** Like expo/src/winter/TextDecoder.ts: a RangeError for any label but UTF-8. */
class Utf8OnlyTextDecoder extends NodeTextDecoder {
  constructor(label = 'utf-8', options?: TextDecoderOptions) {
    if (!['utf-8', 'utf8', 'unicode-1-1-utf-8'].includes(String(label).trim().toLowerCase())) {
      throw new RangeError(`Unknown encoding: ${label}`);
    }
    super('utf-8', options);
  }
}

beforeAll(() => {
  useNodeCrypto();
  vi.stubGlobal('TextDecoder', Utf8OnlyTextDecoder);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('Latin-1 on a UTF-8-only TextDecoder', () => {
  it('decodes iso-8859-1 and windows-1252 quoted-printable parts of a decrypted message', async () => {
    const bob = await makePgpKey('bob@example.org');
    const inner = [
      'From: "Example" <news@example.com>',
      'To: <reader@example.org>',
      'HP-Outer: From: "Example" <news@example.com>',
      'HP-Outer: To: <reader@example.org>',
      'Content-Type: multipart/alternative; boundary=b1; hp="cipher"',
      '',
      '--b1',
      'Content-Transfer-Encoding: quoted-printable',
      'Content-Type: text/plain; charset="iso-8859-1"',
      '',
      'Gr=FC=DFe aus dem Caf=E9 =96 I=92m here.',
      '--b1--',
      '',
    ].join('\r\n');
    const armored = await openpgp.encrypt({
      message: await openpgp.createMessage({ binary: new TextEncoder().encode(inner) }),
      encryptionKeys: await openpgp.readKey({ armoredKey: bob.publicKey }),
    });
    const raw = wrapPgpEncrypted(armored as string, { from: { email: 'news@example.com' }, to: [{ email: 'reader@example.org' }], subject: '...' });
    const keys: SecureKeyAccess = {
      pgpDecryptionKeys: () => [bob.unlocked],
      pgpOwnKeys: () => [{ id: 'bob', publicKeyArmored: bob.publicKey, unlocked: true }],
      pgpPublicKeys: () => [],
      smimeKeys: () => [],
    };

    const res = await openSecureMessage(raw, 'news@example.com', keys);
    expect(res?.status).toMatchObject({ decrypted: true });
    expect(res?.body?.text).toBe('Grüße aus dem Café – I’m here.');
  }, 30_000);

  it('leaves UTF-8 to the runtime decoder and wraps it only once', () => {
    const target: { TextDecoder?: typeof TextDecoder } = { TextDecoder: Utf8OnlyTextDecoder };
    installWindows1252Decoder(target);
    const Wrapped = target.TextDecoder!;
    expect(Wrapped).not.toBe(Utf8OnlyTextDecoder);
    installWindows1252Decoder(target);
    expect(target.TextDecoder).toBe(Wrapped);

    expect(new Wrapped('ISO-8859-1').encoding).toBe('windows-1252');
    expect(new Wrapped('latin1').decode(new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x80]))).toBe('café€');
    expect(new Wrapped().decode(new TextEncoder().encode('café €'))).toBe('café €');
    expect(() => new Wrapped('shift_jis')).toThrow(RangeError);
    expect(decodeWindows1252(new Uint8Array([0x81, 0x9f, 0xff]))).toBe('\u0081Ÿÿ');
  });

  it('wraps a decoder that takes the windows-1252 label but decodes plain ISO-8859-1', () => {
    // Node 20: 0x92 comes out as U+0092 instead of a right single quote.
    class Latin1AsWindows1252 extends NodeTextDecoder {
      private readonly latin1: boolean;
      constructor(label = 'utf-8', options?: TextDecoderOptions) {
        const latin1 = String(label).trim().toLowerCase() === 'windows-1252';
        super(latin1 ? 'utf-8' : label, options);
        this.latin1 = latin1;
      }
      decode(input?: AllowSharedBufferSource): string {
        if (!this.latin1) return super.decode(input);
        const bytes = ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : new Uint8Array(input ?? new ArrayBuffer(0));
        return String.fromCharCode(...bytes);
      }
    }
    const target: { TextDecoder?: typeof TextDecoder } = { TextDecoder: Latin1AsWindows1252 };
    installWindows1252Decoder(target);
    expect(target.TextDecoder).not.toBe(Latin1AsWindows1252);
    expect(new target.TextDecoder!('windows-1252').decode(new Uint8Array([0x49, 0x92, 0x6d]))).toBe('I’m');
  });
});
