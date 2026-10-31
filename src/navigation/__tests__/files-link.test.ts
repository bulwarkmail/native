import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { handleDeepLink, parseDeepLink } from '../linking';
import { usePendingFilesLink } from '../pending-files-link';

// `/files/<folder>` and `?preview=` links opened only the Files tab (file 10
// "deep links" on the Files row, 07 "Deep link /files/<folder> and ?preview=
// not handled"). Webmail lib/deep-links.ts parseFilesPath.

const nav = () => ({ isReady: () => true, navigate: vi.fn() });

describe('files deep links', () => {
  it('parses the folder path, the file to preview and a shared node', () => {
    expect(parseDeepLink('bulwarkmobile://files')).toEqual({ kind: 'files' });
    expect(parseDeepLink('bulwarkmobile://files/Docs/Q%203'))
      .toEqual({ kind: 'files', path: '/Docs/Q 3' });
    expect(parseDeepLink('https://mail.example.com/de/files/Docs?preview=a%20b.pdf'))
      .toEqual({ kind: 'files', path: '/Docs', preview: 'a b.pdf' });
    expect(parseDeepLink('https://mail.example.com/files?preview=top.txt'))
      .toEqual({ kind: 'files', path: '/', preview: 'top.txt' });
    expect(parseDeepLink('bulwarkmobile://files?shared=acc-2%3An1&preview=x.txt'))
      .toEqual({ kind: 'files', path: '/', shared: 'acc-2:n1', preview: 'x.txt' });
  });

  it('parks the link for the Files tab', async () => {
    const navigation = nav();
    await handleDeepLink(parseDeepLink('bulwarkmobile://files/Docs?preview=a.pdf')!, {
      navigation: navigation as never, resolveThreadId: async () => null,
    });
    expect(usePendingFilesLink.getState().consume()).toEqual({ path: '/Docs', preview: 'a.pdf' });
    expect(navigation.navigate).toHaveBeenCalledWith('MainTabs', { screen: 'Files' });

    await handleDeepLink(parseDeepLink('bulwarkmobile://files')!, {
      navigation: navigation as never, resolveThreadId: async () => null,
    });
    expect(usePendingFilesLink.getState().consume()).toBeNull();
  });

  // No RN renderer in the test env: check the screen's wiring instead.
  it('is followed by the Files tab once the drive is listed', () => {
    const screen = fs.readFileSync(path.resolve(__dirname, '../../screens/FilesScreen.tsx'), 'utf8');
    expect(screen).toMatch(/if \(!pendingFilesLink \|\| loading \|\| !driveRef\.current\?\.account\) return;\s*const link = usePendingFilesLink\.getState\(\)\.consume\(\);/);
    expect(screen).toMatch(/stack = resolveFolderPath\(driveNodes\.filter\(\(n\) => !n\.isShared\), link\.path\);/);
    expect(screen).toMatch(/listFolder\(driveNodes, parentId\)\.find\(\(n\) => n\.name === link\.preview && !isFolder\(n\)\)/);
    expect(screen).toMatch(/if \(row && !isSymlink\(row\) && canPreviewInApp\(row\)\) openPreview\(row\);/);
  });
});
