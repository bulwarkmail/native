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

module.exports = config;
