// The Appearance font size setting reaches text through `typography` and
// `fontPx`. A bare `fontSize: 13` ignores it, so no code outside src/theme
// may write one, and a computed or shorthand `fontSize` must come from the
// same two places.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { BODY_MAX_FONT_SCALE } from '../tokens';

const ROOT = join(__dirname, '..', '..', '..');
const SKIP = new Set(['__tests__', 'theme']);
// Places that may size text themselves, each for a reason.
const ALLOWED: Array<[string, string]> = [
  ['src/widgets/', 'home-screen widgets render as RemoteViews, outside the app font setting'],
  ['src/components/SenderAvatar.tsx', 'the initials are sized to the avatar circle'],
  ['src/stores/settings-store.ts', 'the Appearance setting named fontSize, not a style'],
];
const isAllowedPath = (path: string): boolean => {
  const rel = relative(ROOT, path).split('\\').join('/');
  return ALLOWED.some(([prefix]) => rel === prefix || (prefix.endsWith('/') && rel.startsWith(prefix)));
};
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

// `fontPx(…)`, `typography.<key>.fontSize`, or a conditional of those.
const isScaled = (node: ts.Expression): boolean => {
  if (ts.isParenthesizedExpression(node)) return isScaled(node.expression);
  if (ts.isConditionalExpression(node)) return isScaled(node.whenTrue) && isScaled(node.whenFalse);
  if (ts.isCallExpression(node)) return ts.isIdentifier(node.expression) && node.expression.text === 'fontPx';
  if (ts.isPropertyAccessExpression(node) && node.name.text === 'fontSize') {
    const key = node.expression;
    return ts.isPropertyAccessExpression(key)
      && ts.isIdentifier(key.expression) && key.expression.text === 'typography';
  }
  return false;
};

function scan(path: string, text: string, flag: (node: ts.ObjectLiteralElementLike) => boolean): string[] {
  if (!text.includes('fontSize')) return [];
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node))
      && node.name.getText(file) === 'fontSize' && flag(node)) {
      found.push(`${relative(ROOT, path)}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

const sources = (): string[] => [join(ROOT, 'App.tsx'), ...sourceFiles(join(ROOT, 'src'))];

function literalsIn(path: string): string[] {
  return scan(path, readFileSync(path, 'utf8'), (n) => ts.isPropertyAssignment(n) && isNumeric(n.initializer));
}

function offendersIn(path: string, text: string): string[] {
  return scan(path, text, (n) => !(ts.isPropertyAssignment(n) && isScaled(n.initializer)));
}

function fontSizeLiterals(): string[] {
  return sources().filter((p) => !isAllowedPath(p)).flatMap(literalsIn);
}

function fontSizeOffenders(): string[] {
  return sources().filter((p) => !isAllowedPath(p)).flatMap((p) => offendersIn(p, readFileSync(p, 'utf8')));
}

describe('font sizes', () => {
  it('has no numeric fontSize literal outside the theme', () => {
    expect(fontSizeLiterals()).toEqual([]);
  });

  it('takes every fontSize from fontPx or typography outside the allow-list', () => {
    expect(fontSizeOffenders()).toEqual([]);
  });

  it('flags a computed or shorthand fontSize, and allows fontPx and typography', () => {
    expect(offendersIn('a.tsx', 'const s = { fontSize: size }; const t = { fontSize };')).toHaveLength(2);
    expect(offendersIn('a.tsx', 'const s = { fontSize: fontPx(13), a: { fontSize: typography.body.fontSize }, b: { fontSize: big ? fontPx(14) : fontPx(13) } };')).toEqual([]);
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
