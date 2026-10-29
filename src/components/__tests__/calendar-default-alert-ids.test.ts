import { describe, it, expect, vi } from 'vitest';

// The calendar sheet's default reminders. Alert ids must be unique in the
// account on Stalwart 1.0: an alert the lists can't show kept the id
// another client gave it, and when another calendar used that id too, the
// whole Calendar/set was refused, the new name and colour with it.

vi.mock('../icons', () => ({ Check: () => null, Plus: () => null, X: () => null }));
vi.mock('../Button', () => ({ default: () => null }));
vi.mock('../../lib/use-layout', () => ({ useSheetInsets: () => ({}) }));
vi.mock('../../theme/colors', () => ({ useColors: () => ({}) }));

import type { Alert } from '../../api/types';
import { defaultAlertsToSave } from '../calendar/CalendarEditSheet';

// An email alert: the reminder lists show display alerts only.
const email: Alert = { '@type': 'Alert', trigger: { '@type': 'OffsetTrigger', offset: '-PT30M', relativeTo: 'start' }, action: 'email' };

describe('the default alerts a calendar saves', () => {
  it('puts the alerts it keeps under the calendar\'s own ids too', () => {
    const timed = defaultAlertsToSave({ id: 'acc-2:b', originalId: 'b' }, false, [{ minutesBefore: 10 }], { 'default-1': email });
    const allDay = defaultAlertsToSave({ id: 'b' }, true, [], { x1: email });

    expect(timed).toEqual({
      'cal-b-timed-1': email,
      'cal-b-timed-2': expect.objectContaining({ action: 'display' }),
    });
    expect(allDay).toEqual({ 'cal-b-allday-1': email });
  });
});
