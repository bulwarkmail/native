// What a screen reader hears for the list's Select all checkbox.
//
// It used to say checked: 'mixed' while some rows were selected. Android
// writes "mixed" into the view's content description and, going back to
// checked: false, rebuilds that description only for a string state, so it
// kept saying "mixed" with nothing selected (seen in Trash). The count goes
// into the label instead: a changed label always rebuilds the description.

type Translate = (key: string, fallback: string, values?: Record<string, string | number>) => string;

export function selectAllA11y(
  allSelected: boolean,
  selectedCount: number,
  t: Translate,
): { label: string; checked: boolean } {
  const label = t('email_list.batch_actions.select_all', 'Select all');
  if (allSelected || selectedCount === 0) return { label, checked: allSelected };
  const selected = t(
    'email_list.batch_actions.selected_messages',
    '{count, plural, one {1 email} other {# emails}} selected',
    { count: selectedCount },
  );
  return { label: `${label}, ${selected}`, checked: false };
}
