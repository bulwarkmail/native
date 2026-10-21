// Calls the test helper (scripts/e2e/helper.mjs) on the runner.
// env CALL: path and query, e.g. "/totp" or "/pair?user=x&deliver=openurl".
// The answer lands in output.helper.
const response = http.get(HELPER + CALL);
if (!response.ok) {
  throw new Error('helper ' + CALL.split('?')[0] + ' failed: ' + response.status + ' ' + response.body);
}
output.helper = json(response.body);
