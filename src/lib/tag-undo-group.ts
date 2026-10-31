// One Undo for everything changed in a tag sheet. The sheet stays open so
// several tags can be changed in a row (webmail setSelectionTagWithUndo), and
// it covers the undo bar while it is up: the changes join one Undo, and the
// bar shows for its full time once the sheet closes.

import React from 'react';
import { useEmailStore } from '../stores/email-store';

let seq = 0;

/** The undo group of a tag sheet while `open`; '' while it is closed. */
export function useTagUndoGroup(open: boolean): string {
  const group = React.useRef('');
  if (open && !group.current) group.current = `tags:${++seq}`;
  React.useEffect(() => {
    if (open || !group.current) return;
    const done = group.current;
    group.current = '';
    useEmailStore.getState().releaseUndoGroup(done);
  }, [open]);
  return open ? group.current : '';
}
