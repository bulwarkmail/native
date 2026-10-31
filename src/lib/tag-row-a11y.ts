// What a tag picker row tells a screen reader. The rows drew a check mark
// but said nothing about it, so TalkBack read a tag as a plain button. As in
// the webmail tag picker (components/email/tag-picker.tsx, role
// menuitemcheckbox with aria-checked true / "mixed" / false): checked when
// every selected email has the tag, mixed when only some do.

export type TagCheckedState = boolean | 'mixed';

export function tagCheckedState(
  selectedEmails: ReadonlyArray<{ keywords?: Record<string, boolean> | null }>,
  token: string,
): TagCheckedState {
  if (selectedEmails.length === 0) return false;
  const withTag = selectedEmails.filter((e) => !!e.keywords?.[token]).length;
  if (withTag === 0) return false;
  return withTag === selectedEmails.length ? true : 'mixed';
}

/** The row's role and state props. */
export function tagRowAccessibility(checked: TagCheckedState): {
  accessibilityRole: 'checkbox';
  accessibilityState: { checked: TagCheckedState };
} {
  return { accessibilityRole: 'checkbox', accessibilityState: { checked } };
}
