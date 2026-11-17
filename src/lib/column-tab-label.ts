/**
 * What VoiceOver reads for a tab in the status column (SideColumnTabBar):
 * the tab's name, its badge if it has one, and its place among the tabs
 * (`position`, already translated: "1 of 5").
 */
export function columnTabLabel(name: string, badge: string | number | undefined | null, position: string): string {
  const parts = [name];
  if (badge != null && badge !== '') parts.push(String(badge));
  parts.push(position);
  return parts.join(', ');
}
