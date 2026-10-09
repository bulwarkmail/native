// The font size setting rescales `typography` in place, and hook-built
// styles recompute because `useColors()` changes identity with it. A style
// built once at module load would keep the size the app started with, so no
// module-scope code outside src/theme may read `typography`, or call
// `fontPx`, which reads the same factor.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const ROOT = join(__dirname, '..', '..', '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' || name === 'theme' ? [] : sourceFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

const isFunctionLike = (node: ts.Node) =>
  ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)
  || ts.isMethodDeclaration(node) || ts.isClassDeclaration(node) || ts.isGetAccessor(node);

function moduleScopeReads(path: string): number[] {
  const text = readFileSync(path, 'utf8');
  if (!text.includes('typography') && !text.includes('fontPx')) return [];
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const lines: number[] = [];
  const visit = (node: ts.Node) => {
    if (isFunctionLike(node) || ts.isImportDeclaration(node)) return;
    if (ts.isIdentifier(node) && (node.text === 'typography' || node.text === 'fontPx')) {
      lines.push(file.getLineAndCharacterOfPosition(node.getStart()).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  file.statements.forEach(visit);
  return lines;
}

describe('typography and fontPx at module scope', () => {
  it('are read only inside functions, so styles follow the font size setting', () => {
    const offenders = [join(ROOT, 'App.tsx'), ...sourceFiles(join(ROOT, 'src'))].flatMap((path) =>
      moduleScopeReads(path).map((line) => `${relative(ROOT, path)}:${line}`),
    );
    expect(offenders).toEqual([]);
  });
});
