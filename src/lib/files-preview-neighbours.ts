/**
 * The previous and next of `current` among `files`, by id, for the Files
 * preview's previous / next buttons (webmail previewNeighbours); undefined
 * where there is none, and both when `current` isn't among them.
 */
export function previewNeighbours<T extends { id: string }>(
  files: T[],
  current: { id: string } | null,
): { previous?: T; next?: T } {
  if (!current) return {};
  const i = files.findIndex((f) => f.id === current.id);
  if (i === -1) return {};
  return { previous: files[i - 1], next: files[i + 1] };
}
