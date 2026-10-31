import type { OrgPolicy } from '../../lib/org-policy';

/**
 * The theme cards the Themes page offers: every card but the built-in themes
 * the organisation's policy turns off (webmail themes-settings.tsx filters
 * them with isThemeDisabled). The default card (id null) always stays, so
 * there is something to pick.
 */
export function visibleThemeCards<T extends { id: string | null }>(
  cards: readonly T[],
  policy: OrgPolicy | null | undefined,
): T[] {
  const disabled = policy?.themePolicy.disabledBuiltinThemes ?? [];
  if (disabled.length === 0) return [...cards];
  return cards.filter((card) => card.id === null || !disabled.includes(card.id));
}
