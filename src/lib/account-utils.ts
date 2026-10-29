// Registry cap. Raised from 5: the per-account cost is one stored credential
// set and one cached snapshot; the SSE socket budget is bounded separately
// (MAX_SSE_STREAMS), so nothing scales with this number at runtime.
export const MAX_ACCOUNTS = 10;

/** A new account would take the registry past MAX_ACCOUNTS. */
export class AccountLimitError extends Error {
  readonly limit = MAX_ACCOUNTS;

  constructor() {
    super(`Maximum of ${MAX_ACCOUNTS} accounts reached`);
    this.name = 'AccountLimitError';
  }
}

export function generateAccountId(username: string, serverUrl: string): string {
  let host = serverUrl;
  try {
    host = new URL(serverUrl).hostname;
  } catch {
    host = serverUrl.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  }
  return `${username}@${host}`;
}
