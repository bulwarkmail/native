export function parseVersion(v: string): [number, number, number] {
  const cleaned = v.replace(/^v/, '').split(/[-+]/)[0];
  const parts = cleaned.split('.').map((n) => parseInt(n, 10));
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

export function compareVersions(a: string, b: string): number {
  const [a1, a2, a3] = parseVersion(a);
  const [b1, b2, b3] = parseVersion(b);
  if (a1 !== b1) return a1 - b1;
  if (a2 !== b2) return a2 - b2;
  return a3 - b3;
}

export function isNewer(latest: string, current: string): boolean {
  return compareVersions(latest, current) > 0;
}
