// The Appearance font size setting reaches text through `typography` and
// `fontPx`. A bare `fontSize: 13` ignores it, so no code outside src/theme
// may write one. Home-screen widgets (src/widgets) render as RemoteViews,
// outside the app's font setting, and are left out.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { BODY_MAX_FONT_SCALE } from '../tokens';

const ROOT = join(__dirname, '..', '..', '..');
const SKIP = new Set(['__tests__', 'theme', 'widgets']);
const nodeRequire = createRequire(join(ROOT, 'package.json'));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return SKIP.has(name) ? [] : sourceFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

const isNumeric = (node: ts.Expression): boolean =>
  ts.isNumericLiteral(node)
  || (ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand))
  || (ts.isParenthesizedExpression(node) && isNumeric(node.expression));

function literalsIn(path: string): string[] {
  const text = readFileSync(path, 'utf8');
  if (!text.includes('fontSize')) return [];
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && node.name.getText(file) === 'fontSize' && isNumeric(node.initializer)) {
      found.push(`${relative(ROOT, path)}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function fontSizeLiterals(): string[] {
  return [join(ROOT, 'App.tsx'), ...sourceFiles(join(ROOT, 'src'))].flatMap(literalsIn);
}

describe('font sizes', () => {
  it('has no numeric fontSize literal outside the theme', () => {
    expect(fontSizeLiterals()).toEqual([]);
  });

  it('caps the OS scale on body text at 1.5 in the installed react-native', () => {
    expect(BODY_MAX_FONT_SCALE).toBe(1.5);
    const text = readFileSync(nodeRequire.resolve('react-native/Libraries/Text/Text.js'), 'utf8');
    expect(text).toMatch(/hasTextAncestor[\s\S]{0,200}maxFontSizeMultiplier[\s\S]{0,80}1\.5/);
    // Both top-level paths pass it on: plain and pressable.
    expect(text).toMatch(/<NativeText\s+\{\.\.\.restProps\}\s+maxFontSizeMultiplier=\{_maxFontSizeMultiplier\}/);
    expect(text).toMatch(/\.\.\.restProps,\s+maxFontSizeMultiplier: _maxFontSizeMultiplier,/);
    const input = readFileSync(nodeRequire.resolve('react-native/Libraries/Components/TextInput/TextInput.js'), 'utf8');
    expect(input).toMatch(/maxFontSizeMultiplier[\s\S]{0,80}1\.5/);
    expect(existsSync(join(ROOT, 'patches/react-native+0.81.5.patch'))).toBe(true);
  });
});
