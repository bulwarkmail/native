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
  return {
    tag: json.tag_name,
    name: json.name || json.tag_name,
    htmlUrl: json.html_url,
    publishedAt: json.published_at,
    body: json.body || '',
    apkAsset,
  };
}
