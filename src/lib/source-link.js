// Where the About card sends "GitHub": the commit this build came from when
// the build knew it, else the repository. Plain CommonJS so app.config.js, which
// runs in Node before any bundling, and the app share one rule (see the .d.ts).

const REPO_URL = 'https://github.com/bulwarkmail/native';

const HOST = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i;
const PATH_SEGMENT = /^[\w.-]+$/;

function toHttpsRepo(host, path) {
  if (!HOST.test(host)) return undefined;
  const segments = path
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.git$/i, '')
    .split('/');
  if (segments.length < 2 || !segments.every((s) => s && s !== '.' && s !== '..' && PATH_SEGMENT.test(s))) {
    return undefined;
  }
  return `https://${host.toLowerCase()}/${segments.join('/')}`;
}

// Turns a git remote (scp-style, ssh://, git://, https://) into the https
// browsing URL of the repository, dropping credentials and any port. Returns
// undefined for anything else, including plain http and local paths.
function normalizeRemoteUrl(remote) {
  if (typeof remote !== 'string') return undefined;
  const raw = remote.trim();
  if (!raw) return undefined;

  const scp = /^(?:[\w.-]+@)?([^:/\s@]+):(?!\/\/)(.+)$/.exec(raw);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    return toHttpsRepo(scp[1], scp[2]);
  }

  const url = /^(https|ssh|git):\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(raw);
  if (url) return toHttpsRepo(url[2], url[3]);
  return undefined;
}

// `<sourceUrl>/commit/<sha>` when both are usable, else the repository. The
// result is always https.
function buildSourceLink(sourceUrl, commit) {
  const repo = normalizeRemoteUrl(sourceUrl);
  // A commit of some other repository would 404, so no known repo means no commit link.
  if (!repo) return REPO_URL;
  const sha = typeof commit === 'string' ? commit.trim() : '';
  return /^[0-9a-f]{7,40}$/i.test(sha) ? `${repo}/commit/${sha}` : repo;
}

module.exports = { REPO_URL, normalizeRemoteUrl, buildSourceLink };
