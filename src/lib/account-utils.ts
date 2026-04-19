export const MAX_ACCOUNTS = 5;

export function generateAccountId(username: string, serverUrl: string): string {
  let host = serverUrl;
  try {
    host = new URL(serverUrl).hostname;
  } catch {
    host = serverUrl.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  }
  return `${username}@${host}`;
}
