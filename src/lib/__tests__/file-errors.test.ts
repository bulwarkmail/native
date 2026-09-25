import { describe, it, expect } from 'vitest';
import { fileErrorKind, fileErrorMessage } from '../file-errors';
import { JMAPMethodError, JMAPSetError } from '../../api/jmap-result';

// SetErrors as Stalwart words them (1.0: jmap/src/file/*.rs; 0.16.23:
// jmap/src/file/set.rs), thrown by the files API as JMAPSetErrors.
const setError = (type: string, description: string, properties?: string[]) =>
  new JMAPSetError(type, description, properties);

describe('fileErrorKind', () => {
  it('explains Stalwart 1.0\'s limits on files and folders', () => {
    expect(fileErrorKind(setError('overQuota', 'There are too many files, please delete some before adding a new one.'))).toBe('overQuota');
    expect(fileErrorKind(setError('overQuota', 'There are too many folders, please delete some before adding a new one.'))).toBe('overQuota');
    expect(fileErrorKind(setError('invalidProperties', 'Maximum folder depth exceeded.', ['parentId']))).toBe('tooDeep');
    expect(fileErrorKind(setError('tooLarge', 'File is too large.'))).toBe('tooLarge');
  });

  it('explains refused names on 0.16 and 1.0', () => {
    expect(fileErrorKind(setError('invalidProperties', 'Name is reserved and cannot be used.', ['name']))).toBe('invalidName');
    expect(fileErrorKind(setError('invalidProperties', 'Name contains a forbidden character.', ['name']))).toBe('invalidName');
    expect(fileErrorKind(setError('invalidProperties', 'Name must be between 1 and 255 octets.', ['name']))).toBe('invalidName');
  });

  it('explains missing rights, also as a method error', () => {
    expect(fileErrorKind(setError('forbidden', 'You are not allowed to create file nodes in this folder.'))).toBe('forbidden');
    expect(fileErrorKind(new JMAPMethodError('forbidden', 'No write access'))).toBe('forbidden');
  });

  it('has nothing to add for other errors', () => {
    // The folder is gone, or a folder was moved into itself.
    expect(fileErrorKind(setError('invalidProperties', 'Parent ID does not exist or is not a folder.', ['parentId']))).toBeNull();
    expect(fileErrorKind(setError('invalidProperties', 'Circular reference in parent ids.', ['parentId']))).toBeNull();
    expect(fileErrorKind(setError('notFound', 'Not found'))).toBeNull();
    expect(fileErrorKind(new Error('Upload failed: 500'))).toBeNull();
    expect(fileErrorKind(undefined)).toBeNull();
  });
});

describe('fileErrorMessage', () => {
  const t = (key: string, fallback?: string) => fallback ?? key;

  it('says what a known refusal means', () => {
    expect(fileErrorMessage(setError('invalidProperties', 'Name is reserved and cannot be used.', ['name']), t))
      .toBe('The server does not accept this name.');
    expect(fileErrorMessage(setError('overQuota', 'There are too many files'), t))
      .toBe('You have reached the limit on files or folders. Delete some and try again.');
  });

  it('shows the server\'s own words for anything else', () => {
    expect(fileErrorMessage(new Error('Upload failed: 413 too big'), t)).toBe('Upload failed: 413 too big');
    expect(fileErrorMessage('boom', t)).toBe('boom');
  });
});
