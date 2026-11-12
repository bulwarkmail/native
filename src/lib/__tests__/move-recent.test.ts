import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// The Move sheet had no filter and no recent folders (webmail
// move-target-list.tsx, lib/move-recent.ts, 56e833fe6).

const storage = vi.hoisted(() => new Map<string, string>());
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (k: string) => storage.get(k) ?? null),
    setItem: vi.fn(async (k: string, v: string) => { storage.set(k, v); }),
  },
}));

import {
  filterTree, loadRecentMoveTargets, noteMoveTarget, readRecentMoveTargets, resetRecentMoveTargetsForTests,
} from '../move-recent';

beforeEach(() => {
  storage.clear();
  resetRecentMoveTargetsForTests();
});

describe('recent move targets', () => {
  it('keeps the last folders per account, newest first, each once, at most eight', async () => {
    for (const id of ['a', 'b', 'c', 'a']) noteMoveTarget('acc1', id);
    noteMoveTarget('acc2', 'x');
    expect(readRecentMoveTargets('acc1')).toEqual(['a', 'c', 'b']);
    expect(readRecentMoveTargets('acc2')).toEqual(['x']);
    for (let i = 0; i < 10; i++) noteMoveTarget('acc1', `f${i}`);
    expect(readRecentMoveTargets('acc1')).toHaveLength(8);
    expect(readRecentMoveTargets(null)).toEqual([]);
  });

  it('keeps them over a restart', async () => {
    noteMoveTarget('acc1', 'work');
    await new Promise((r) => setTimeout(r, 0));
    resetRecentMoveTargetsForTests();
    await loadRecentMoveTargets();
    expect(readRecentMoveTargets('acc1')).toEqual(['work']);
  });

  it('keeps what an earlier run noted when the first move of a cold start is saved', async () => {
    storage.set('bulwark.moveRecent.v1', JSON.stringify({ acc1: ['archive', 'work'], acc2: ['x'] }));
    await noteMoveTarget('acc1', 'invoices');
    resetRecentMoveTargetsForTests();
    await loadRecentMoveTargets();
    expect(readRecentMoveTargets('acc1')).toEqual(['invoices', 'archive', 'work']);
    expect(readRecentMoveTargets('acc2')).toEqual(['x']);
  });
});

describe('move filter', () => {
  type N = { name: string; children: N[] };
  const tree: N[] = [
    { name: 'Inbox', children: [] },
    { name: 'Projekte', children: [{ name: 'Kunden', children: [{ name: 'Müller', children: [] }] }] },
    { name: 'Rechnungen', children: [] },
  ];

  it('keeps matching folders with the folders above them, ignoring case and accents', () => {
    const names = (nodes: N[]): string[] => nodes.flatMap((n) => [n.name, ...names(n.children)]);
    expect(names(filterTree(tree, 'muller', (n) => n.name))).toEqual(['Projekte', 'Kunden', 'Müller']);
    expect(names(filterTree(tree, 'RECH', (n) => n.name))).toEqual(['Rechnungen']);
    expect(filterTree(tree, ' ', (n) => n.name)).toBe(tree);
  });

  it('is in the Move sheet with the recents on top', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../components/MoveSheet.tsx'), 'utf8');
    expect(src).toMatch(/const showFilter = mailboxes\.length > MOVE_FILTER_THRESHOLD;/);
    expect(src).toMatch(/\{!filtering && recent\.length > 0 && \(/);
    expect(src).toMatch(/noteMoveTarget\(accountKey, id\);\r?\n\s*onPick\(id\);/);
    expect(src).toMatch(/onPress=\{targetable \? \(\) => pick\(node\.id\) : undefined\}/);
  });
});
