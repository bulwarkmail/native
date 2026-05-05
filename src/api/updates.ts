export const UPDATE_REPO = 'bulwarkmail/native';

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

export interface LatestRelease {
  tag: string;
  name: string;
  htmlUrl: string;
  publishedAt: string;
  body: string;
  apkAsset: ReleaseAsset | null;
  // Lower-case hex SHA-256 of the APK, parsed from a `*.apk.sha256` companion
  // asset or from the release body. Null when the release didn't publish one;
  // the installer falls back to relying solely on Android's package signing
  // check in that case (still strong, but less defense-in-depth).
  apkSha256: string | null;
}

const SHA256_RE = /\b([a-f0-9]{64})\b/i;

function extractSha256(body: string, apkName: string | undefined): string | null {
  if (!body) return null;
  // Prefer a line that explicitly references the APK so we don't pick up the
  // hash of an unrelated asset.
  const lines = body.split(/\r?\n/);
  if (apkName) {
    for (const line of lines) {
      if (line.includes(apkName)) {
        const m = SHA256_RE.exec(line);
        if (m) return m[1].toLowerCase();
      }
    }
  }
  // Fallback: a single SHA256 anywhere in the body — common when the release
  // notes just list one checksum.
  const m = SHA256_RE.exec(body);
  return m ? m[1].toLowerCase() : null;
}

async function fetchCompanionSha256(asset: ReleaseAsset | undefined): Promise<string | null> {
  if (!asset) return null;
  try {
    const res = await fetch(asset.browser_download_url);
    if (!res.ok) return null;
    const text = await res.text();
    const m = SHA256_RE.exec(text);
    return m ? m[1].toLowerCase() : null;
  } catch {
    return null;
  }
}

export async function fetchLatestRelease(repo: string = UPDATE_REPO): Promise<LatestRelease | null> {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`GitHub API ${res.status}`);
  }
  const json = (await res.json()) as {
    tag_name: string;
    name: string;
    html_url: string;
    published_at: string;
    body: string;
    assets: ReleaseAsset[];
  };
  const apkAsset = json.assets.find((a) => a.name.endsWith('.apk')) ?? null;
  const sha256Asset = apkAsset
    ? json.assets.find(
        (a) => a.name === `${apkAsset.name}.sha256` || a.name === `${apkAsset.name}.SHA256`,
      )
    : undefined;
  const apkSha256 =
    (await fetchCompanionSha256(sha256Asset)) ??
    extractSha256(json.body || '', apkAsset?.name);
  return {
    tag: json.tag_name,
    name: json.name || json.tag_name,
    htmlUrl: json.html_url,
    publishedAt: json.published_at,
    body: json.body || '',
    apkAsset,
    apkSha256,
  };
}
