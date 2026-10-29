/**
 * Columns and cell width of the Files grid for a list `width` wide: as many
 * cells of at least `minCell` as fit, never fewer than three. Cells get a
 * fixed width, so a short last row keeps the columns of the rows above
 * instead of stretching its cells across the row.
 */
export function filesGridLayout(
  width: number,
  { minCell = 112, padding = 8, gap = 8 }: { minCell?: number; padding?: number; gap?: number } = {},
): { columns: number; cellWidth: number } {
  const inner = Math.max(0, width - padding * 2);
  const columns = Math.max(3, Math.floor((inner + gap) / (minCell + gap)));
  const cellWidth = Math.max(0, Math.floor((inner - gap * (columns - 1)) / columns));
  return { columns, cellWidth };
}
