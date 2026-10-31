import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { FileNode } from '../../api/types';
import {
  RECENT_FILES_MAX,
  addRecentFile,
  dropFavoritesUnder,
  folderPathOf,
  moveFavorites,
  nodePlace,
  pruneRecentFiles,
  resolveFolderPath,
  toggleFavorite,
} from '../files-places';
import { NO_FILES_PLACES, useFilesPlacesStore } from '../../stores/files-places-store';

// The Files tab had no starred folders or recent files (file 10 "starred and
// recent"). Webmail stores/file-store.ts favorites / recentFiles,
// navigateByPath and revealNode.

const folder = (id: string, name: string, parentId: string | null = null, extra: Partial<FileNode> = {}) =>
  ({ id, name, parentId, blobId: null, ...extra }) as FileNode;
const file = (id: string, name: string, parentId: string | null = null, extra: Partial<FileNode> = {}) =>
  ({ id, name, parentId, blobId: `b-${id}`, ...extra }) as FileNode;

const nodes: FileNode[] = [
  folder('d1', 'Docs'),
  folder('d2', 'Sub', 'd1'),
  file('f1', 'a.pdf', 'd2'),
  file('f0', 'top.txt'),
  // A drive shared with the user: the owner's folder above the shared one
  // is a placeholder (Stalwart 1.0).
  folder('o:top', 'Owner top', null, { isShared: true, discoverableOnly: true }),
  folder('o:s', 'Docs', 'o:top', { isShared: true }),
  file('o:f', 'shared.txt', 'o:s', { isShared: true }),
];

describe('files places', () => {
  it('walks a path from the root, the own folder first', () => {
    expect(resolveFolderPath(nodes, '/Docs/Sub')).toEqual([{ id: 'd1', name: 'Docs' }, { id: 'd2', name: 'Sub' }]);
    expect(resolveFolderPath(nodes, '/')).toEqual([]);
    expect(resolveFolderPath(nodes, '/Docs/Gone')).toBeNull();
    // A file is not a folder to stand in.
    expect(resolveFolderPath(nodes, '/top.txt')).toBeNull();
    expect(folderPathOf([{ id: 'd1', name: 'Docs' }, { id: 'd2', name: 'Sub' }])).toBe('/Docs/Sub');
  });

  it('finds where a node is listed, a shared one under its shared root', () => {
    expect(nodePlace(nodes, 'f1')?.stack).toEqual([{ id: 'd1', name: 'Docs' }, { id: 'd2', name: 'Sub' }]);
    expect(nodePlace(nodes, 'f0')?.stack).toEqual([]);
    expect(nodePlace(nodes, 'o:f')?.stack).toEqual([{ id: 'o:s', name: 'Docs' }]);
    expect(nodePlace(nodes, 'o:top')).toBeNull();
    expect(nodePlace(nodes, 'gone')).toBeNull();
  });

  it('keeps stars by path, following a rename and dropping a delete', () => {
    expect(toggleFavorite(['/A'], '/B')).toEqual(['/A', '/B']);
    expect(toggleFavorite(['/A', '/B'], '/A')).toEqual(['/B']);
    expect(moveFavorites(['/Docs', '/Docs/Sub', '/Docsx'], '/Docs', '/Papers')).toEqual(['/Papers', '/Papers/Sub', '/Docsx']);
    expect(dropFavoritesUnder(['/Docs', '/Docs/Sub', '/Docsx'], '/Docs')).toEqual(['/Docsx']);
  });

  it('keeps the newest 20 recent files, once each, and prunes the gone', () => {
    let recent = addRecentFile([], 'a', '1', 1);
    recent = addRecentFile(recent, 'b', '2', 2);
    recent = addRecentFile(recent, 'a', '1', 3);
    expect(recent.map((r) => r.id)).toEqual(['1', '2']);
    for (let i = 0; i < 30; i++) recent = addRecentFile(recent, `n${i}`, `x${i}`, 10 + i);
    expect(recent).toHaveLength(RECENT_FILES_MAX);
    expect(recent[0].id).toBe('x29');
    expect(pruneRecentFiles(recent, new Set(['x29', 'x28'])).map((r) => r.id)).toEqual(['x29', 'x28']);
  });
});

describe('files places store', () => {
  beforeEach(() => useFilesPlacesStore.setState({ places: {} }));

  it('keeps each account to itself', () => {
    const s = useFilesPlacesStore.getState();
    s.toggleFavorite('alice@a', '/Docs');
    s.addRecentFile('bob@b', 'x.pdf', 'f1');
    expect(useFilesPlacesStore.getState().places['alice@a']).toEqual({ favorites: ['/Docs'], recent: [] });
    expect(useFilesPlacesStore.getState().places['bob@b'].recent.map((r) => r.id)).toEqual(['f1']);
    // A listing of bob's drive leaves alice's alone.
    s.pruneRecentFiles('bob@b', new Set());
    expect(useFilesPlacesStore.getState().places['bob@b'].recent).toEqual([]);
    expect(useFilesPlacesStore.getState().places['alice@a'].favorites).toEqual(['/Docs']);
  });

  it('changes nothing for a change that changes nothing', () => {
    const before = useFilesPlacesStore.getState().places;
    useFilesPlacesStore.getState().pruneRecentFiles('alice@a', new Set());
    useFilesPlacesStore.getState().toggleFavorite('', '/Docs');
    expect(useFilesPlacesStore.getState().places).toBe(before);
    expect(NO_FILES_PLACES).toEqual({ favorites: [], recent: [] });
  });

  // No RN renderer in the test env: check the screen's wiring instead.
  it('is fed and shown by the Files tab', () => {
    const screen = fs.readFileSync(path.resolve(__dirname, '../../screens/FilesScreen.tsx'), 'utf8');
    // Opening, opening with and downloading a file make it recent.
    expect(screen).toMatch(/const openPreview = useCallback\(\(row: FileRow\) => \{\s*setPreviewTarget\(row\);\s*recordRecent\(row\);/);
    expect(screen).toMatch(/if \(!row\.blobId\) return;\s*recordRecent\(row\);/);
    expect(screen).toMatch(/await downloadAttachment\([^)]*\);\s*recordRecent\(row\);/);
    // A listing prunes; a rename, move or delete of a folder updates the stars.
    expect(screen).toMatch(/pruneRecentFiles\(account, new Set\(withoutTrash\(nodes\)\.map\(\(n\) => n\.id\)\)\)/);
    expect(screen).toMatch(/moveFavorites\(account, oldPath, oldPath\.slice\(0, oldPath\.lastIndexOf\('\/'\) \+ 1\) \+ name\)/);
    expect(screen).toMatch(/dropStarsOf\(done\.map/);
    expect(screen).toMatch(/dropStarsOf\(folderPaths\);/);
    // The root lists them above its files, in both views.
    expect(screen.match(/ListHeaderComponent=\{placesHeader\}/g)).toHaveLength(2);
    expect(screen).toMatch(/const showPlaces = path\.length === 0 && !inTrash && !searchQuery\.trim\(\);/);
    // A folder's actions star it.
    expect(screen).toMatch(/starred \? t\('files\.unstar', 'Remove star'\) : t\('files\.star', 'Star'\)/);
  });
});
