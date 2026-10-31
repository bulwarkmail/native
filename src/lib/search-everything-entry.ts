// Where the mail search offers "Search everything" (the global search across
// mail, contacts, events and files). It was only a row in the panel under
// the focused field: once results loaded, the search and folder chips were
// drawn over it (the row took flex: 1 in a column, so its height wasn't
// counted), and when the field lost focus it was gone. The panel row keeps
// its own height now, and while a search or filter is on and the field is
// not focused, a chip at the front of the chip row stands in for it.

export type SearchEverythingPlacement = 'panel' | 'chips' | null;

export function searchEverythingPlacement(opts: {
  searchFocused: boolean;
  hasActiveSearchOrFilter: boolean;
}): SearchEverythingPlacement {
  if (opts.searchFocused) return 'panel';
  return opts.hasActiveSearchOrFilter ? 'chips' : null;
}
