// Babel plugin: rewrite named imports from the `lucide-react-native` barrel to
// the per-icon modules they re-export, so the bundle only contains (and the
// app only evaluates) the icons it uses. The barrel re-exports all ~1,700
// icons, and Metro has no tree shaking, so one `import { Mail }` used to pull
// in and run every icon at startup.
//
//   import { Mail, Trash2 as Bin } from 'lucide-react-native';
// becomes
//   import Mail from 'lucide-react-native/dist/esm/icons/mail.js';
//   import Bin from 'lucide-react-native/dist/esm/icons/trash-2.js';
//
// The name -> file table is read from the package's own ESM barrel, so icon
// aliases (`MailIcon`, `LucideMail`, renamed icons) resolve exactly as they do
// through the barrel. metro.config.js resolves these deep paths, which the
// package's `exports` map does not list.
const fs = require('node:fs');
const path = require('node:path');

const PACKAGE = 'lucide-react-native';
const ESM_DIR = 'dist/esm';

/** Map every name the barrel exports to `{ source, imported }`. */
function loadExportMap() {
  // `main` is dist/cjs/lucide-react-native.js; the ESM tree sits next to it.
  const pkgDir = path.resolve(path.dirname(require.resolve(PACKAGE)), '..', '..');
  const barrel = fs.readFileSync(path.join(pkgDir, ESM_DIR, `${PACKAGE}.js`), 'utf8');
  const map = new Map();
  for (const m of barrel.matchAll(/export\s*\{([^}]*)\}\s*from\s*'\.\/([^']+)'/g)) {
    const source = `${PACKAGE}/${ESM_DIR}/${m[2]}`;
    for (const spec of m[1].split(',')) {
      const [imported, exported = imported] = spec.trim().split(/\s+as\s+/);
      if (imported) map.set(exported, { source, imported });
    }
  }
  if (map.size === 0) {
    throw new Error(`${PACKAGE}: could not read the export list from its ESM barrel`);
  }
  return map;
}

let exportMap = null;
function getExportMap() {
  if (!exportMap) exportMap = loadExportMap();
  return exportMap;
}

// A value-less binding (only used as a type) is dropped by the TypeScript
// transform anyway; treat it the same way instead of failing the build.
function isOnlyUsedAsType(importPath, localName) {
  const binding = importPath.scope.getBinding(localName);
  if (!binding) return true;
  return binding.referencePaths.every((ref) => Boolean(ref.findParent((p) => p.isTSType())));
}

function lucideImportsPlugin({ types: t }) {
  return {
    name: 'lucide-direct-imports',
    visitor: {
      ImportDeclaration(importPath) {
        const { node } = importPath;
        if (node.source.value !== PACKAGE || node.importKind === 'type') return;
        // Side-effect, default and namespace imports keep using the barrel.
        if (node.specifiers.length === 0) return;
        if (!node.specifiers.every((s) => t.isImportSpecifier(s))) return;

        const map = getExportMap();
        const replacements = [];
        for (const spec of node.specifiers) {
          if (spec.importKind === 'type') continue;
          const name = t.isIdentifier(spec.imported) ? spec.imported.name : spec.imported.value;
          const target = map.get(name);
          if (!target) {
            if (isOnlyUsedAsType(importPath, spec.local.name)) continue;
            throw importPath.buildCodeFrameError(`${PACKAGE} has no export named "${name}"`);
          }
          const local = t.identifier(spec.local.name);
          const specifier = target.imported === 'default'
            ? t.importDefaultSpecifier(local)
            : t.importSpecifier(local, t.identifier(target.imported));
          replacements.push(t.importDeclaration([specifier], t.stringLiteral(target.source)));
        }
        if (replacements.length === 0) importPath.remove();
        else importPath.replaceWithMultiple(replacements);
      },
    },
  };
}

module.exports = lucideImportsPlugin;
module.exports.loadExportMap = loadExportMap;
module.exports.PACKAGE = PACKAGE;
