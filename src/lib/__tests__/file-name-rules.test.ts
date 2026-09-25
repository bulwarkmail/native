import { describe, it, expect } from 'vitest';
import { acceptedFileName, fileNameProblem, fileNameRulesFrom } from '../file-name-rules';

const RESERVED = [
  '.', '..', 'CON', 'PRN', 'AUX', 'NUL', 'COM0', 'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7',
  'COM8', 'COM9', 'LPT0', 'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
];

// The filenode capability Stalwart 0.16.23 publishes.
const STALWART_016 = fileNameRulesFrom({
  maxFileNodeDepth: null,
  maxSizeFileNodeName: 255,
  forbiddenNameChars: '/<>:"\\|?*',
  forbiddenNodeNames: RESERVED,
});

// Stalwart 1.0 publishes the same rules (plus a depth limit) but also refuses
// reserved stems and control characters, which the capability doesn't say.
const STALWART_10 = fileNameRulesFrom({
  maxFileNodeDepth: 64,
  maxSizeFileNodeName: 255,
  forbiddenNameChars: '/<>:"\\|?*',
  forbiddenNodeNames: RESERVED,
});

describe('file name rules', () => {
  it('has no rules for servers that publish none (Stalwart before 0.16.6)', () => {
    expect(fileNameRulesFrom({ maxSizeFileNodeName: 255 })).toBeNull();
    expect(fileNameProblem('a:b', null)).toBeNull();
    expect(acceptedFileName('a:b', null)).toBe('a:b');
  });

  it('reads the byte limit from the capability', () => {
    expect(STALWART_10?.maxNameBytes).toBe(255);
    expect(fileNameRulesFrom({ forbiddenNameChars: '/', maxSizeFileNodeName: 100 })?.maxNameBytes).toBe(100);
    expect(fileNameRulesFrom({ forbiddenNameChars: '/' })?.maxNameBytes).toBe(255);
  });

  it('reports forbidden characters and reserved names on 0.16', () => {
    expect(fileNameProblem('bad:name?.txt', STALWART_016)).toEqual({ kind: 'chars', chars: ': ?' });
    expect(fileNameProblem('con', STALWART_016)).toEqual({ kind: 'reserved' });
    expect(fileNameProblem('report.pdf', STALWART_016)).toBeNull();
  });

  // The cases of Stalwart 1.0's own `reserved_names` test (jmap/src/file/node.rs).
  it('refuses reserved names and reserved stems the way Stalwart 1.0 does', () => {
    for (const name of ['CON', 'con.txt', 'Aux.tar.gz', '..', '.', 'LPT9.log']) {
      expect(fileNameProblem(name, STALWART_10), name).toEqual({ kind: 'reserved' });
    }
    for (const name of ['console.txt', '.bashrc', 'auxiliary', 'com10', 'a.con', 'ok name (1).txt']) {
      expect(fileNameProblem(name, STALWART_10), name).toBeNull();
    }
  });

  it('applies the stem rule on 0.16 too, as 1.0 would refuse the name later', () => {
    expect(fileNameProblem('CON.txt', STALWART_016)).toEqual({ kind: 'reserved' });
  });

  it('refuses control characters (Rust char::is_control) as Stalwart 1.0 does', () => {
    expect(fileNameProblem('a\u0001b', STALWART_10)).toEqual({ kind: 'control' });
    // macOS stores custom folder icons as "Icon\r".
    expect(fileNameProblem('Icon\r', STALWART_10)).toEqual({ kind: 'control' });
    expect(fileNameProblem('a\u007fb', STALWART_10)).toEqual({ kind: 'control' });
    expect(fileNameProblem('next\u0085line', STALWART_10)).toEqual({ kind: 'control' });
    // Not a control character.
    expect(fileNameProblem('no break', STALWART_10)).toBeNull();
  });

  it('refuses names over 255 bytes of UTF-8, as every Stalwart release does', () => {
    expect(fileNameProblem('a'.repeat(256), STALWART_10)).toEqual({ kind: 'tooLong' });
    expect(fileNameProblem('a'.repeat(255), STALWART_10)).toBeNull();
    // 128 x 2 bytes.
    expect(fileNameProblem('é'.repeat(128), STALWART_016)).toEqual({ kind: 'tooLong' });
    expect(fileNameProblem('é'.repeat(127), STALWART_016)).toBeNull();
  });

  it('turns an uploaded name into one the server accepts', () => {
    expect(acceptedFileName('bad:name?.txt', STALWART_10)).toBe('bad_name_.txt');
    expect(acceptedFileName('NUL', STALWART_10)).toBe('NUL_');
    expect(acceptedFileName('fine.txt', STALWART_10)).toBe('fine.txt');
  });

  it('puts the "_" after a reserved stem, where Stalwart 1.0 looks', () => {
    expect(acceptedFileName('con.txt', STALWART_10)).toBe('con_.txt');
    expect(acceptedFileName('Aux.tar.gz', STALWART_10)).toBe('Aux_.tar.gz');
    expect(acceptedFileName('LPT9.log', STALWART_10)).toBe('LPT9_.log');
    expect(acceptedFileName('..', STALWART_10)).toBe('.._');
    expect(acceptedFileName('.', STALWART_10)).toBe('._');
    for (const name of ['console.txt', '.bashrc', 'auxiliary', 'com10', 'a.con']) {
      expect(acceptedFileName(name, STALWART_10), name).toBe(name);
    }
  });

  it('replaces control characters', () => {
    expect(acceptedFileName('Icon\r', STALWART_10)).toBe('Icon_');
    expect(acceptedFileName('a\u0085b.txt', STALWART_10)).toBe('a_b.txt');
  });

  it('shortens a name to 255 bytes and keeps its extension', () => {
    const long = acceptedFileName(`${'a'.repeat(300)}.txt`, STALWART_10);
    expect(new TextEncoder().encode(long).length).toBe(255);
    expect(long.endsWith('.txt')).toBe(true);

    // Whole characters only: a 2-byte "é" is not split.
    const accented = acceptedFileName(`${'é'.repeat(200)}.pdf`, STALWART_10);
    expect(accented).toBe(`${'é'.repeat(125)}.pdf`);

    // An "extension" too long to keep goes with the rest.
    expect(acceptedFileName(`a.${'b'.repeat(300)}`, STALWART_10)).toBe(`a.${'b'.repeat(253)}`);
  });

  it('keeps a name at the byte limit acceptable when its stem is reserved', () => {
    // 3 + 1 + 251 = 255 bytes: no room to add "_" after "con".
    const accepted = acceptedFileName(`con.${'x'.repeat(251)}`, STALWART_10);
    expect(accepted).toBe(`co_.${'x'.repeat(251)}`);
    expect(fileNameProblem(accepted, STALWART_10)).toBeNull();
  });

  it('only produces names the rules accept', () => {
    const awkward = [
      'con.txt', 'Icon\r', 'a:b|c', '..', `${'z'.repeat(400)}.docx`, `CON.${'y'.repeat(260)}`, 'tab\there', 'prn',
    ];
    for (const name of awkward) {
      expect(fileNameProblem(acceptedFileName(name, STALWART_10), STALWART_10), JSON.stringify(name)).toBeNull();
    }
  });
});
