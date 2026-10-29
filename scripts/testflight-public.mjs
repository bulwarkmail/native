// Put an uploaded build on the public TestFlight link: wait until App Store
// Connect has processed it, add it to the external beta group, set its
// "What to Test" text and submit it for beta review. Builds only reach
// external testers (and so the public link) once Apple approves them.
//
//   node scripts/testflight-public.mjs <marketing version> <build number>
//
// Environment:
//   ASC_KEY_ID, ASC_ISSUER_ID   App Store Connect API key
//   ASC_KEY_PATH                the .p8 file (default ~/private_keys/AuthKey_<id>.p8)
//   BUNDLE_ID                   default org.bulwarkmail.mobile
//   TESTFLIGHT_GROUP            external group name (default "external")
//   WHATS_NEW                   "What to Test" text (default: link to the GitHub release)
//
// Every step can be repeated: a build already in the group, already described
// or already submitted is left as it is, so a re-run picks up where the last
// one stopped.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [version, buildNumber] = process.argv.slice(2);
if (!version || !buildNumber) {
  console.error('usage: node scripts/testflight-public.mjs <marketing version> <build number>');
  process.exit(2);
}

const keyId = process.env.ASC_KEY_ID;
const issuer = process.env.ASC_ISSUER_ID;
if (!keyId || !issuer) {
  console.error('ASC_KEY_ID and ASC_ISSUER_ID are required.');
  process.exit(2);
}
const keyPath = process.env.ASC_KEY_PATH || path.join(os.homedir(), 'private_keys', `AuthKey_${keyId}.p8`);
const privateKey = fs.readFileSync(keyPath, 'utf8');
const bundleId = process.env.BUNDLE_ID || 'org.bulwarkmail.mobile';
const groupName = process.env.TESTFLIGHT_GROUP || 'external';
const repo = process.env.GITHUB_REPOSITORY || 'bulwarkmail/native';
const whatsNew = process.env.WHATS_NEW || `Release notes: https://github.com/${repo}/releases/tag/${version}`;

// Processing usually takes 5-30 minutes; give up well inside the job timeout.
const PROCESSING_TIMEOUT_MS = 60 * 60 * 1000;
const POLL_MS = 30 * 1000;

function token() {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'ES256', kid: keyId, typ: 'JWT' });
  const body = b64({ iss: issuer, iat: now, exp: now + 15 * 60, aud: 'appstoreconnect-v1' });
  const sig = crypto
    .sign('sha256', Buffer.from(`${head}.${body}`), { key: privateKey, dsaEncoding: 'ieee-p1363' })
    .toString('base64url');
  return `${head}.${body}.${sig}`;
}

async function api(method, p, body) {
  const res = await fetch(`https://api.appstoreconnect.apple.com${p}`, {
    method,
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  return { status: res.status, ok: res.ok, json };
}

function fail(step, r) {
  const e = r.json?.errors?.[0];
  console.error(`${step} failed: ${r.status} ${e?.code ?? ''} ${e?.detail ?? e?.title ?? ''}`);
  if (e?.code === 'FORBIDDEN.REQUIRED_AGREEMENTS_MISSING_OR_EXPIRED') {
    console.error('An Apple agreement needs accepting in App Store Connect > Business.');
  }
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── The app and the group ──────────────────────────────────────
const apps = await api('GET', `/v1/apps?filter[bundleId]=${encodeURIComponent(bundleId)}&fields[apps]=name`);
if (!apps.ok) fail('Looking up the app', apps);
const app = apps.json.data[0];
if (!app) {
  console.error(`No app with bundle ID ${bundleId} in App Store Connect.`);
  process.exit(1);
}

const groups = await api(
  'GET',
  `/v1/betaGroups?filter[app]=${app.id}&filter[name]=${encodeURIComponent(groupName)}&fields[betaGroups]=name,isInternalGroup,publicLink,publicLinkEnabled`,
);
if (!groups.ok) fail('Looking up the beta group', groups);
const group = groups.json.data.find((g) => !g.attributes.isInternalGroup && g.attributes.name === groupName);
if (!group) {
  console.error(`No external beta group named "${groupName}".`);
  process.exit(1);
}

// ── Wait for the build ─────────────────────────────────────────
const query =
  `/v1/builds?filter[app]=${app.id}&filter[version]=${encodeURIComponent(buildNumber)}` +
  `&filter[preReleaseVersion.version]=${encodeURIComponent(version)}&fields[builds]=version,processingState`;
const started = Date.now();
let build;
for (;;) {
  const r = await api('GET', query);
  if (!r.ok) fail('Looking up the build', r);
  build = r.json.data[0];
  const state = build?.attributes.processingState;
  if (state === 'VALID') break;
  if (state === 'FAILED' || state === 'INVALID') {
    console.error(`Build ${version} (${buildNumber}) is ${state} in App Store Connect.`);
    process.exit(1);
  }
  if (Date.now() - started > PROCESSING_TIMEOUT_MS) {
    console.error(`Build ${version} (${buildNumber}) was not processed within an hour (state: ${state ?? 'not found'}).`);
    process.exit(1);
  }
  console.log(`Build ${version} (${buildNumber}): ${state ?? 'not visible yet'}, waiting…`);
  await sleep(POLL_MS);
}
console.log(`Build ${version} (${buildNumber}) is processed.`);

// ── Add it to the group ────────────────────────────────────────
const add = await api('POST', `/v1/betaGroups/${group.id}/relationships/builds`, {
  data: [{ type: 'builds', id: build.id }],
});
if (!add.ok) fail(`Adding the build to "${groupName}"`, add);
console.log(`Added to the "${groupName}" group.`);

// ── "What to Test" ─────────────────────────────────────────────
const locs = await api('GET', `/v1/builds/${build.id}/betaBuildLocalizations`);
if (!locs.ok) fail('Reading the build notes', locs);
const en = locs.json.data.find((l) => l.attributes.locale === 'en-US');
const notes = en
  ? await api('PATCH', `/v1/betaBuildLocalizations/${en.id}`, {
      data: { type: 'betaBuildLocalizations', id: en.id, attributes: { whatsNew } },
    })
  : await api('POST', '/v1/betaBuildLocalizations', {
      data: {
        type: 'betaBuildLocalizations',
        attributes: { locale: 'en-US', whatsNew },
        relationships: { build: { data: { type: 'builds', id: build.id } } },
      },
    });
if (!notes.ok) fail('Setting "What to Test"', notes);

// ── Beta review ────────────────────────────────────────────────
const detail = await api('GET', `/v1/builds/${build.id}/buildBetaDetail`);
if (!detail.ok) fail('Reading the build state', detail);
const external = detail.json.data.attributes.externalBuildState;
if (external === 'MISSING_EXPORT_COMPLIANCE') {
  console.error('The build has no export compliance answer; set usesNonExemptEncryption in app.config.js.');
  process.exit(1);
}
if (external === 'READY_FOR_BETA_SUBMISSION') {
  const submit = await api('POST', '/v1/betaAppReviewSubmissions', {
    data: { type: 'betaAppReviewSubmissions', relationships: { build: { data: { type: 'builds', id: build.id } } } },
  });
  if (!submit.ok) fail('Submitting for beta review', submit);
  console.log('Submitted for beta review.');
} else {
  console.log(`Not submitted again: the build is ${external}.`);
}

const link = group.attributes.publicLinkEnabled ? group.attributes.publicLink : null;
console.log(
  link
    ? `Testers with ${link} get it once Apple approves the build.`
    : `The "${groupName}" group has no public link enabled.`,
);
