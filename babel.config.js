const path = require('node:path');

// babel-preset-expo ships inside `expo` rather than as a direct dependency, so
// resolve it from there; this is the preset Expo uses when no config exists.
const presetExpo = require.resolve('babel-preset-expo', {
  paths: [path.dirname(require.resolve('expo/package.json'))],
});

module.exports = function babelConfig(api) {
  api.cache(true);
  return {
    presets: [presetExpo],
    plugins: [require.resolve('./scripts/babel-plugin-lucide-imports')],
  };
};
