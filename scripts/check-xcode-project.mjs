// Checks the structure of a generated ios/<project>.xcodeproj that CocoaPods'
// xcodeproj gem refuses to save (pod install fails in React Native's
// post-install hook with "Consistency issue: no parent for object ..."):
//
// - every build file in a target's Sources phase points at an existing file
//   reference, and appears in no other build phase;
// - every such file reference sits in exactly one group, reachable from the
//   project's main group.
//
// It also lists, per target, which file each Sources entry compiles (the path
// relative to ios/), so a test can check that a target builds its own copy.
//
//   node scripts/check-xcode-project.mjs ios/BulwarkMobile.xcodeproj/project.pbxproj
//
// The tests (src/lib/__tests__/ios-xcode-project.test.ts) run the iOS config
// plugins over Expo's template and use this on the result.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);

const isComment = (key) => key.endsWith('_comment');
const entries = (section) => Object.entries(section ?? {}).filter(([key]) => !isComment(key));
const unquote = (value) => (typeof value === 'string' ? value.replace(/^"(.*)"$/, '$1') : value);

/** Parses a project.pbxproj with the `xcode` package the config plugins use. */
export function parseProject(pbxprojPath) {
  const configPlugins = path.dirname(require.resolve('@expo/config-plugins/package.json'));
  const xcode = require(require.resolve('xcode', { paths: [configPlugins] }));
  const project = xcode.project(pbxprojPath);
  project.parseSync();
  return project;
}

/**
 * @param project a parsed `xcode` project (or a project.pbxproj path)
 * @returns {{ problems: string[], sources: Record<string, string[]> }}
 *   problems: one line per broken entry (empty when the project is sound);
 *   sources: target name -> paths (relative to ios/) its Sources phase compiles.
 */
export function checkXcodeProject(project) {
  if (typeof project === 'string') project = parseProject(project);
  const objects = project.hash.project.objects;
  const fileRefs = objects.PBXFileReference ?? {};
  const buildFiles = objects.PBXBuildFile ?? {};
  const groups = objects.PBXGroup ?? {};
  const problems = [];

  // Parents of every group and file reference, walking down from the main group.
  const parents = new Map();
  const groupPath = new Map();
  const mainGroup = project.getFirstProject().firstProject.mainGroup;
  const walk = (groupId, base, seen) => {
    if (seen.has(groupId)) return;
    seen.add(groupId);
    const group = groups[groupId];
    if (!group) return;
    const dir = group.path ? path.posix.join(base, unquote(group.path)) : base;
    groupPath.set(groupId, dir);
    for (const child of group.children ?? []) {
      const list = parents.get(child.value) ?? [];
      list.push(groupId);
      parents.set(child.value, list);
      if (groups[child.value]) walk(child.value, dir, seen);
    }
  };
  walk(mainGroup, '', new Set());

  // Which build phases list each build file.
  const phasesOf = new Map();
  for (const [isa, section] of Object.entries(objects)) {
    if (!isa.endsWith('BuildPhase')) continue;
    for (const [phaseId, phase] of entries(section)) {
      for (const file of phase.files ?? []) {
        const list = phasesOf.get(file.value) ?? [];
        list.push(`${isa} ${phaseId}`);
        phasesOf.set(file.value, list);
      }
    }
  }

  const sources = {};
  for (const [, target] of entries(objects.PBXNativeTarget)) {
    const name = unquote(target.name);
    sources[name] = [];
    for (const phaseRef of target.buildPhases ?? []) {
      const phase = objects.PBXSourcesBuildPhase?.[phaseRef.value];
      if (!phase) continue;
      for (const file of phase.files ?? []) {
        const label = `${name}: ${file.comment ?? file.value}`;
        const buildFile = buildFiles[file.value];
        if (!buildFile) {
          problems.push(`${label}: build file ${file.value} does not exist`);
          continue;
        }
        const phases = phasesOf.get(file.value) ?? [];
        if (phases.length !== 1) {
          problems.push(`${label}: build file ${file.value} is in ${phases.length} build phases (${phases.join(', ')})`);
        }
        const ref = fileRefs[buildFile.fileRef];
        if (!ref) {
          problems.push(`${label}: file reference ${buildFile.fileRef} does not exist`);
          continue;
        }
        const owners = parents.get(buildFile.fileRef) ?? [];
        if (owners.length !== 1) {
          problems.push(`${label}: file reference ${buildFile.fileRef} is in ${owners.length} groups reachable from the main group`);
          continue;
        }
        const refPath = unquote(ref.path ?? ref.name);
        const tree = unquote(ref.sourceTree);
        sources[name].push(tree === '<group>' ? path.posix.join(groupPath.get(owners[0]), refPath) : `${tree}/${refPath}`);
      }
    }
  }
  return { problems, sources };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node scripts/check-xcode-project.mjs <path to project.pbxproj>');
    process.exit(2);
  }
  const { problems, sources } = checkXcodeProject(file);
  for (const [target, files] of Object.entries(sources)) console.log(`${target}:\n  ${files.join('\n  ')}`);
  if (problems.length) {
    console.error(`\n${problems.length} problem(s):\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
}
