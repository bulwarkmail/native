import { describe, it, expect } from 'vitest';
import { normalizeRemoteUrl, buildSourceLink, REPO_URL } from '../source-link';

const SHA = 'a'.repeat(40);

describe('normalizeRemoteUrl', () => {
  it.each([
    ['git@github.com:wkennedy/native.git', 'https://github.com/wkennedy/native'],
    ['git@github.com:wkennedy/native', 'https://github.com/wkennedy/native'],
    ['https://github.com/wkennedy/native.git', 'https://github.com/wkennedy/native'],
    ['https://github.com/wkennedy/native/', 'https://github.com/wkennedy/native'],
    ['https://user:token@github.com/wkennedy/native.git', 'https://github.com/wkennedy/native'],
    ['ssh://git@github.com/wkennedy/native.git', 'https://github.com/wkennedy/native'],
    ['ssh://git@github.com:22/wkennedy/native.git', 'https://github.com/wkennedy/native'],
    ['git@gitlab.example.org:group/sub/repo.git', 'https://gitlab.example.org/group/sub/repo'],
    ['git://github.com/wkennedy/native.git', 'https://github.com/wkennedy/native'],
  ])('%s', (input, out) => {
    expect(normalizeRemoteUrl(input)).toBe(out);
  });

  it.each([
    '', '   ', 'not a url', 'http://github.com/a/b', 'javascript:alert(1)',
    'file:///home/x/repo', '/home/x/repo', '../repo', 'https://github.com/only-owner',
  ])('rejects %j', (input) => {
    expect(normalizeRemoteUrl(input)).toBeUndefined();
  });

  it('rejects non-string input', () => {
    expect(normalizeRemoteUrl(undefined)).toBeUndefined();
    expect(normalizeRemoteUrl(5)).toBeUndefined();
  });
});

describe('buildSourceLink', () => {
  it('links the commit when both are known', () => {
    expect(buildSourceLink('https://github.com/wkennedy/native', SHA))
      .toBe(`https://github.com/wkennedy/native/commit/${SHA}`);
  });
  it('falls back to the repository without a commit', () => {
    expect(buildSourceLink('https://github.com/wkennedy/native', undefined))
      .toBe('https://github.com/wkennedy/native');
    expect(buildSourceLink('https://github.com/wkennedy/native', 'dev'))
      .toBe('https://github.com/wkennedy/native');
  });
  it('falls back to the default repo without a source url', () => {
    expect(buildSourceLink(undefined, SHA)).toBe(REPO_URL);
    expect(buildSourceLink('', '')).toBe(REPO_URL);
  });
  it('never returns a non-https url', () => {
    expect(buildSourceLink('http://github.com/a/b', SHA)).toBe(REPO_URL);
    expect(buildSourceLink('javascript:alert(1)', SHA)).toBe(REPO_URL);
    expect(buildSourceLink('https://github.com/a/b', 'x/../../y')).toBe('https://github.com/a/b');
  });
});
