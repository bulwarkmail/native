// Compiles sources that live next to a config plugin into the iOS app target:
// copied into ios/<project>/ at prebuild (ios/ is generated, never edited by
// hand) and added to the app's Sources build phase.

const fs = require('node:fs');
const path = require('node:path');
const { IOSConfig, withDangerousMod, withXcodeProject } = require('@expo/config-plugins');

function withAppSources(config, { dir, files }) {
  config = withDangerousMod(config, [
    'ios',
    async (cfg) => {
      const appDir = path.join(cfg.modRequest.platformProjectRoot, cfg.modRequest.projectName);
      for (const file of files) {
        fs.copyFileSync(path.join(dir, file), path.join(appDir, file));
      }
      return cfg;
    },
  ]);
  config = withXcodeProject(config, (cfg) => {
    const projectName = cfg.modRequest.projectName;
    for (const file of files) {
      IOSConfig.XcodeUtils.addBuildSourceFileToGroup({
        filepath: `${projectName}/${file}`,
        groupName: projectName,
        project: cfg.modResults,
      });
    }
    return cfg;
  });
  return config;
}

module.exports = { withAppSources };
