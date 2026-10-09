export const REPO_URL: string;
export function normalizeRemoteUrl(remote: unknown): string | undefined;
export function buildSourceLink(sourceUrl: unknown, commit: unknown): string;
export function commitOnOrigin(p: { ci: boolean; dirty: string; remoteBranches: string }): boolean;
