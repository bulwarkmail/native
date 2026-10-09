// Reports how old the public suffix list inside tldts is. tldts ships no list
// date of its own, but each release regenerates the list, so the release's
// publish date is the list's date.
//   npm run deps:psl-age            print the age
//   npm run deps:psl-age -- --check exit 1 when older than PSL_MAX_AGE_DAYS
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

function main() {
  const installed = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'node_modules', 'tldts', 'package.json'), 'utf8'),
  ).version;
  let times;
  try {
    times = JSON.parse(execFileSync('npm', ['view', 'tldts', 'time', '--json'], { encoding: 'utf8', timeout: 20000 }));
  } catch (e) {
    console.error(`Could not read tldts release times from the registry: ${e.message}`);
    process.exit(2);
  }
  const r = pslAge({ installed, times, now: new Date() });
  const day = (iso) => (iso ? iso.slice(0, 10) : 'unknown');
  console.log(
    `tldts ${r.installed}, public suffix list as of ${day(r.published)} (${r.ageDays ?? '?'} days); `
    + `latest ${r.latest} of ${day(r.latestPublished)}`,
  );
  if (process.argv.includes('--check') && (r.ageDays === null || r.ageDays > PSL_MAX_AGE_DAYS)) {
    process.exit(1);
  }
}

if (require.main === module) main();
module.exports = { pslAge, PSL_MAX_AGE_DAYS };
