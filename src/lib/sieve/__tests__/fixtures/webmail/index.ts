// Sieve scripts written by the webmail's own generator (jmap-webmail
// lib/sieve/generator.ts at e33ab899), used to check that a save on the
// phone gives back the same script. Each one was generated from the rules in
// its metadata for a server listing `extensions`.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface WebmailFixture {
  file: string;
  /** The server's sieveExtensions the webmail generated the script for. */
  extensions?: string[];
}

// A Stalwart 0.16 style extension list (a subset of what it advertises).
export const STALWART_EXTENSIONS = [
  'body', 'comparator-i;ascii-casemap', 'comparator-i;ascii-numeric', 'comparator-i;octet',
  'copy', 'date', 'envelope', 'fileinto', 'imap4flags', 'include', 'mailbox', 'mailboxid',
  'mime', 'regex', 'reject', 'relational', 'spamtest', 'spamtestplus', 'subaddress',
  'vacation', 'variables',
];

export const WEBMAIL_FIXTURES: WebmailFixture[] = [
  { file: 'vacation-include.sieve' },
  { file: 'folder-targets.sieve', extensions: ['fileinto', 'copy', 'imap4flags', 'mailbox', 'mailboxid'] },
  {
    file: 'spam-guard.sieve',
    extensions: ['fileinto', 'copy', 'relational', 'spamtest', 'spamtestplus', 'comparator-i;ascii-numeric'],
  },
  // Everything at once, plus a hand-written rule the webmail kept.
  { file: 'stalwart-full.sieve', extensions: STALWART_EXTENSIONS },
];

export function readWebmailFixture(file: string): string {
  // Git may check the fixture out with CRLF line ends on Windows.
  return readFileSync(join(__dirname, file), 'utf-8').replace(/\r\n/g, '\n');
}

/**
 * What the webmail itself writes when it saves the fixture again. That is the
 * fixture unchanged, except that both clients add two blank lines in front of
 * a script's external rules on every save (`<name>.resaved.sieve`).
 */
export function readWebmailResave(file: string): string {
  const resaved = file.replace(/\.sieve$/, '.resaved.sieve');
  return readWebmailFixture(existsSync(join(__dirname, resaved)) ? resaved : file);
}
