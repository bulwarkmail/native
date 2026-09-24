// Shared by the *-i18n tests: finds English text in a component's source that
// does not go through t(). Such a literal stays English in every locale.
// Parses the file with the TypeScript compiler instead of matching regexes so
// multi-line JSX text and ternaries are caught too.
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Props that carry text a user sees or a screen reader reads out.
const TEXT_PROPS = new Set([
  'title', 'label', 'description', 'placeholder', 'message', 'subtitle',
  'accessibilityLabel', 'accessibilityHint', 'confirmText', 'cancelText',
  'emptyText', 'text', 'dialogTitle',
]);

// Calls whose string arguments end up on screen.
const DISPLAY_CALL_RE = /^(Alert\.alert|Alert\.prompt|toast\.(success|error|info|warning)|setError|setStatus)$/;

// A literal counts as English text when it has a word of two or more letters.
const hasWord = (text: string) => /[A-Za-z]{2,}/.test(text);

function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(' ');
  }
  return null;
}

// The string literals an expression can evaluate to directly: `'a'`,
// `x ? 'a' : 'b'`, `x || 'a'`, `('a')`. Not literals passed into calls.
function directLiterals(node: ts.Expression): ts.Node[] {
  if (ts.isParenthesizedExpression(node)) return directLiterals(node.expression);
  if (ts.isConditionalExpression(node)) return [...directLiterals(node.whenTrue), ...directLiterals(node.whenFalse)];
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.AmpersandAmpersandToken) {
      return [...directLiterals(node.left), ...directLiterals(node.right)];
    }
    if (op === ts.SyntaxKind.PlusToken) return [...directLiterals(node.left), ...directLiterals(node.right)];
    return [];
  }
  return literalText(node) !== null ? [node] : [];
}

/**
 * `file:line  text` for every hard-coded English string in `path`.
 * `allow` lists texts that are meant to stay as they are (product names,
 * format patterns).
 */
export function findUntranslatedLiterals(path: string, allow: string[] = []): string[] {
  const source = readFileSync(path, 'utf8');
  const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const report = (node: ts.Node, text: string) => {
    const trimmed = text.trim();
    if (!hasWord(trimmed) || allow.includes(trimmed)) return;
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    found.push(`${line + 1}  ${JSON.stringify(trimmed)}`);
  };
  const reportExpression = (expr: ts.Expression) => {
    for (const lit of directLiterals(expr)) report(lit, literalText(lit) ?? '');
  };

  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) {
      report(node, node.text.replace(/\s+/g, ' '));
    } else if (ts.isJsxExpression(node) && node.expression && ts.isJsxElement(node.parent)) {
      // {'Text'} or {cond ? 'A' : 'B'} as a child.
      reportExpression(node.expression);
    } else if (ts.isJsxAttribute(node) && TEXT_PROPS.has(node.name.getText(sf)) && node.initializer) {
      const init = node.initializer;
      if (ts.isStringLiteral(init)) report(init, init.text);
      else if (ts.isJsxExpression(init) && init.expression) reportExpression(init.expression);
    } else if (ts.isPropertyAssignment(node) && TEXT_PROPS.has(node.name.getText(sf))) {
      reportExpression(node.initializer);
    } else if (ts.isCallExpression(node) && DISPLAY_CALL_RE.test(node.expression.getText(sf))) {
      for (const arg of node.arguments) reportExpression(arg);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}
