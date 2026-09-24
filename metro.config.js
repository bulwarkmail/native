const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// babel.config.js rewrites lucide-react-native imports to per-icon modules
// under dist/ (scripts/babel-plugin-lucide-imports.js). The package's
// `exports` map only lists its barrel, so resolve those paths as plain files
// instead of letting Metro warn about every one of them.
const LUCIDE_DEEP_IMPORT = 'lucide-react-native/dist/';
const upstreamResolveRequest = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve = upstreamResolveRequest ?? context.resolveRequest;
  if (moduleName.startsWith(LUCIDE_DEEP_IMPORT)) {
    return resolve({ ...context, unstable_enablePackageExports: false }, moduleName, platform);
  }
  return resolve(context, moduleName, platform);
};

module.exports = config;
