# Parity Phase 1: Security and Send Correctness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the three P1s and five security/send P2s from the webmail 1.10–1.12 delta. When this is done, no header, display name, unsubscribe link, Sieve value or `winmail.dat` a sender controls can fool the user or redirect mail, and the app never reports "sent" when nothing went out.

**Architecture:** Every task ports a fix the webmail already shipped, into the matching native module: `src/lib/*` for pure parsing, `src/api/email.ts` for the send request, `src/lib/sieve/*` for the filter script, and the screens/components that surface the results. The pure functions get unit tests. The UI changes stay thin and reuse one shared send-error helper.

**Tech Stack:** React Native / Expo, TypeScript, Zustand stores, vitest (`npm test`), JMAP (RFC 8620/8621) against Stalwart.

**Spec:** the Phase 1 rows of [2026-10-04-webmail-parity-roadmap.md](2026-10-04-webmail-parity-roadmap.md). Each row's finding, with WEB and RN pointers, is in the "Webmail 1.10.0 → 1.12.0+ delta" section of [docs/parity/03-email-viewer.md](../../parity/03-email-viewer.md), [04-composer-send.md](../../parity/04-composer-send.md) and [07-filters-vacation-files.md](../../parity/07-filters-vacation-files.md).

## Global Constraints

- **Webmail reference checkout:** `git clone https://github.com/bulwarkmail/webmail /tmp/webmail && git -C /tmp/webmail checkout a4e313f`. Below, "WEB `path`" means a path in that checkout.
- **Gate on every commit:** `npm run typecheck && npm test && npm run i18n:check` all pass.
- **User-visible strings:** use `t('key', 'English fallback')`, with the webmail key when the plan names one. Run `npm run i18n:harvest` when a key is new to both catalogs.
- **One commit per task:** `fix: …` or `feat: …` in the style of `git log`, with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Tick the finding in the same commit:** change its `- [ ]` to `- [x]` in its `docs/parity/*.md` delta section and append ` — fixed in <short hash>`. Do this by amending the task's commit after it exists (`git commit --amend --no-edit`), or put the hash in a follow-up `docs:` commit. Also tick the matching line in the `PARITY_CHECKLIST.md` P1 list for Tasks 1–3.
- **Keep scripts compatible with webmail:** a Sieve script saved by either client must read back on the other. Match WEB's generator output byte for byte where WEB's tests pin it.

## Review Focus

1. **A message with one `Authentication-Results` header and no forged one** must show exactly what it shows today. Covered by the existing `email-headers.test.ts` cases, which must stay green unchanged (Task 1).
2. **A send whose read-back (`EmailSubmission/get`) errors out or is missing** (older Stalwart, or a server without `deliveryStatus`) must count as a plain success, not a failure (Task 3, test `treats a missing or failed read-back as a plain success`).
3. **A held (undo-send) send with all recipients refused** must fail like an immediate one, and must not leave an undo bar for a message that never went out (Task 3, delayed-send test; Task 4 relies on the throw happening before `recordHeldSend`).
4. **An existing filter script saved by native before this change** (with `stop;` written after a move, and rule names that are already single-spaced) must regenerate byte-identically (Task 5, test `leaves a plain script byte-identical`).
5. **A plain `mailto:` link clicked in a message body** (not the unsubscribe banner) must still open the composer with all its addresses: only the banner gets the strict parser (Task 8, test `parseMailtoUrl still accepts several addresses`).

---

### Task 1: Read DKIM, DMARC and iprev from the topmost Authentication-Results header only

**Files:**
- Modify: `src/lib/email-headers.ts:106-168` (`parseAuthenticationResults`), `:259-264` (`deriveHeaderInfo`)
- Test: `src/lib/__tests__/email-headers.test.ts`

**Interfaces:**
- Produces: `parseAuthenticationResults(headers: string | readonly string[]): AuthenticationResults`, the same result type as today. A single string keeps working as a one-header list.

- [ ] **Step 1: Write the failing tests** (add to the `parseAuthenticationResults` describe)

```ts
it('takes DKIM and DMARC only from the topmost header', () => {
  const r = parseAuthenticationResults([
    'mx.example; spf=fail smtp.mailfrom=evil.example; dmarc=fail header.from=bank.example',
    'evil.example; dkim=pass header.d=bank.example; dmarc=pass header.from=bank.example',
  ]);
  expect(r.dmarc?.result).toBe('fail');
  expect(r.dkim).toBeUndefined();
});

it('ignores results inside comments and property values', () => {
  const r = parseAuthenticationResults(
    'mx.example; spf=pass smtp.mailfrom="dmarc=pass"@x.example (dkim=pass header.d=bank.example); dmarc=fail',
  );
  expect(r.dmarc?.result).toBe('fail');
  expect(r.dkim).toBeUndefined();
  expect(r.spf?.result).toBe('pass');
});

it('lets a lower header escalate SPF to a failure but never supply a pass', () => {
  expect(parseAuthenticationResults(['mx; spf=none smtp.mailfrom=a.example', 'x; spf=fail smtp.mailfrom=a.example']).spf?.result).toBe('fail');
  expect(parseAuthenticationResults(['mx; spf=fail smtp.mailfrom=a.example', 'x; spf=pass smtp.mailfrom=a.example']).spf?.result).toBe('fail');
  expect(parseAuthenticationResults(['mx; dkim=none', 'x; spf=pass smtp.mailfrom=a.example']).spf).toBeUndefined();
});
```

Also add one `deriveHeaderInfo` test. The input is `headers` with two `Authentication-Results` entries: the first `mx; spf=pass smtp.mailfrom=a.example`, the second `x; dmarc=pass`. Assert `info.auth?.dmarc` is `undefined`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/__tests__/email-headers.test.ts`
Expected: the four new tests FAIL (dmarc reads `pass`, or dkim is defined). The existing tests pass.

- [ ] **Step 3: Implement**

Port WEB `lib/email-headers.ts` `splitResinfo`, `parseResinfo`, `parseResinfos`, `METHOD_RE`, `PROP_RE`, `DMARC_SEVERITY` and the new `parseAuthenticationResults` body unchanged. The rule: DKIM, DMARC and iprev come from `perHeader[0]` only. SPF entries from the lower headers can only raise the severity to a failure (`severity >= SPF_SEVERITY.temperror`), and are never taken when they would be a pass. Keep the native `SpfEntry`/`AuthenticationResults` types and the `all` array.

In `deriveHeaderInfo`, pass `authHeaders` (the array, already in message order) instead of `authHeaders.join('; ')`, and fix the comment there.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/__tests__/email-headers.test.ts`
Expected: PASS, including every pre-existing case.

- [ ] **Step 5: Commit**

```bash
git add src/lib/email-headers.ts src/lib/__tests__/email-headers.test.ts docs/parity/03-email-viewer.md PARITY_CHECKLIST.md
git commit -m "fix: take DKIM and DMARC results only from the receiving server's own header"
```

---

### Task 2: Treat an escaped quote in a display name as part of the name

**Files:**
- Modify: `src/lib/recipients.ts` (`angleRunCloses` ~:58, `splitRecipients` :80, `findTopLevelColon` ~:155)
- Test: `src/lib/__tests__/recipients.test.ts`

**Interfaces:**
- Produces: no signature changes.

- [ ] **Step 1: Write the failing tests**

```ts
it('keeps an escaped quote inside the display name (no extra recipient)', () => {
  const input = '"Support\\", ceo@corp.example, \\"x" <support@shop.example>';
  expect(splitRecipients(input)).toEqual([input]);
});

it('round-trips a name containing quotes and commas', () => {
  const name = 'Support", ceo@corp.example, "x';
  const formatted = formatRecipient(name, 'support@shop.example');
  const parts = splitRecipients(`${formatted}, other@example.com`);
  expect(parts).toHaveLength(2);
  expect(parseRecipient(parts[0])).toEqual({ name, email: 'support@shop.example' });
});

it('does not open a group on a colon after an escaped quote', () => {
  const r = parseRecipient('"a\\": b" <a@example.com>');
  expect(r.group).toBeUndefined();
  expect(r.email).toBe('a@example.com');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/__tests__/recipients.test.ts`
Expected: the new tests FAIL. The first one splits into 3 entries.

- [ ] **Step 3: Implement**

The rule is the same in all three scanners: when the scanner is inside quotes and sees `\`, it consumes that character and the next one as a single quoted-pair (WEB `lib/email-composer-utils.ts:283-289`), so an escaped `"` never toggles `inQuotes`. In `splitRecipients`, append both characters to `current`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/__tests__/recipients.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/recipients.ts src/lib/__tests__/recipients.test.ts docs/parity/04-composer-send.md PARITY_CHECKLIST.md
git commit -m "fix: keep an escaped quote inside a recipient's display name"
```

---

### Task 3: Read the submission's deliveryStatus back, and refuse to call an unconfirmed send a success

**Files:**
- Modify: `src/api/jmap-result.ts` (next to `ScheduleTooLateError`, ~:84)
- Modify: `src/api/email.ts:1410-1419` (`SendEmailResult`), `:1535-1680` (`sendEmail`)
- Test: `src/api/__tests__/email-send-confirmation.test.ts` (new). Use the `vi.mock('../jmap-client', …)` setup from `src/api/__tests__/email-submission.test.ts:3-14`.
- Modify: existing tests that pin the exact method-call list of a send, so they expect the third call. Find them with `grep -rn "EmailSubmission/set" src/api/__tests__`.

**Interfaces:**
- Produces, in `src/api/jmap-result.ts`:
  - `interface RejectedRecipient { email: string; smtpReply: string }`
  - `function rejectedRecipients(deliveryStatus: Record<string, { delivered?: string; smtpReply?: string }> | null | undefined): { rejected: RejectedRecipient[]; all: boolean }`
  - `function formatRejectedRecipients(recipients: RejectedRecipient[]): string` produces `"a@x (550 5.1.2 …), b@y"`
  - `class RecipientsRejectedError extends Error { readonly recipients: RejectedRecipient[] }` with `name = 'RecipientsRejectedError'`
  - `class SendUnconfirmedError extends Error` with `name = 'SendUnconfirmedError'`
- Produces: `SendEmailResult.rejectedRecipients?: RejectedRecipient[]` (set only when some, not all, were refused).

- [ ] **Step 1: Write the failing tests**

Helper: `respond(extra)` resolves `mockRequest` with an `Email/set` created `{ draft: { id: 'email-9' } }` (call id `'0'`), an `EmailSubmission/set` created `{ 'sub-1': { id: 'sub-9' } }` (`'1'`), and then `extra` entries. Destroy calls go through `mockRequest` as well; assert on them through `mockRequest.mock.calls`.

```ts
it('asks for the new submission deliveryStatus in the send request', async () => {
  respond([['EmailSubmission/get', { list: [{ id: 'sub-9', deliveryStatus: {} }] }, 'deliveryStatus']]);
  await sendEmail(OUTGOING, 'id-1', 'sent-1');
  expect(mockRequest.mock.calls[0][0][2]).toEqual(
    ['EmailSubmission/get', { accountId: 'acc-1', ids: ['#sub-1'], properties: ['deliveryStatus'] }, 'deliveryStatus'],
  );
});

it('returns the refused recipients when the others were accepted', async () => {
  respond([['EmailSubmission/get', { list: [{ deliveryStatus: {
    'ok@example.com': { delivered: 'queued', smtpReply: '250 2.1.5 OK' },
    'gone@example.com': { delivered: 'no', smtpReply: '550 5.1.1 No such user' },
  } }] }, 'deliveryStatus']]);
  const result = await sendEmail(OUTGOING, 'id-1', 'sent-1');
  expect(result.rejectedRecipients).toEqual([{ email: 'gone@example.com', smtpReply: '550 5.1.1 No such user' }]);
});

it('fails the send, removes the filed copy and keeps the old draft when every recipient was refused', async () => {
  respond([['EmailSubmission/get', { list: [{ deliveryStatus: {
    'gone@example.com': { delivered: 'no', smtpReply: '550 5.1.1 No such user' },
  } }] }, 'deliveryStatus']]);
  mockRequest.mockResolvedValueOnce({ methodResponses: [['Email/set', { destroyed: ['email-9'] }, '0']] });
  const err = await sendEmail(OUTGOING, 'id-1', 'sent-1', undefined, { draftId: 'draft-1' }).catch((e) => e);
  expect(err).toBeInstanceOf(RecipientsRejectedError);
  expect(destroyedIds()).toEqual(['email-9']); // never 'draft-1'
});

it('also fails a held send whose recipients were all refused', async () => { /* holdForSeconds = 30, same expectation */ });

it('throws SendUnconfirmedError when the response has no EmailSubmission/set', async () => {
  mockRequest.mockResolvedValueOnce({ methodResponses: [['Email/set', { created: { draft: { id: 'email-9' } } }, '0']] });
  await expect(sendEmail(OUTGOING, 'id-1', 'sent-1')).rejects.toBeInstanceOf(SendUnconfirmedError);
  expect(destroyedIds()).toEqual([]); // the copy may be the only record that it went out
});

it('treats a missing or failed read-back as a plain success', async () => {
  respond([['error', { type: 'unknownMethod' }, 'deliveryStatus']]);
  await expect(sendEmail(OUTGOING, 'id-1', 'sent-1')).resolves.toMatchObject({ emailSubmissionId: 'sub-9' });
  respond([]);
  await expect(sendEmail(OUTGOING, 'id-1', 'sent-1')).resolves.toMatchObject({ emailSubmissionId: 'sub-9' });
});

it('reports a refused submission by its own error, not the dangling read-back', async () => {
  mockRequest.mockResolvedValueOnce({ methodResponses: [
    ['Email/set', { created: { draft: { id: 'email-9' } } }, '0'],
    ['EmailSubmission/set', { notCreated: { 'sub-1': { type: 'forbiddenFrom', description: 'Not allowed' } } }, '1'],
    ['error', { type: 'invalidResultReference' }, 'deliveryStatus'],
  ] });
  await expect(sendEmail(OUTGOING, 'id-1', 'sent-1')).rejects.toThrow('Not allowed');
});
```

Add unit tests for `rejectedRecipients` (an empty map gives `{ rejected: [], all: false }`; all refused gives `all: true`) and for `formatRejectedRecipients`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/api/__tests__/email-send-confirmation.test.ts`
Expected: FAIL. The imports don't exist yet.

- [ ] **Step 3: Implement**

- In `src/api/jmap-result.ts`, add the interfaces, helpers and errors listed above. Copy the text from WEB `lib/jmap/client.ts:756-796`, including the `SendUnconfirmedError` message.
- In `sendEmail`, append the read-back as the third method call: `['EmailSubmission/get', { accountId, ids: ['#sub-1'], properties: ['deliveryStatus'] }, 'deliveryStatus']`. This is a creation-id reference, not a `#ids` result reference; WEB `client.ts:719-731` explains why.
- In the response loop, set aside every entry whose call id is `'deliveryStatus'` before the existing handling, so an `error` from the read-back is never taken for a failed send or a filing problem. Keep its `list[0].deliveryStatus` only when the method name is `EmailSubmission/get`.
- After the loop, in this order:
  1. An existing `failure` keeps today's path.
  2. If there is no `emailSubmissionId`, throw `new SendUnconfirmedError()` without destroying anything.
  3. If `rejectedRecipients(...).all`, run the same cleanup as the failure path (destroy `emailId`, leave `opts.draftId` alone) and throw `RecipientsRejectedError`.
  4. Otherwise, return `rejectedRecipients` on the result when the list is non-empty.
- Step 3 must come before the old-draft cleanup at `:1664`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/api`
Expected: PASS, including the updated call-list assertions in the existing suites.

- [ ] **Step 5: Commit**

```bash
git add src/api/jmap-result.ts src/api/email.ts src/api/__tests__/ docs/parity/04-composer-send.md PARITY_CHECKLIST.md
git commit -m "fix: fail a send the server refused for every recipient, and never call an unconfirmed send sent"
```

---

### Task 4: Tell the user about refused recipients and unconfirmed sends

**Files:**
- Create: `src/lib/send-errors.ts`
- Modify: `src/screens/ComposeScreen.tsx:2105-2187` (send success branch and `catch`)
- Modify: `src/components/email/QuickReplyBox.tsx:102-142`
- Test: `src/lib/__tests__/send-errors.test.ts`

**Interfaces:**
- Consumes: `RecipientsRejectedError`, `SendUnconfirmedError`, `formatRejectedRecipients`, `SendEmailResult.rejectedRecipients` (Task 3); `RequestTimeoutError` (existing, `src/api/jmap-client.ts:1278`) and `ScheduleTooLateError` (existing, `src/api/jmap-result.ts:84`).
- Produces: `sendErrorAlert(e: unknown, t: (key: string, fallback?: string) => string): { title: string; message: string }`.

- [ ] **Step 1: Write the failing tests** (`t` is `(k, f) => f ?? k`)

```ts
it('lists the refused recipients with their SMTP replies', () => {
  const e = new RecipientsRejectedError([{ email: 'gone@example.com', smtpReply: '550 5.1.1 No such user' }]);
  expect(sendErrorAlert(e, t)).toEqual({
    title: 'Not sent - the server rejected every recipient.',
    message: 'gone@example.com (550 5.1.1 No such user)',
  });
});
it('points at Sent for a timeout and for an unconfirmed send', () => {
  const expected = {
    title: 'No answer from the server',
    message: 'The message may already have gone out. Check your Sent folder before sending it again.',
  };
  expect(sendErrorAlert(new RequestTimeoutError(), t)).toEqual(expected);
  expect(sendErrorAlert(new SendUnconfirmedError(), t)).toEqual(expected);
});
it('keeps the schedule-too-late copy and falls back to the error message', () => { /* … */ });
```

Construct `RequestTimeoutError` the way `src/api/__tests__/jmap-client-hardening.test.ts` does.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/__tests__/send-errors.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

- `sendErrorAlert` maps each error to an alert title and message:
  - `RecipientsRejectedError` → key `email_composer.send_recipients_rejected` (the webmail key), with the formatted list as the message.
  - `RequestTimeoutError` and `SendUnconfirmedError` → the existing `email_composer.send_timeout_title` / `send_timeout_body` copy.
  - `ScheduleTooLateError` → the existing `schedule_too_late_*` copy.
  - Anything else → `email_composer.send_failed` plus `e.message`.
- `ComposeScreen`: replace the three `catch` branches with `const { title, message } = sendErrorAlert(e, t); Alert.alert(title, message)`. A `RecipientsRejectedError` keeps the composer open, as every failure already does.
- `ComposeScreen` success path: after `sendEmail` returns and before the existing toast/undo branches, add one call when `result.rejectedRecipients?.length` is non-zero: `toast.warning(t('email_composer.send_some_recipients_rejected', 'Sent, but not to these recipients - the server rejected them.'), formatRejectedRecipients(result.rejectedRecipients))`.
- `QuickReplyBox`: use `sendErrorAlert` in its `catch`, and show the same warning toast on success.

- [ ] **Step 4: Run the tests and the i18n check**

Run: `npx vitest run src/lib/__tests__/send-errors.test.ts src/components/__tests__ && npm run i18n:check`
Expected: PASS. If `i18n:check` lists `send_recipients_rejected` / `send_some_recipients_rejected`, run `npm run i18n:harvest` and include `locales/rn/en.json`. They become webmail keys again at the next `sync-locales`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/send-errors.ts src/lib/__tests__/send-errors.test.ts src/screens/ComposeScreen.tsx src/components/email/QuickReplyBox.tsx locales/rn/en.json docs/parity/04-composer-send.md
git commit -m "fix: say which recipients the server refused, and point at Sent when a send is unconfirmed"
```

Device check: on Stalwart, send to `nobody@<your domain>` alone. You should see the alert, the composer should stay open, and nothing should appear in Sent. Then send to it plus a real address: you should see the warning toast and the message in Sent.

---

### Task 5: Escape every value written into the Sieve script, and keep spaced rule names single

**Files:**
- Modify: `src/lib/sieve/generator.ts:44-50` (size), `:80-82` (header name), `:339` (`# Rule:` line)
- Modify: `src/lib/sieve/parser.ts:836-841` (matching a block to its rule by name)
- Test: `src/lib/sieve/__tests__/generator.test.ts`, `src/lib/sieve/__tests__/parser.test.ts`

**Interfaces:**
- Produces: no signature changes.

- [ ] **Step 1: Write the failing tests**

```ts
// generator.test.ts
it('writes a rule name on one line with its whitespace collapsed', () => {
  const script = generateScript([makeRule({ name: 'Foo  Bar\nredirect "x@evil.example";' })]);
  expect(script).toContain('# Rule: Foo Bar redirect "x@evil.example";\n');
  expect(script).not.toMatch(/^redirect/m);
});
it('escapes a custom header name', () => {
  const script = generateScript([makeRule({ conditions: [{ field: 'header', headerName: 'X-A" :contains "B', comparator: 'contains', value: 'v' }] })]);
  expect(script).toContain('header :contains "X-A\\" :contains \\"B" "v"');
});
it('writes only a number with an optional K/M/G as a size, else 0', () => {
  const size = (value: string) => generateScript([makeRule({ conditions: [{ field: 'size', comparator: 'greater_than', value }] })]);
  expect(size('10M')).toContain('size :over 10M');
  expect(size('1; redirect "x@evil.example"')).toContain('size :over 0');
});
it('leaves a plain script byte-identical', () => {
  // Generate a fixture from today's main (a move + stop rule with a single-spaced name) and compare.
});

// parser.test.ts
it('reads a rule whose name has doubled or trailing spaces back as the same rule', () => {
  const rules = [makeRule({ name: 'Foo  Bar ' })];
  const parsed = parseScript(generateScript(rules));
  expect(parsed.rules.filter((r) => r.origin !== 'bulwark')).toEqual([]);
  expect(parsed.rules).toHaveLength(1);
});
```

The byte-identical fixture comes from WEB `lib/sieve/__tests__/generator.test.ts` (the `cbdc4de` hunk). Copy WEB's `generator-injection.test.ts` cases that apply to these three fields as well.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/sieve`
Expected: the new tests FAIL.

- [ ] **Step 3: Implement**

- Size: copy WEB `generator.ts` exactly. Take the trimmed raw value, test it against `/^\d+[KMG]?$/i`, and use `'0'` when it doesn't match.
- Header name: wrap it in `escapeString(...)`.
- Rule line: `# Rule: ${rule.name.replace(/\s+/g, ' ')}`.
- Parser: match `/#\s*Rule:[ \t]*(.*?)[ \t]*$/m`, and compare both sides through `oneLine = (s) => s.replace(/\s+/g, ' ').trim()` (WEB `cbdc4de`, `parser.ts:847-858`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/sieve`
Expected: PASS, including `webmail-fixtures.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/sieve docs/parity/07-filters-vacation-files.md
git commit -m "fix: escape header names, sizes and rule names in the filter script"
```

---

### Task 6: Stop after discard/reject, and understand the webmail's newer conditions

**Files:**
- Modify: `src/lib/sieve/types.ts:23-38`
- Modify: `src/lib/sieve/generator.ts` (`generateCondition` :43-108, stop logic :361-364)
- Modify: `src/lib/sieve/parser.ts` (`parseAtom` ~:335)
- Modify: `src/lib/sieve/condition-value.ts:26-48`
- Test: `src/lib/sieve/__tests__/generator.test.ts`, `parser.test.ts`, `condition-value.test.ts`

**Interfaces:**
- Produces:
  - `FilterConditionField` gains `'all'`.
  - `FilterComparator` gains `'address_is' | 'domain_is' | 'any'`. An `'all'` condition is always `{ field: 'all', comparator: 'any', value: '' }`.
  - `isValueLessCondition(cond: FilterCondition): boolean` in `condition-value.ts` is true for `has_any` and for `field === 'all'`. It replaces the `isHasAnyCondition` uses in `formatConditionValue`. Keep `isHasAnyCondition` exported for the modal until Task 7.

- [ ] **Step 1: Write the failing tests**

Copy WEB's `describe('all messages')` block from `lib/sieve/__tests__/generator.test.ts` (commit `c55b9f4`) unchanged. It pins `if true {`, `allof(true, <spam guard>)`, the `anyof`/`allof` mixes, `require ["imap4flags"];` and the read-back. Then add:

```ts
it('writes a stop after discard and reject when the rule says stop', () => {
  for (const type of ['discard', 'reject'] as const) {
    const script = generateScript([makeRule({ stopProcessing: true, actions: [{ type, value: 'no' }] })]);
    expect(script).toMatch(new RegExp(`${type}[^\\n]*;\\n    stop;\\n}`));
  }
});
it('writes no second stop when the last action is already stop', () => {
  const script = generateScript([makeRule({ stopProcessing: true, actions: [{ type: 'stop' }] })]);
  expect(script.match(/stop;/g)).toHaveLength(1);
});
it('writes address_is and domain_is as address tests', () => {
  const s = generateScript([makeRule({ conditions: [
    { field: 'from', comparator: 'address_is', value: 'anna@acme.com' },
    { field: 'to', comparator: 'domain_is', value: 'acme.com' },
  ] })]);
  expect(s).toContain('address :is "From" "anna@acme.com"');
  expect(s).toContain('address :domain :is "To" "acme.com"');
});
```

Parser: copy WEB `lib/sieve/__tests__/address-comparators.test.ts`. It covers metadata-less scripts and the reversed tag order `:is :domain`. In `condition-value.test.ts`, assert `describeCondition({ field: 'all', comparator: 'any', value: '' }, t)` is `'All messages'`, with a `t` that returns the fallback.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/sieve`
Expected: FAIL. `'all'` currently throws "Unsupported filter condition field".

- [ ] **Step 3: Implement**

- `generateCondition`: start with `if (field === 'all') return 'true';`. Before the `switch`, when the comparator is `address_is`/`domain_is` and the field is in `ADDRESS_FIELDS = new Set(['from', 'to', 'cc'])`, return `address ${part}:is "${headerName}" ${formatStringArg(values)}`. Use the same text as WEB `generator.ts:84-92`.
- Stop: `if (rule.stopProcessing && !actionLines.includes('stop;')) actionLines.push('stop;')`.
- Parser: port the `address` atom from WEB `parser.ts:456-470`. Also map a bare `true` atom to the `'all'` condition, so a script without metadata reads back too.
- `describeCondition`: for `field === 'all'`, return just the field label, using `settings.filters.condition_fields.all` ("All messages").

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/sieve && npm run typecheck`
Expected: PASS. Typecheck may flag exhaustive switches over `FilterComparator`/`FilterConditionField` in the UI. Give `'all'` and the new comparators sensible labels there; Task 7 adds the real UI.

- [ ] **Step 5: Commit**

```bash
git add src/lib/sieve docs/parity/07-filters-vacation-files.md
git commit -m "fix: stop after a silent delete or reject, and read the webmail's all-messages and address rules"
```

---

### Task 7: Offer "All messages", "is the address" and "has the domain" in the rule editor

**Files:**
- Modify: `src/components/filters/FilterRuleModal.tsx:42-50` (field and comparator lists), plus its condition row and save validation
- Test: `src/components/__tests__/filter-rule-modal.test.tsx` (new, or extend an existing component test if one covers the modal; check with `grep -rln FilterRuleModal src/components/__tests__`)

**Interfaces:**
- Consumes: `isValueLessCondition` (Task 6).
- Produces: none.

- [ ] **Step 1: Write the failing tests**

The test file should cover:
- Choosing the field "All messages" hides the comparator and value inputs and saves `{ field: 'all', comparator: 'any', value: '' }`.
- A rule with only that condition is saveable: the empty value is not flagged.
- For From/To/Cc the comparator list ends with `address_is` and `domain_is`. For Subject it doesn't include them.
- Opening a rule that already has an `'all'` condition shows "All messages" and doesn't crash.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/components/__tests__/filter-rule-modal.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

- Add `'all'` at the end of `ALL_FIELDS`, as webmail does.
- `comparatorsFor('all')` returns `['any']`. For `from`/`to`/`cc`, return `[...TEXT_COMPARATORS, 'address_is', 'domain_is']`.
- Switching a row to `'all'` resets it to `{ field: 'all', comparator: 'any', value: '' }`.
- Use `isValueLessCondition` wherever the modal hides the value input or skips the empty-value check.
- Labels: `settings.filters.condition_fields.all`, `settings.filters.comparators.address_is`, `settings.filters.comparators.domain_is` (webmail keys).

- [ ] **Step 4: Run the tests and the i18n check**

Run: `npx vitest run src/components && npm run i18n:check`
Expected: PASS. Harvest any key the vendored catalog doesn't have yet.

- [ ] **Step 5: Commit**

```bash
git add src/components/filters/FilterRuleModal.tsx src/components/__tests__ locales/rn/en.json docs/parity/07-filters-vacation-files.md
git commit -m "feat: add the all-messages condition and address/domain matching to the rule editor"
```

Device check: on the phone, create an "All messages → Mark as read" rule. Confirm webmail shows the same rule, then save once from each side; the script must not grow.

---

### Task 8: Send a mailto unsubscribe to one address only, and show what will be sent

**Files:**
- Modify: `src/lib/unsubscribe.ts` (add after `parseMailtoUrl`, ~:118)
- Modify: `src/components/email/UnsubscribeBanner.tsx:99-140`
- Test: `src/lib/__tests__/unsubscribe.test.ts`

**Interfaces:**
- Produces: `parseUnsubscribeMailto(url: string): { to: [string]; subject?: string; body?: string } | null`, plus `UNSUBSCRIBE_SUBJECT_MAX = 200` and `UNSUBSCRIBE_BODY_MAX = 500`.

- [ ] **Step 1: Write the failing tests**

```ts
it('takes exactly one recipient from the address part', () => {
  expect(parseUnsubscribeMailto('mailto:leave@list.example?subject=unsubscribe')).toEqual({ to: ['leave@list.example'], subject: 'unsubscribe' });
});
it('refuses a list of addresses', () => {
  expect(parseUnsubscribeMailto('mailto:a@x.example,b@y.example')).toBeNull();
});
it('ignores to= and cc= query fields', () => {
  expect(parseUnsubscribeMailto('mailto:leave@list.example?to=ceo@corp.example&cc=boss@corp.example'))
    .toEqual({ to: ['leave@list.example'] });
});
it('keeps the subject on one line and caps subject and body', () => {
  const r = parseUnsubscribeMailto(`mailto:l@x.example?subject=a%0D%0Ab&body=${'x'.repeat(600)}`)!;
  expect(r.subject).toBe('a b');
  expect(r.body).toHaveLength(500);
});
it('parseMailtoUrl still accepts several addresses', () => {
  expect(parseMailtoUrl('mailto:a@x.example,b@y.example')?.to).toEqual(['a@x.example', 'b@y.example']);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/__tests__/unsubscribe.test.ts`
Expected: the `parseUnsubscribeMailto` tests FAIL.

- [ ] **Step 3: Implement**

- Port WEB `lib/validation.ts:173-205` as `parseUnsubscribeMailto`, built on the native `parseMailtoUrl`.
- In the banner:
  - Parse with `parseUnsubscribeMailto`, once when rendering, so the confirmation can show the result.
  - Send only `to`/`subject`/`body`, with no `cc`.
  - When the link doesn't parse, hide the mailto option, just as an invalid http URL is hidden today.
- The `confirm()` alert message for mailto becomes `confirm_message_mailto` + `\n\n` + `to[0]`, then the subject and body on their own lines when present (WEB `unsubscribe-banner.tsx:45-51`).
- Leave `EmailBodyView`'s use of `parseMailtoUrl` alone (Review Focus 5).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/__tests__/unsubscribe.test.ts src/components`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/unsubscribe.ts src/lib/__tests__/unsubscribe.test.ts src/components/email/UnsubscribeBanner.tsx docs/parity/03-email-viewer.md
git commit -m "fix: send a mailto unsubscribe to the one listed address and show it before sending"
```

---

### Task 9: Bound the winmail.dat value loops

**Files:**
- Modify: `src/lib/tnef.ts:168-220` (`parseMAPIProps`)
- Test: `src/lib/__tests__/tnef.test.ts`

**Interfaces:**
- Produces: no signature changes.

- [ ] **Step 1: Write the failing tests**

`parseMAPIProps` is private, so these tests go through `parseTnef`. Build the file with the `u32`/`attr`/`bytes` helpers already at the top of `tnef.test.ts`, putting the MAPI block in an attachment-level attribute (`attAttachment`, the one the existing attachment test uses).

```ts
it('stops on a truncated variable-length value instead of spinning on the count', () => {
  // MAPI block: 1 prop, PT_BINARY (0x0102) id 0x3701, valueCount 0xFFFFFFFF, then a length (1000) larger than what is left.
  const mapi = [...u32(1), 0x02, 0x01, 0x01, 0x37, ...u32(0xffffffff), ...u32(1000)];
  const started = Date.now();
  expect(() => parseTnef(tnefWithAttachmentProps(mapi))).not.toThrow();
  expect(Date.now() - started).toBeLessThan(100);
});
it('stops a multi-value fixed run that consumes nothing', () => {
  // PT_MV_LONG (0x1003) with valueCount 0xFFFFFFFF and 2 bytes left.
  const mapi = [...u32(1), 0x03, 0x10, 0x00, 0x30, ...u32(0xffffffff), 0, 0];
  const started = Date.now();
  expect(() => parseTnef(tnefWithAttachmentProps(mapi))).not.toThrow();
  expect(Date.now() - started).toBeLessThan(100);
});
```

`tnefWithAttachmentProps(mapi: number[]): Uint8Array` is a new helper in the test file: the TNEF signature and key, then `attr(2, <attAttachment id>, mapi)`, as the existing attachment tests assemble theirs. Also copy the matching cases from WEB `lib/__tests__/tnef.test.ts`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/__tests__/tnef.test.ts`
Expected: the new tests FAIL (time out, or exceed the bound).

- [ ] **Step 3: Implement**

Port WEB `lib/tnef.ts:173-231`:
- Add `readValueCount(r) = Math.min(r.readUint32LE(), Math.floor(r.remaining / 4))`.
- Use it for both value counts.
- `break` when `readMAPIVarValue` returns `null`.
- `break` when `readMAPIFixedValue` leaves `r.remaining` unchanged.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/__tests__/tnef.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit and close the phase**

Update the counts table in `PARITY_CHECKLIST.md` (re-run the per-file count from the 2026-10-04 status note), then:

```bash
git add src/lib/tnef.ts src/lib/__tests__/tnef.test.ts docs/parity/03-email-viewer.md PARITY_CHECKLIST.md
git commit -m "fix: stop reading a winmail.dat value list that makes no progress"
npm run typecheck && npm test && npm run i18n:check
```

Expected: everything passes, and 8 more items are ticked. Phase 1's rows in the roadmap are done.
