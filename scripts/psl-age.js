// Reports how old the public suffix list inside tldts is. tldts ships no list
// date of its own, but each release regenerates the list, so the release's
// publish date is the list's date.
//   npm run deps:psl-age            print the age
//   npm run deps:psl-age -- --check exit 1 when older than PSL_MAX_AGE_DAYS
// Exit 2 means the age could not be told (no tldts installed, the registry
// unreachable, or the installed release not in it): not that it is stale.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const PSL_MAX_AGE_DAYS = 90;
const DAY_MS = 86400000;

function pslAge({ installed, times, now }) {
  const stable = Object.keys(times)
    .filter((v) => v !== 'created' && v !== 'modified' && /^\d+\.\d+\.\d+$/.test(v))
    .sort((a, b) => Date.parse(times[b]) - Date.parse(times[a]));
  const latest = stable[0] ?? null;
  const published = times[installed] ?? null;
  return {
    installed,
    published,
    ageDays: published ? Math.floor((now.getTime() - Date.parse(published)) / DAY_MS) : null,
    latest,
    latestPublished: latest ? times[latest] : null,
  };
}

// What to print, and the exit code (with `check`, 1 for a stale list).
function verdict(r, check) {
  const day = (iso) => (iso ? iso.slice(0, 10) : 'unknown');
  const latest = `latest ${r.latest ?? 'unknown'} of ${day(r.latestPublished)}`;
  if (r.published === null) {
    return {
      message: `tldts ${r.installed} is not among the registry's tldts releases, so its list date is unknown; ${latest}`,
      exitCode: 2,
    };
  }
  return {
    message: `tldts ${r.installed}, public suffix list as of ${day(r.published)} (${r.ageDays} days); ${latest}`,
    exitCode: check && r.ageDays > PSL_MAX_AGE_DAYS ? 1 : 0,
  };
}

// The installed tldts version under `root`, or null when there is none.
function installedTldts(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'node_modules', 'tldts', 'package.json'), 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

function main() {
  const installed = installedTldts(path.join(__dirname, '..'));
  if (!installed) {
    console.error('tldts is not installed (run npm install): the list age cannot be told.');
    process.exit(2);
  }
  let times;
  try {
    times = JSON.parse(execFileSync('npm', ['view', 'tldts', 'time', '--json'], { encoding: 'utf8', timeout: 20000 }));
  } catch (e) {
    console.error(`Could not read tldts release times from the registry (a registry problem, not a stale list): ${e.message}`);
    process.exit(2);
  }
  const r = verdict(pslAge({ installed, times, now: new Date() }), process.argv.includes('--check'));
  (r.exitCode === 2 ? console.error : console.log)(r.message);
  process.exit(r.exitCode);
}

if (require.main === module) main();
module.exports = { pslAge, verdict, installedTldts, PSL_MAX_AGE_DAYS };
