#!/usr/bin/env node
// Performance harness for the iOS simulator (Part 2 of docs/ios-test-2026-10.md).
//
//   node scripts/e2e/perf.mjs --app base=<path.app> --app cand=<path.app> \
//     --rounds 5 --cold 3 --flows .maestro/perf/1-open-message.yaml,... --out <dir>
//
// The app logs `[perf] {...}` lines when launched with `-perfMarks YES`
// (src/lib/perf-marks.ts); they reach the simulator's system log at info
// level. This script streams that log, and per round and app:
//   1. installs the app over the previous one (data and keychain stay, so it
//      stays signed in),
//   2. cold-starts it `--cold` times: terminate, launch, wait for
//      `inbox-rendered`; cold start = that mark's time minus the launch time
//      taken on this machine (the simulator shares the host clock). The
//      first launch after the install is much slower and swings a lot (iOS
//      does its first-launch work for the new binary), so it is reported on
//      its own as `first-start-*`; `cold-start-*` are the launches after it,
//   3. runs the Maestro interaction flows once each (open messages, switch
//      tabs, open compose, scroll), which produce the other marks. Each flow
//      is its own run, so one that fails costs only its own metric.
// Apps alternate inside every round, so both sides of a comparison see the
// same runner, the same simulator and the same server load.
//
// Output: <out>/perf.json (every sample) and <out>/perf.md (medians).

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const apps = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--app') {
    const [label, p] = args[i + 1].split('=');
    apps.push({ label, path: p });
  }
}
const UDID = process.env.UDID;
const BUNDLE = 'org.bulwarkmail.mobile';
const rounds = Number(opt('rounds', 5));
const coldRuns = Number(opt('cold', 3));
const flows = (opt('flows', '') || '').split(',').filter(Boolean);
const out = opt('out', 'perf-output');
const maestroEnv = (opt('env', '') || '').split(',').filter(Boolean);
fs.mkdirSync(out, { recursive: true });

if (!UDID || apps.length === 0) {
  console.error('need UDID and at least one --app label=path');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const simctl = (...a) => execFileSync('xcrun', ['simctl', ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// ── log stream ──────────────────────────────────────────────────────────────
const marks = []; // { n, t, ...detail, label }
let currentLabel = null;
const waiters = [];
const stream = spawn('xcrun', [
  'simctl', 'spawn', UDID, 'log', 'stream', '--level', 'info', '--style', 'ndjson',
  '--predicate', 'subsystem == "com.facebook.react.log" AND eventMessage CONTAINS "[perf]"',
]);
let buf = '';
stream.stdout.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    const msg = String(ev.eventMessage || '');
    const at = msg.indexOf('[perf] ');
    if (at < 0) continue;
    // The message is the console line, possibly quoted by RCTLog.
    const json = msg.slice(at + 7).replace(/^'|'$/g, '');
    let mark;
    try { mark = JSON.parse(json); } catch { continue; }
    mark.label = currentLabel;
    marks.push(mark);
    for (const w of [...waiters]) {
      if (w.name === mark.n) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(mark);
      }
    }
  }
});

function waitForMark(name, timeoutMs) {
  return new Promise((resolve) => {
    const w = { name, resolve };
    waiters.push(w);
    setTimeout(() => {
      const i = waiters.indexOf(w);
      if (i >= 0) { waiters.splice(i, 1); resolve(null); }
    }, timeoutMs);
  });
}

// ── steps ───────────────────────────────────────────────────────────────────
const samples = []; // { label, metric, ms, round }
const moduleRuns = {}; // label -> [{ total, top: { id: ms } }] (module-times marks)

async function coldStart(label, round, first) {
  try { simctl('terminate', UDID, BUNDLE); } catch { /* not running */ }
  await sleep(1500);
  const pending = waitForMark('inbox-rendered', 120_000);
  const bundlePending = waitForMark('bundle-loaded', 120_000);
  const modulesPending = waitForMark('module-times', 125_000);
  const t0 = Date.now();
  simctl('launch', UDID, BUNDLE, '-perfMarks', 'YES');
  const [mark, bundle] = await Promise.all([pending, bundlePending]);
  if (!mark) {
    console.log(`  ${label} cold start: no inbox-rendered mark within 120 s`);
    return;
  }
  const kind = first ? 'first-start' : 'cold-start';
  // Builds made with BULWARK_MODULE_TIMINGS log how long each module took
  // to evaluate, right after the first inbox (src/lib/perf-marks.ts).
  const modules = await Promise.race([modulesPending, sleep(3000).then(() => null)]);
  if (modules && !first) {
    const top = {};
    for (const pair of String(modules.top || '').split(',')) {
      const [id, ms] = pair.split(':');
      if (id) top[id] = Number(ms);
    }
    (moduleRuns[label] ||= []).push({ total: modules.total, top });
  }
  samples.push({ label, round, metric: `${kind}-to-inbox`, ms: mark.t - t0 });
  if (bundle) samples.push({ label, round, metric: `${kind}-to-bundle`, ms: bundle.t - t0 });
  // The start-up timeline: every mark between launch and the inbox, as time
  // since launch, plus how long each persisted cache took to read and parse.
  if (!first) {
    for (const m of marks) {
      if (m.t < t0 || m.t > mark.t || m.n === 'inbox-rendered' || m.n === 'bundle-loaded') continue;
      const key = m.store ? `${m.n}:${m.store}` : m.n;
      samples.push({ label, round, metric: `start:${key}`, ms: m.t - t0 });
      if (m.n === 'hydrate') {
        samples.push({ label, round, metric: `hydrate-read:${m.store}`, ms: m.readMs });
        samples.push({ label, round, metric: `hydrate-parse:${m.store}`, ms: m.parseMs, kb: m.kb });
      }
    }
  }
  console.log(`  ${label} cold start ${mark.t - t0} ms (bundle ${bundle ? bundle.t - t0 : '?'} ms, rows ${mark.rows})`);
  await sleep(3000);
}

// All interaction flows in one Maestro process: every process start brings
// the XCTest driver up again (30-60 s). A failing flow doesn't stop the
// others; a hung driver is killed after FLOW_CAP_MS.
const FLOW_CAP_MS = 12 * 60 * 1000;
function runFlows(label) {
  const before = marks.length;
  const env = maestroEnv.flatMap((kv) => ['-e', kv]);
  const res = spawn('maestro', ['--device', UDID, 'test', ...env, ...flows], { stdio: 'inherit' });
  const cap = setTimeout(() => res.kill('SIGKILL'), FLOW_CAP_MS);
  return new Promise((resolve) => {
    res.on('exit', (code) => {
      clearTimeout(cap);
      const got = marks.slice(before).filter((m) => typeof m.ms === 'number');
      console.log(`  ${label} interactions: exit ${code}, ${got.length} timed marks`);
      resolve(got);
    });
  });
}

function writeReport(final = false) {

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};
const metrics = [...new Set(samples.map((s) => s.metric))].sort();
const labels = apps.map((a) => a.label);
const lines = [
  `| metric | ${labels.map((l) => `${l} median (n)`).join(' | ')} |${labels.length === 2 ? ' change |' : ''}`,
  `|---|${labels.map(() => '---').join('|')}|${labels.length === 2 ? '---|' : ''}`,
];
for (const metric of metrics) {
  const cells = labels.map((l) => {
    const xs = samples.filter((s) => s.label === l && s.metric === metric).map((s) => s.ms);
    return xs.length ? { med: median(xs), n: xs.length } : null;
  });
  let change = '';
  if (labels.length === 2 && cells[0] && cells[1]) {
    change = ` ${Math.round(((cells[1].med - cells[0].med) / cells[0].med) * 100)}% |`;
  } else if (labels.length === 2) change = ' |';
  lines.push(`| ${metric} | ${cells.map((c) => (c ? `${c.med} ms (${c.n})` : '-')).join(' | ')} |${change}`);
}
const scroll = labels.map((l) => {
  const xs = samples.filter((s) => s.label === l && s.metric === 'list-scroll');
  if (!xs.length) return null;
  return `${l}: median ${median(xs.map((s) => s.long))} long frames of ${median(xs.map((s) => s.frames))}, worst ${median(xs.map((s) => s.worst))} ms`;
}).filter(Boolean);
// The slowest modules at start-up per app, by median over the launches.
const moduleSections = [];
for (const app of apps) {
  const runs = moduleRuns[app.label];
  if (!runs?.length) continue;
  let names = {};
  try { names = JSON.parse(fs.readFileSync(path.join(path.dirname(app.path), 'module-map.json'), 'utf8')); } catch { /* no map */ }
  const ids = new Set(runs.flatMap((r) => Object.keys(r.top)));
  const rows = [...ids]
    .map((id) => ({ id, ms: median(runs.map((r) => r.top[id] ?? 0)) }))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 30);
  moduleSections.push(
    `### Slowest modules at start-up: ${app.label} (own evaluation time, median of ${runs.length} launches; all modules ${median(runs.map((r) => r.total))} ms)`,
    '',
    '| module | ms |',
    '|---|---|',
    ...rows.map((r) => `| ${names[r.id] ?? `#${r.id}`} | ${r.ms} |`),
    '',
  );
}
const md = [...lines, '', ...scroll.map((s) => `- list-scroll ${s}`), '', ...moduleSections].join('\n');
fs.writeFileSync(path.join(out, 'perf.json'), JSON.stringify({ apps, rounds, coldRuns, samples }, null, 1));
fs.writeFileSync(path.join(out, 'perf.md'), md);
console.log(md);
if (final && process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Performance\n\n${md}\n`);
}

(async () => {
  await sleep(2000); // let the log stream attach
  for (let round = 1; round <= rounds; round++) {
    console.log(`round ${round}/${rounds}`);
    // Alternate the order too, so neither app always goes first.
    const order = round % 2 ? apps : [...apps].reverse();
    for (const app of order) {
      currentLabel = app.label;
      try { simctl('terminate', UDID, BUNDLE); } catch { /* not running */ }
      simctl('install', UDID, app.path);
      for (let i = 0; i < coldRuns; i++) await coldStart(app.label, round, i === 0);
      const got = await runFlows(app.label);
      for (const m of got) {
        const metric = m.n === 'tab-switch' && m.to ? `tab-switch:${m.to}` : m.n;
        samples.push({ label: app.label, round, metric, ms: m.ms, ...(m.long !== undefined ? { long: m.long, frames: m.frames, worst: m.worst } : {}) });
      }
    }
    // A job that runs out of time still leaves the rounds it finished.
    writeReport();
  }
  stream.kill();
  writeReport(true);
  process.exit(0);
})();
