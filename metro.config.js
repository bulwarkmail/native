const path = require('path');
const fs = require('fs');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Performance harness (the iOS simulator tests, .github/workflows/e2e-ios.yml):
// with BULWARK_MODULE_TIMINGS set, the bundle times each module's
// evaluation (scripts/perf/module-timings.js), and BULWARK_MODULE_MAP names
// a file that receives the module ids with their source paths, so the
// harness can tell which module is which. Release builds set neither.
if (process.env.BULWARK_MODULE_TIMINGS) {
  const basePolyfills = config.serializer.getPolyfills;
  config.serializer.getPolyfills = (ctx) => [
    ...basePolyfills(ctx),
    path.join(__dirname, 'scripts/perf/module-timings.js'),
  ];
  const mapFile = process.env.BULWARK_MODULE_MAP;
  if (mapFile) {
    const baseFactory = config.serializer.createModuleIdFactory;
    config.serializer.createModuleIdFactory = () => {
      const idOf = baseFactory();
      const names = {};
      process.on('exit', () => {
        try { fs.writeFileSync(mapFile, JSON.stringify(names)); } catch { /* best effort */ }
      });
      return (modulePath) => {
        const id = idOf(modulePath);
        names[id] = path.relative(__dirname, modulePath).split(path.sep).join('/');
        return id;
      };
    };
  }
}

// Evaluate a module when it is first used instead of all of them before the
// first render. Expo's default leaves this off; React Native's own template
// turns it on. Side-effect-only imports (`import './x'`) still run in place.
config.transformer.getTransformOptions = async () => ({
  transform: {
    experimentalImportSupport: true,
    inlineRequires: true,
  },
});

// openpgp's package exports send Metro to its Node build, which imports
// node:crypto. The browser build (same API, WebCrypto from
// src/lib/crypto/install-webcrypto.ts) is what runs on Hermes. Only openpgp
// gets it: adding the "browser" condition globally would change what every
// other package resolves to.
const OPENPGP_BROWSER_BUILD = path.join(path.dirname(require.resolve('openpgp')), '..', 'openpgp.min.mjs');
const baseResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === 'openpgp') return { type: 'sourceFile', filePath: OPENPGP_BROWSER_BUILD };
  return baseResolveRequest
    ? baseResolveRequest(context, moduleName, platform)
    : context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
