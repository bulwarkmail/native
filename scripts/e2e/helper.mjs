#!/usr/bin/env node
// Test helper for the iOS simulator flows (.maestro/). Runs on the CI runner
// next to the simulator; Maestro flows call it from runScript over
// http://127.0.0.1:8787 for things a flow can't do itself:
//
//   GET /totp                         current TOTP code of the e2e-totp-* accounts
//   GET /pair?user=&deliver=          sign in to the test webmail with Playwright,
//                                     create a fresh "Link mobile app" code and hand
//                                     its bulwarkmail://pair link to the app
//                                     (deliver=openurl: simctl openurl, as a link
//                                     from another app; pbcopy: simctl pbcopy for
//                                     "Paste sign-in link"; none: keep it only)
//   GET /redeliver?user=&deliver=     hand the last link for that user over again
//   GET /pair-later?user=&deliver=&delay=   create a code now, deliver it after
//                                     <delay> seconds (expired-code test)
//   GET /send?to=&subject=&attach=1&html=1  userb sends a message over JMAP
//   GET /find?subject=&as=userb&timeout=    wait until a message with that subject
//                                     arrives; answers {found, attachments}
//   GET /openurl?url=                 simctl openurl for other links (mailto:, ...)
//   GET /clipboard?text=              simctl pbcopy of a plain value
//
// Secrets come from the environment and never appear in a response: the
// pairing link is delivered to the simulator directly, not returned. The
// answers are JSON. Logs go to stdout without secrets or links.
//
// Env: E2E_SERVER (JMAP server), E2E_PASSWORD (shared by the e2e accounts),
// E2E_USERB_PASSWORD, E2E_TOTP_SECRET (base32), E2E_WEBMAIL (test webmail base URL), UDID
// (booted simulator), PLAYWRIGHT_DIR (node_modules folder with playwright).

import http from 'node:http';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const PORT = Number(process.env.HELPER_PORT || 8787);
const SERVER = (process.env.E2E_SERVER || '').replace(/\/+$/, '');
const WEBMAIL = (process.env.E2E_WEBMAIL || 'https://bulwark.internal.bulwarkmail.org').replace(/\/+$/, '');
const PASSWORD = process.env.E2E_PASSWORD || '';
const TOTP_SECRET = process.env.E2E_TOTP_SECRET || '';
const UDID = process.env.UDID || 'booted';
const DOMAIN = 'example.org';

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ── TOTP (RFC 6238, SHA-1, 6 digits, 30 s) ──────────────────────────────────

function base32Decode(s) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of s.replace(/=+$/, '').toUpperCase()) {
    const idx = alphabet.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function totpAt(secret, time) {
  const counter = Math.floor(time / 30);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const offset = mac[mac.length - 1] & 0xf;
  const code = (mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, '0');
}

// A code with at least `minLeft` seconds to live, waiting for the next window
// when the current one is about to close.
async function freshTotp(minLeft = 10) {
  if (!TOTP_SECRET) throw new Error('E2E_TOTP_SECRET is not set');
  const now = Date.now() / 1000;
  const left = 30 - (now % 30);
  if (left < minLeft) await sleep((left + 0.5) * 1000);
  return totpAt(TOTP_SECRET, Date.now() / 1000);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── simulator ───────────────────────────────────────────────────────────────

function simctl(args, input) {
  return new Promise((resolve, reject) => {
    const child = execFile('xcrun', ['simctl', ...args], { timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`simctl ${args[0]} failed: ${stderr || err.message}`));
      else resolve(stdout);
    });
    if (input !== undefined) {
      child.stdin.end(input);
    }
  });
}

async function deliver(link, how) {
  if (how === 'openurl') await simctl(['openurl', UDID, link]);
  else if (how === 'pbcopy') await simctl(['pbcopy', UDID], link);
  else if (how !== 'none') throw new Error(`unknown deliver=${how}`);
}

// ── webmail pairing (Playwright) ────────────────────────────────────────────

let chromium = null;
function loadPlaywright() {
  if (chromium) return chromium;
  const dir = process.env.PLAYWRIGHT_DIR;
  const req = createRequire(dir ? path.join(dir, 'noop.js') : import.meta.url);
  ({ chromium } = req('playwright'));
  return chromium;
}

const lastLinks = new Map();

async function createPairingLink(user) {
  const browser = await loadPlaywright().launch();
  const started = Date.now();
  let page = null;
  try {
    const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 900 } });
    page = await context.newPage();
    await page.goto(`${WEBMAIL}/en/login`, { waitUntil: 'domcontentloaded' });
    await page.locator('#username').fill(`${user}@${DOMAIN}`);
    await page.locator('#password').fill(PASSWORD);
    // Keep the session across page loads (a Basic session without "remember
    // me" is signed out by the next navigation).
    const remember = page.getByRole('checkbox', { name: /remember/i });
    if (await remember.count()) await remember.first().check().catch(() => undefined);
    const totpField = page.locator('#totp');
    if (await totpField.isVisible().catch(() => false)) await totpField.fill(await freshTotp());
    await page.locator('button[type=submit]').first().click();

    // A TOTP account: the webmail asks for the code after the password.
    const signedIn = page.waitForURL((u) => !/\/login/.test(u.pathname), { timeout: 30_000 }).then(() => 'in');
    const askedCode = totpField.waitFor({ state: 'visible', timeout: 30_000 }).then(() => 'totp');
    const first = await Promise.race([signedIn, askedCode]);
    if (first === 'totp' && /\/login/.test(new URL(page.url()).pathname)) {
      await totpField.fill(await freshTotp());
      await page.locator('button[type=submit]').first().click();
      await page.waitForURL((u) => !/\/login/.test(u.pathname), { timeout: 30_000 });
    }

    await page.goto(`${WEBMAIL}/en/settings/security`, { waitUntil: 'domcontentloaded' });
    const show = page.getByRole('button', { name: /Show QR code/i });
    await show.waitFor({ timeout: 30_000 });
    await show.click();

    // Step-up: the password again (and a code for a TOTP account).
    const linkInput = page.locator('input[readonly][value^="bulwarkmail://"]');
    // The Security page has other password forms; use the link-device one.
    const form = page.locator('form', { hasText: /confirm it's you/i });
    const pw = form.locator('input[type=password]').first();
    await Promise.race([
      linkInput.waitFor({ timeout: 30_000 }),
      pw.waitFor({ timeout: 30_000 }),
    ]);
    if (!(await linkInput.count())) {
      await pw.fill(PASSWORD);
      // For a TOTP account the code field is there from the start.
      const codeField = form.locator('input:not([type=password])');
      if (await codeField.count()) await codeField.last().fill(await freshTotp());
      await form.getByRole('button', { name: /^Continue$/ }).click();
      const codeAsked = page.getByText(/code from your authenticator app/i);
      await Promise.race([
        linkInput.waitFor({ timeout: 30_000 }),
        codeAsked.waitFor({ timeout: 30_000 }),
      ]);
      if (!(await linkInput.count())) {
        if (!(await pw.inputValue())) await pw.fill(PASSWORD);
        await form.locator('input:not([type=password])').last().fill(await freshTotp());
        await form.getByRole('button', { name: /^Continue$/ }).click();
        await linkInput.waitFor({ timeout: 30_000 });
      }
    }
    const link = await linkInput.inputValue();
    if (!link.startsWith('bulwarkmail://pair?')) throw new Error('no pairing link on the page');
    log(`pair: code for ${user} after ${Date.now() - started} ms`);
    return link;
  } catch (err) {
    // What the webmail showed, for the run's artifacts (passwords are masked
    // on the page; a TOTP code is dead in 30 s).
    if (page && process.env.HELPER_SHOTS) {
      await page.screenshot({ path: path.join(process.env.HELPER_SHOTS, `pair-${user}-${Date.now()}.png`), fullPage: true }).catch(() => undefined);
    }
    throw err;
  } finally {
    await browser.close();
  }
}

// ── JMAP as userb (or any e2e account) ─────────────────────────────────────

const sessions = new Map();
async function jmapSession(user) {
  if (sessions.has(user)) return sessions.get(user);
  const pass = user === 'userb' && process.env.E2E_USERB_PASSWORD ? process.env.E2E_USERB_PASSWORD : PASSWORD;
  const auth = 'Basic ' + Buffer.from(`${user}@${DOMAIN}:${pass}`).toString('base64');
  const res = await fetch(`${SERVER}/.well-known/jmap`, { headers: { Authorization: auth } });
  if (!res.ok) throw new Error(`session for ${user}: HTTP ${res.status}`);
  const session = await res.json();
  const s = {
    auth,
    apiUrl: session.apiUrl,
    uploadUrl: session.uploadUrl,
    accountId: session.primaryAccounts['urn:ietf:params:jmap:mail'],
  };
  sessions.set(user, s);
  return s;
}

async function jmap(user, calls) {
  const s = await jmapSession(user);
  const res = await fetch(s.apiUrl, {
    method: 'POST',
    headers: { Authorization: s.auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail', 'urn:ietf:params:jmap:submission'],
      methodCalls: calls,
    }),
  });
  if (!res.ok) throw new Error(`JMAP as ${user}: HTTP ${res.status}`);
  return (await res.json()).methodResponses;
}

async function upload(user, data, type) {
  const s = await jmapSession(user);
  const res = await fetch(s.uploadUrl.replace('{accountId}', s.accountId), {
    method: 'POST',
    headers: { Authorization: s.auth, 'Content-Type': type },
    body: data,
  });
  if (!res.ok) throw new Error(`upload as ${user}: HTTP ${res.status}`);
  return (await res.json()).blobId;
}

async function sendMail({ from = 'userb', to, subject, text, html, attach }) {
  const s = await jmapSession(from);
  const [[, boxes], [, ids]] = await jmap(from, [
    ['Mailbox/get', { accountId: s.accountId, properties: ['role'] }, '0'],
    ['Identity/get', { accountId: s.accountId }, '1'],
  ]);
  const drafts = boxes.list.find((m) => m.role === 'drafts')?.id;
  const sent = boxes.list.find((m) => m.role === 'sent')?.id;
  const identity = ids.list.find((i) => i.email === `${from}@${DOMAIN}`) ?? ids.list[0];
  const email = {
    mailboxIds: { [drafts]: true },
    keywords: { $draft: true },
    from: [{ name: identity.name || from, email: `${from}@${DOMAIN}` }],
    to: [{ email: to.includes('@') ? to : `${to}@${DOMAIN}` }],
    subject,
    bodyValues: { t: { value: text || `Test message "${subject}" from the iOS simulator tests.\n` } },
    textBody: [{ partId: 't', type: 'text/plain' }],
  };
  if (html) {
    email.bodyValues.h = { value: `<html><body><h1 style="color:#2563eb">${subject}</h1><p>An <b>HTML</b> test message with a <a href="https://bulwarkmail.org">link</a>.</p><table border="1"><tr><td>cell 1</td><td>cell 2</td></tr></table></body></html>` };
    email.htmlBody = [{ partId: 'h', type: 'text/html' }];
  }
  if (attach) {
    const pdf = Buffer.from(
      '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj ' +
      '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 144]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj ' +
      '4 0 obj<</Length 44>>stream\nBT /F1 18 Tf 20 70 Td (E2E attachment) Tj ET\nendstream endobj ' +
      '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
    );
    const blobId = await upload(from, pdf, 'application/pdf');
    email.attachments = [{ blobId, type: 'application/pdf', name: 'e2e-attachment.pdf', disposition: 'attachment' }];
  }
  const resp = await jmap(from, [
    ['Email/set', { accountId: s.accountId, create: { m: email } }, '0'],
    ['EmailSubmission/set', {
      accountId: s.accountId,
      create: { s: { identityId: identity.id, emailId: '#m' } },
      onSuccessUpdateEmail: { '#s': { [`mailboxIds/${drafts}`]: null, [`mailboxIds/${sent}`]: true, 'keywords/$draft': null } },
    }, '1'],
  ]);
  const created = resp.find(([name, args]) => name === 'EmailSubmission/set' && args.created?.s);
  if (!created) throw new Error(`send failed: ${JSON.stringify(resp).slice(0, 400)}`);
  log(`send: ${from} -> ${to} "${subject}"`);
}

async function findMail({ as = 'userb', subject, timeout = 30 }) {
  const s = await jmapSession(as);
  const deadline = Date.now() + timeout * 1000;
  // Stalwart's subject filter finds nothing for "Re: x" or "Fwd: x" (it
  // indexes the base subject), so search without the prefixes and compare
  // the full subject below.
  const base = subject.replace(/^((re|fwd?|aw|wg)\s*:\s*)+/i, '');
  for (;;) {
    const [[, q], [, got]] = await jmap(as, [
      ['Email/query', { accountId: s.accountId, filter: { subject: base }, sort: [{ property: 'receivedAt', isAscending: false }], limit: 10 }, '0'],
      ['Email/get', { accountId: s.accountId, '#ids': { resultOf: '0', name: 'Email/query', path: '/ids' }, properties: ['subject', 'attachments', 'mailboxIds', 'from'] }, '1'],
    ]);
    const hit = got.list.find((m) => m.subject === subject);
    if (hit) {
      return {
        found: true,
        attachments: (hit.attachments || []).map((a) => a.name),
        from: hit.from?.[0]?.email ?? null,
      };
    }
    if (Date.now() > deadline) return { found: false, total: q.ids.length };
    await sleep(2000);
  }
}

// ── server ──────────────────────────────────────────────────────────────────

const routes = {
  async '/health'() {
    return { ok: true };
  },
  async '/totp'(q) {
    return { code: await freshTotp(Number(q.get('minLeft') || 10)) };
  },
  async '/pair'(q) {
    const user = q.get('user');
    const how = q.get('deliver') || 'openurl';
    const link = await createPairingLink(user);
    lastLinks.set(user, link);
    await deliver(link, how);
    return { ok: true };
  },
  async '/redeliver'(q) {
    const link = lastLinks.get(q.get('user'));
    if (!link) throw new Error('no link for that user yet');
    await deliver(link, q.get('deliver') || 'openurl');
    return { ok: true };
  },
  async '/pair-later'(q) {
    const user = q.get('user');
    const how = q.get('deliver') || 'openurl';
    const delay = Number(q.get('delay') || 130);
    const link = await createPairingLink(user);
    lastLinks.set(user, link);
    setTimeout(() => {
      deliver(link, how).then(() => log(`pair-later: delivered after ${delay}s`), (e) => log('pair-later:', e.message));
    }, delay * 1000);
    return { ok: true, deliverIn: delay };
  },
  async '/send'(q) {
    await sendMail({
      from: q.get('from') || 'userb',
      to: q.get('to'),
      subject: q.get('subject'),
      text: q.get('text') || undefined,
      html: q.get('html') === '1',
      attach: q.get('attach') === '1',
    });
    return { ok: true };
  },
  async '/find'(q) {
    return findMail({ as: q.get('as') || 'userb', subject: q.get('subject'), timeout: Number(q.get('timeout') || 30) });
  },
  async '/openurl'(q) {
    await simctl(['openurl', UDID, q.get('url')]);
    return { ok: true };
  },
  async '/clipboard'(q) {
    await simctl(['pbcopy', UDID], q.get('text') || '');
    return { ok: true };
  },
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const route = routes[url.pathname];
  res.setHeader('Content-Type', 'application/json');
  if (!route) {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }
  try {
    const body = await route(url.searchParams);
    log(`${url.pathname} ok`);
    res.end(JSON.stringify(body));
  } catch (err) {
    log(`${url.pathname} failed: ${err.message}`);
    res.statusCode = 500;
    res.end(JSON.stringify({ error: err.message }));
  }
}).listen(PORT, '127.0.0.1', () => log(`e2e helper on :${PORT}`));
