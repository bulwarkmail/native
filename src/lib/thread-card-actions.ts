// The Reply / Reply all / Forward row under an open message of a
// conversation. A draft or a scheduled message gets none (webmail
// email-viewer.tsx: the reply buttons render only `!isDraft && !isScheduled`);
// greyed-out buttons that a screen reader announced as enabled were left on
// drafts. A message whose body is still loading shows them disabled.

import type { Email } from '../api/types';
import { isReplyableMember } from './thread-utils';

export type CardReplyActions = 'hidden' | 'disabled' | 'enabled';

export function cardReplyActions(
  email: Pick<Email, 'id' | 'keywords'>,
  loaded: boolean,
  scheduledIds: ReadonlySet<string>,
): CardReplyActions {
  if (!isReplyableMember(email, scheduledIds)) return 'hidden';
  return loaded ? 'enabled' : 'disabled';
}
