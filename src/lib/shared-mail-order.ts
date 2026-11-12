/**
 * The order of the shared (group/delegated) accounts in the drawer's folder
 * list (webmail lib/shared-mail-order.ts, 2b3b672b7, 7ac6606f6). Stored per
 * login as JMAP accountIds; accounts not in the list keep their alphabetical
 * place after the listed ones, so a newly shared account lands at the end.
 * The phone has no dragging: the shared account's sheet moves it up or down.
 */

/** JMAP accountIds in display order for this login. */
export function sharedMailOrderIds(
  order: Record<string, string[]> | undefined,
  loginId: string | null | undefined,
): string[] {
  if (!loginId || !order) return [];
  const ids = order[loginId];
  return Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : [];
}

/**
 * The shared account nodes with the stored ones first, in the stored order,
 * and the rest after them in the order they came in (alphabetical).
 */
export function sortSharedMailAccounts<T extends { accountId?: string }>(nodes: T[], orderIds: string[] | undefined): T[] {
  if (!orderIds || orderIds.length === 0) return nodes;
  const rank = new Map<string, number>();
  orderIds.forEach((id, i) => {
    if (!rank.has(id)) rank.set(id, i);
  });
  const listed: T[] = [];
  const rest: T[] = [];
  for (const node of nodes) {
    if (node.accountId !== undefined && rank.has(node.accountId)) listed.push(node);
    else rest.push(node);
  }
  listed.sort((a, b) => rank.get(a.accountId!)! - rank.get(b.accountId!)!);
  return [...listed, ...rest];
}

/**
 * The order map with `accountId` moved one place up (-1) or down (+1) for a
 * login. `currentIds` is that login's full display order. Stored ids whose
 * account is not present now are kept after the present ones.
 */
export function moveSharedMailAccountBy(
  orderMap: Record<string, string[]>,
  loginId: string,
  currentIds: string[],
  accountId: string,
  delta: -1 | 1,
): Record<string, string[]> {
  const from = currentIds.indexOf(accountId);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= currentIds.length) return orderMap;
  const next = [...currentIds];
  next.splice(from, 1);
  next.splice(to, 0, accountId);
  const absent = sharedMailOrderIds(orderMap, loginId).filter((id) => !currentIds.includes(id));
  return { ...orderMap, [loginId]: [...next, ...absent] };
}
