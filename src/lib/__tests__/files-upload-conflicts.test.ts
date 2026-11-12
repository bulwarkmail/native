import { describe, expect, it, vi } from 'vitest';
import { uploadChoices, type ConflictAnswer, type UploadConflict } from '../files-upload-conflicts';

// Webmail 1.21: an upload of a name that is there asks Replace, Keep both or Skip.
const folder = [
  { id: 'f1', name: 'report.pdf', isDirectory: false },
  { id: 'f2', name: 'notes.txt', isDirectory: false },
  { id: 'd1', name: 'Docs', isDirectory: true },
  { id: 'l1', name: 'link', isDirectory: false, isSymlink: true },
];

describe('upload conflicts', () => {
  it('asks only about names a file in the folder has', async () => {
    const ask = vi.fn(async (_c: UploadConflict, _i: number, _n: number): Promise<ConflictAnswer> => ({ choice: 'keep', applyToAll: false }));
    const plan = await uploadChoices(['new.txt', 'Docs', 'link', 'report.pdf'], folder, ask);
    expect(ask.mock.calls.map(([c]) => c.name)).toEqual(['report.pdf']);
    expect(plan).toEqual({ replace: new Map(), skip: new Set() });
  });

  it('replaces and skips as answered, one name at a time', async () => {
    const answers: ConflictAnswer[] = [{ choice: 'replace', applyToAll: false }, { choice: 'skip', applyToAll: false }];
    const plan = await uploadChoices(['report.pdf', 'notes.txt'], folder, async () => answers.shift()!);
    expect(plan?.replace).toEqual(new Map([['report.pdf', 'f1']]));
    expect(plan?.skip).toEqual(new Set(['notes.txt']));
  });

  it('"Do this for all" answers the rest', async () => {
    const ask = vi.fn(async (_c: UploadConflict, _i: number, _n: number): Promise<ConflictAnswer> => ({ choice: 'skip', applyToAll: true }));
    const plan = await uploadChoices(['report.pdf', 'notes.txt'], folder, ask);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0].slice(1)).toEqual([0, 2]);
    expect(plan?.skip).toEqual(new Set(['report.pdf', 'notes.txt']));
  });

  it('calls the whole upload off on Cancel', async () => {
    expect(await uploadChoices(['report.pdf'], folder, async () => null)).toBeNull();
  });
});
