import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const { mockSecureFetch } = vi.hoisted(() => ({
  mockSecureFetch: vi.fn(),
}));

vi.mock('../client-cert', () => ({
  secureFetch: mockSecureFetch,
}));

import {
  normalizeServerUrl,
  emailDomain,
  isEmailAddress,
  serverCandidates,
  probeJmapServer,
  resolveJmapServer,
  discoverServerForEmail,
  unsupportedProvider,
} from '../server-discovery';

const SESSION_DOC = { capabilities: {}, apiUrl: '/jmap/', primaryAccounts: {} };

/**
 * Answers `status` for the listed base URLs and rejects everything else. A 200
 * yields a JMAP session document unless a body is given explicitly.
 */
function respondFor(statuses: Record<string, number | { status: number; body: unknown }>) {
  mockSecureFetch.mockImplementation(async (url: string) => {
    const base = url.replace(/\/\.well-known\/jmap$/, '');
    const entry = statuses[base];
    if (entry === undefined) throw new TypeError('Network request failed');
    const { status, body } =
      typeof entry === 'number' ? { status: entry, body: SESSION_DOC } : entry;
    return { status, json: async () => body } as Response;
  });
}

describe('normalizeServerUrl', () => {
  it('adds https:// to a bare host', () => {
    expect(normalizeServerUrl('mail.example.com')).toBe('https://mail.example.com');
  });

  it('strips trailing slashes', () => {
    expect(normalizeServerUrl('https://mail.example.com//')).toBe('https://mail.example.com');
  });

  it('strips a pasted JMAP session endpoint', () => {
    expect(normalizeServerUrl('https://mail.example.com/.well-known/jmap')).toBe(
      'https://mail.example.com',
    );
    expect(normalizeServerUrl('mail.example.com/jmap')).toBe('https://mail.example.com');
  });

  it('strips a pasted session URL with its query or fragment (#971)', () => {
    expect(normalizeServerUrl('https://mail.example.com/jmap/session')).toBe('https://mail.example.com');
    expect(normalizeServerUrl('mail.example.com/jmap/session/')).toBe('https://mail.example.com');
    expect(normalizeServerUrl('https://mail.example.com/.well-known/jmap?x=1#top')).toBe(
      'https://mail.example.com',
    );
    expect(normalizeServerUrl('https://mail.example.com/?x=1')).toBe('https://mail.example.com');
  });

  it('keeps a base path prefix in front of the session suffix', () => {
    expect(normalizeServerUrl('https://example.com/mail/jmap/session')).toBe('https://example.com/mail');
    expect(normalizeServerUrl('https://example.com/mail/.well-known/jmap')).toBe('https://example.com/mail');
    expect(normalizeServerUrl('https://example.com/mail')).toBe('https://example.com/mail');
  });

  it('keeps an explicit http scheme and port', () => {
    expect(normalizeServerUrl('http://localhost:8080')).toBe('http://localhost:8080');
  });

  it('rejects non-http schemes', () => {
    expect(normalizeServerUrl('ftp://mail.example.com')).toBeNull();
    expect(normalizeServerUrl('bulwarkmail://connect')).toBeNull();
  });

  it('rejects input that is not a host', () => {
    expect(normalizeServerUrl('')).toBeNull();
    expect(normalizeServerUrl('   ')).toBeNull();
    expect(normalizeServerUrl('not a host')).toBeNull();
    expect(normalizeServerUrl('ada@example.com')).toBeNull();
    // A single label can't be a public host — except localhost.
    expect(normalizeServerUrl('example')).toBeNull();
    expect(normalizeServerUrl('localhost')).toBe('https://localhost');
  });
});

describe('emailDomain', () => {
  it('extracts and lowercases the domain', () => {
    expect(emailDomain('Ada@Example.COM')).toBe('example.com');
  });

  it('rejects anything that is not an address', () => {
    expect(emailDomain('ada')).toBeNull();
    expect(emailDomain('ada@localhost')).toBeNull();
    expect(emailDomain('a@b@example.com')).toBeNull();
    expect(isEmailAddress('ada@example.com')).toBe(true);
    expect(isEmailAddress('ada')).toBe(false);
  });
});

describe('unsupportedProvider', () => {
  it('names Gmail, Outlook.com and iCloud Mail, country variants too, and nothing else', () => {
    expect(unsupportedProvider('gmail.com')).toBe('Gmail');
    expect(unsupportedProvider('GoogleMail.co.uk')).toBe('Gmail');
    expect(unsupportedProvider('hotmail.de')).toBe('Outlook.com');
    expect(unsupportedProvider('live.co.uk')).toBe('Outlook.com');
    expect(unsupportedProvider('me.com')).toBe('iCloud Mail');
    expect(unsupportedProvider('example.org')).toBeNull();
    expect(unsupportedProvider('mail.gmail-fans.org')).toBeNull();
    expect(unsupportedProvider(null)).toBeNull();
  });

  it('stops the email step with the note before any lookup', () => {
    const source = readFileSync(join(__dirname, '..', '..', 'screens', 'LoginScreen.tsx'), 'utf8');
    const handler = source.slice(source.indexOf('const handleEmailContinue'), source.indexOf('const handleServerContinue'));
    expect(handler.indexOf('unsupportedProvider(emailDomain(value))')).toBeGreaterThan(0);
    expect(handler.indexOf('unsupportedProvider(emailDomain(value))')).toBeLessThan(handler.indexOf('discoverServerForEmail('));
    expect(handler).toContain("t('uxs_login.provider_unsupported',");
  });
});

describe('serverCandidates', () => {
  it('orders the bare domain ahead of the conventional subdomains', () => {
    expect(serverCandidates('example.com')).toEqual([
      'https://example.com',
      'https://mail.example.com',
      'https://webmail.example.com',
    ]);
  });
});

describe('probeJmapServer', () => {
  beforeEach(() => vi.clearAllMocks());

  it('treats 200 as a hit', async () => {
    respondFor({ 'https://mail.example.com': 200 });
    await expect(probeJmapServer('https://mail.example.com')).resolves.toBe(true);
  });

  it('treats 401 as a hit — an unauthenticated probe is meant to be rejected', async () => {
    respondFor({ 'https://mail.example.com': 401 });
    await expect(probeJmapServer('https://mail.example.com')).resolves.toBe(true);
  });

  it('treats 404 and transport failures as a miss', async () => {
    respondFor({ 'https://mail.example.com': 404 });
    await expect(probeJmapServer('https://mail.example.com')).resolves.toBe(false);
    await expect(probeJmapServer('https://nothing.example.com')).resolves.toBe(false);
  });

  it('rejects a 200 that is not a session document', async () => {
    // A catch-all web server or captive portal answering 200 for every path.
    respondFor({ 'https://example.com': { status: 200, body: '<!doctype html>' } });
    await expect(probeJmapServer('https://example.com')).resolves.toBe(false);
  });

  it('rejects a 200 whose body is not JSON at all', async () => {
    mockSecureFetch.mockResolvedValue({
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token <');
      },
    } as unknown as Response);
    await expect(probeJmapServer('https://example.com')).resolves.toBe(false);
  });

  it('gives up at the deadline instead of hanging', async () => {
    mockSecureFetch.mockImplementation(
      () => new Promise(() => {/* never settles */}),
    );
    await expect(probeJmapServer('https://slow.example.com', 20)).resolves.toBe(false);
  });
});

describe('resolveJmapServer', () => {
  beforeEach(() => vi.clearAllMocks());

  /** Every request is answered as if its redirects had ended at `finalUrl`. */
  function answeredAt(finalUrl: string, status = 200) {
    mockSecureFetch.mockResolvedValue({ status, url: finalUrl, json: async () => SESSION_DOC } as Response);
  }

  it('names the server the redirects led to, not the name that was tried (#95)', async () => {
    answeredAt('https://mail.example.com/jmap/session');
    await expect(resolveJmapServer('https://mail.example.org')).resolves.toBe('https://mail.example.com');
    answeredAt('https://mail.example.com/.well-known/jmap', 401);
    await expect(resolveJmapServer('https://mail.example.org')).resolves.toBe('https://mail.example.com');
  });

  it('keeps the name that was tried when the redirects stay on it', async () => {
    answeredAt('https://mail.example.org/jmap/session');
    await expect(resolveJmapServer('https://mail.example.org')).resolves.toBe('https://mail.example.org');
    answeredAt('https://MAIL.example.org:443/somewhere/else');
    await expect(resolveJmapServer('https://mail.example.org')).resolves.toBe('https://mail.example.org');
    mockSecureFetch.mockResolvedValue({ status: 200, json: async () => SESSION_DOC } as Response);
    await expect(resolveJmapServer('https://mail.example.org')).resolves.toBe('https://mail.example.org');
  });

  it('keeps a base path in front of the session path, and no other path', async () => {
    answeredAt('https://host.example.com/mail/jmap/session');
    await expect(resolveJmapServer('https://mail.example.org')).resolves.toBe('https://host.example.com/mail');
    answeredAt('https://host.example.com/api/v1/whoami');
    await expect(resolveJmapServer('https://mail.example.org')).resolves.toBe('https://host.example.com');
  });

  it('does not save a server the redirects reached over plain http', async () => {
    answeredAt('http://mail.example.com/jmap/session');
    await expect(resolveJmapServer('https://mail.example.org')).resolves.toBe('https://mail.example.org');
  });

  it('takes one unfollowed redirect to another host itself, as the client-certificate path leaves it', async () => {
    mockSecureFetch.mockImplementation(async (url: string) => {
      if (url.startsWith('https://mail.example.org/')) {
        return { status: 302, headers: new Headers({ Location: 'https://mail.example.com/.well-known/jmap' }) } as Response;
      }
      if (url === 'https://mail.example.com/.well-known/jmap') return { status: 401 } as Response;
      throw new TypeError('Network request failed');
    });
    await expect(resolveJmapServer('https://mail.example.org')).resolves.toBe('https://mail.example.com');
    expect(mockSecureFetch).toHaveBeenCalledTimes(2);
  });

  it('gives up on a second redirect and on one to plain http', async () => {
    mockSecureFetch.mockImplementation(async (url: string) => {
      const next = url.startsWith('https://a.example.org/') ? 'https://b.example.org/' : 'https://c.example.org/';
      return { status: 302, headers: new Headers({ Location: next }) } as Response;
    });
    await expect(resolveJmapServer('https://a.example.org')).resolves.toBeNull();
    expect(mockSecureFetch).toHaveBeenCalledTimes(2);

    mockSecureFetch.mockClear();
    mockSecureFetch.mockResolvedValue({ status: 302, headers: new Headers({ Location: 'http://mail.example.com/' }) } as Response);
    await expect(resolveJmapServer('https://mail.example.org')).resolves.toBeNull();
    expect(mockSecureFetch).toHaveBeenCalledTimes(1);
  });
});

describe('discoverServerForEmail', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns a known account server for the same domain without probing', async () => {
    respondFor({});
    const found = await discoverServerForEmail('ada@example.com', {
      knownServerUrls: ['https://mail.example.com'],
    });
    expect(found).toBe('https://mail.example.com');
    expect(mockSecureFetch).not.toHaveBeenCalled();
  });

  it('prefers the bare domain when several hosts answer', async () => {
    respondFor({ 'https://example.com': 401, 'https://mail.example.com': 200 });
    await expect(discoverServerForEmail('ada@example.com')).resolves.toBe('https://example.com');
  });

  it('falls back to mail.<domain> when the bare domain is not a JMAP server', async () => {
    respondFor({ 'https://example.com': 404, 'https://mail.example.com': 401 });
    await expect(discoverServerForEmail('ada@example.com')).resolves.toBe(
      'https://mail.example.com',
    );
  });

  it('skips a bare domain that only serves a marketing site', async () => {
    respondFor({
      'https://example.com': { status: 200, body: '<!doctype html>' },
      'https://mail.example.com': 200,
    });
    await expect(discoverServerForEmail('ada@example.com')).resolves.toBe(
      'https://mail.example.com',
    );
  });

  it('returns null when nothing answers, so the caller can ask', async () => {
    respondFor({});
    await expect(discoverServerForEmail('ada@example.org')).resolves.toBeNull();
  });

  it('returns null without touching the network for a non-address', async () => {
    respondFor({});
    await expect(discoverServerForEmail('ada')).resolves.toBeNull();
    expect(mockSecureFetch).not.toHaveBeenCalled();
  });

  it('probes an internationalized domain in its ASCII form (#1100)', async () => {
    respondFor({ 'https://xn--bcher-kva.de': 401 });
    await expect(discoverServerForEmail('jörg@Bücher.de')).resolves.toBe('https://xn--bcher-kva.de');
    expect(emailDomain('jörg@bücher.de')).toBe('xn--bcher-kva.de');
    expect(normalizeServerUrl('mail.bücher.de/jmap/session')).toBe('https://mail.xn--bcher-kva.de');
    expect(normalizeServerUrl('https://Mail.Bücher.de:8443')).toBe('https://mail.xn--bcher-kva.de:8443');
  });

  it('offers the server behind a name that only redirects to it (#95)', async () => {
    mockSecureFetch.mockImplementation(async (url: string) => {
      if (!url.startsWith('https://mail.example.org/')) throw new TypeError('Network request failed');
      return { status: 200, url: 'https://mail.example.com/jmap/session', json: async () => SESSION_DOC } as Response;
    });
    await expect(discoverServerForEmail('ada@example.org')).resolves.toBe('https://mail.example.com');
  });

  it('stops searching as soon as the sign-in is cancelled (U-133)', async () => {
    // Every host hangs; only the cancel can end the search before the deadline.
    mockSecureFetch.mockImplementation(() => new Promise(() => undefined));
    const controller = new AbortController();
    const started = Date.now();
    const search = discoverServerForEmail('ada@example.com', { timeoutMs: 60_000, signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await expect(search).resolves.toBeNull();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(mockSecureFetch.mock.calls[0][1].signal.aborted).toBe(true);
  });
});
