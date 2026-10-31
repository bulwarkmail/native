// Gives an extension target (plugins/ios-push, plugins/ios-widget) its own
// group of files in the Xcode project, and compiles its sources in its own
// Sources build phase.
//
// Written against the project objects directly: the `xcode` package's
// addPbxGroup and addBuildPhase reuse any file reference or build file with
// the same path, so two extensions that each carry SharedKeychain.swift ended
// up sharing one file reference (in both groups) and one build file (in both
// Sources phases). CocoaPods' xcodeproj then fails to save the project in
// pod install ("Consistency issue: no parent for object SharedKeychain.swift").

const FILE_TYPES = {
  swift: 'sourcecode.swift',
  m: 'sourcecode.c.objc',
  h: 'sourcecode.c.h',
  plist: 'text.plist.xml',
  entitlements: 'text.plist.entitlements',
};

const quote = (value) => `"${value}"`;
const unquote = (value) => (typeof value === 'string' ? value.replace(/^"(.*)"$/, '$1') : value);

/**
 * Whether the project has a target `name`. pbxTargetByName misses targets
 * that addTarget made: it stores the name in quotes, so prebuild without
 * --clean added the extension targets a second time.
 */
function hasTarget(project, name) {
  return Object.entries(project.pbxNativeTargetSection() ?? {}).some(
    ([key, target]) => !key.endsWith('_comment') && unquote(target.name) === name,
  );
}

/**
 * Adds a group `name` (folder ios/<name>) under the project's main group,
 * with a new file reference for each of `files` and `sources`, and a Sources
 * build phase on the target that compiles `sources` from that group.
 *
 * @param project the `xcode` project (cfg.modResults of withXcodeProject)
 * @param {{ name: string, targetUuid: string, sources: string[], files?: string[] }} options
 *   files: other files to show in the group (Info.plist, entitlements), not compiled
 * @returns {{ groupUuid: string, phaseUuid: string }}
 */
function addTargetFiles(project, { name, targetUuid, sources, files = [] }) {
  const objects = project.hash.project.objects;
  objects.PBXFileReference = objects.PBXFileReference || {};
  objects.PBXBuildFile = objects.PBXBuildFile || {};
  objects.PBXGroup = objects.PBXGroup || {};

  const groupUuid = project.generateUuid();
  const group = { isa: 'PBXGroup', children: [], name: quote(name), path: quote(name), sourceTree: '"<group>"' };
  objects.PBXGroup[groupUuid] = group;
  objects.PBXGroup[`${groupUuid}_comment`] = name;
  const mainGroup = objects.PBXGroup[project.getFirstProject().firstProject.mainGroup];
  mainGroup.children.push({ value: groupUuid, comment: name });

  const refs = {};
  for (const file of [...sources, ...files]) {
    if (refs[file]) throw new Error(`plugins/ios-target-files: ${file} listed twice for ${name}`);
    const uuid = project.generateUuid();
    const type = FILE_TYPES[file.split('.').pop()];
    objects.PBXFileReference[uuid] = {
      isa: 'PBXFileReference',
      ...(type ? { lastKnownFileType: type } : {}),
      name: quote(file),
      path: quote(file),
      sourceTree: '"<group>"',
    };
    objects.PBXFileReference[`${uuid}_comment`] = file;
    group.children.push({ value: uuid, comment: file });
    refs[file] = uuid;
  }

  const { uuid: phaseUuid, buildPhase } = project.addBuildPhase([], 'PBXSourcesBuildPhase', 'Sources', targetUuid);
  for (const file of sources) {
    const uuid = project.generateUuid();
    const comment = `${file} in Sources`;
    objects.PBXBuildFile[uuid] = { isa: 'PBXBuildFile', fileRef: refs[file], fileRef_comment: file };
    objects.PBXBuildFile[`${uuid}_comment`] = comment;
    buildPhase.files.push({ value: uuid, comment });
  }
  return { groupUuid, phaseUuid };
}

module.exports = { addTargetFiles, hasTarget };
