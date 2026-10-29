// SyncState `selected` names the collections whose rows are all on the
// device: a newly selected collection is loaded, a deselected one dropped.
// A load or a drop that stopped half-way must neither hide the collection
// from the next load nor keep its rows from the next drop.

import { describe, expect, it } from 'vitest';
import { Events } from '../../android-columns';
import { calendarPlanner } from '../../calendar/planner';
import { contactsPlanner } from '../../contacts/planner';
import { addServerCards, CALENDAR_AUTHORITY, createHarness, RUN_BUDGET, type Harness } from './harness';

function real(): Harness {
  const h = createHarness();
  h.deps.planners = { contacts: contactsPlanner, calendar: calendarPlanner };
  return h;
}

/** Runs out of time right after checkpoint `n` of the next run. */
function outOfTimeAt(h: Harness, n: number): void {
  h.checkpoints.count = 0;
  h.checkpoints.onCheckpoint = (count) => {
    if (count === n) h.clock.now += RUN_BUDGET;
  };
}

describe('device sync engine: collections loaded or dropped in part', () => {
  it('brings every card back when a book whose drop stopped half-way is selected again', async () => {
    const h = real();
    const work = h.server.addAddressBook('a', { name: 'Work' });
    addServerCards(h, ['Ada']);
    addServerCards(h, Array.from({ length: 120 }, (_, i) => `W${String(i).padStart(3, '0')}`), 'a', work);
    await h.run();
    expect(h.contacts()).toHaveLength(121);
    h.prefs.contactsSelection[`a/${work}`] = false;
    // 'changes', 'deselect' (sync), 'deselect' (chunk 1): out of time after the first chunk went.
    outOfTimeAt(h, 3);
    expect((await h.run()).outcome).toBe('cancelled');
    h.checkpoints.onCheckpoint = undefined;
    const left = h.contacts().length;
    expect(left).toBeGreaterThan(1);
    expect(left).toBeLessThan(121);

    h.prefs.contactsSelection[`a/${work}`] = true;
    expect((await h.run()).outcome).toBe('ok');

    expect(h.contacts()).toHaveLength(121);
    expect(h.state()?.accounts.a.selected.sort()).toEqual([`a/${h.book}`, `a/${work}`].sort());
  });

  it('finishes the drop of a book in the next run when it stopped half-way', async () => {
    const h = real();
    const work = h.server.addAddressBook('a', { name: 'Work' });
    addServerCards(h, ['Ada']);
    addServerCards(h, Array.from({ length: 120 }, (_, i) => `W${String(i).padStart(3, '0')}`), 'a', work);
    await h.run();
    h.prefs.contactsSelection[`a/${work}`] = false;
    outOfTimeAt(h, 3);
    expect((await h.run()).outcome).toBe('cancelled');
    h.checkpoints.onCheckpoint = undefined;

    expect((await h.run()).outcome).toBe('ok');

    expect(h.contacts().map((c) => c.name)).toEqual(['Ada']);
    expect(h.state()?.accounts.a.selected).toEqual([`a/${h.book}`]);
  });

  it('keeps a deselected book partial while a dirty card of it waits, and drops it once that is uploaded', async () => {
    const h = real();
    const work = h.server.addAddressBook('a', { name: 'Work' });
    addServerCards(h, ['Ada']);
    const [boss] = addServerCards(h, ['Boss', 'Colleague'], 'a', work);
    await h.run();
    const bossRow = h.contactNamed('Boss')!.id;
    const name = h.nameDataRow(bossRow)!;
    h.device.user.updateData(Number(name._id), { data1: 'The Boss' });
    h.server.setErrorFor('ContactCard', 'a', boss, { type: 'tooLarge' });
    h.prefs.contactsSelection[`a/${work}`] = false;

    await h.run();

    expect(h.contacts().map((c) => c.name).sort()).toEqual(['Ada', 'The Boss']);
    expect(h.state()?.accounts.a).toMatchObject({ selected: [`a/${h.book}`], partial: [`a/${work}`] });

    h.clock.now += 2 * 3_600_000;
    await h.run();

    expect(h.server.get('ContactCard', 'a', boss)).toMatchObject({ name: { full: 'The Boss' } });
    expect(h.contacts().map((c) => c.name)).toEqual(['Ada']);
    expect(h.state()?.accounts.a).toMatchObject({ selected: [`a/${h.book}`], partial: [] });
  });

  it('drops the cards of a book deselected again while its load had stopped half-way', async () => {
    const h = real();
    const work = h.server.addAddressBook('a', { name: 'Work' });
    h.prefs.contactsSelection[`a/${work}`] = false;
    addServerCards(h, ['Ada']);
    addServerCards(h, Array.from({ length: 120 }, (_, i) => `W${String(i).padStart(3, '0')}`), 'a', work);
    await h.run();
    expect(h.contacts()).toHaveLength(1);
    h.prefs.contactsSelection[`a/${work}`] = true;
    // 'changes', 'select', 'download' (chunk 1): out of time after the first chunk came.
    outOfTimeAt(h, 3);
    expect((await h.run()).outcome).toBe('cancelled');
    h.checkpoints.onCheckpoint = undefined;
    expect(h.contacts().length).toBeGreaterThan(1);

    h.prefs.contactsSelection[`a/${work}`] = false;
    expect((await h.run()).outcome).toBe('ok');

    expect(h.contacts().map((c) => c.name)).toEqual(['Ada']);
  });

  it('downloads every card of a book selected while a first sync was cut short', async () => {
    const h = createHarness();
    const extra = h.server.addAddressBook('a', { name: 'Friends' });
    const friends = addServerCards(h, Array.from({ length: 10 }, (_, i) => `F${i}`), 'a', extra);
    addServerCards(h, Array.from({ length: 120 }, (_, i) => `P${String(i).padStart(3, '0')}`));
    h.prefs.contactsSelection[`a/${extra}`] = false;
    // The first sync (a full reconcile): 'reconcile', 'reconcile:ids', 'reconcile:objects': out of time after chunk 1.
    outOfTimeAt(h, 3);
    expect((await h.run()).outcome).toBe('cancelled');
    h.checkpoints.onCheckpoint = undefined;
    const marker = h.state()!.accounts.a.reconcile!;
    expect(friends.filter((id) => id <= (marker.after as string)).length).toBeGreaterThan(0);

    // The user turns Friends on before the next sync.
    h.prefs.contactsSelection[`a/${extra}`] = true;
    expect((await h.run()).outcome).toBe('ok');

    const onDevice = new Set(h.contacts().map((c) => c.sourceId));
    expect(friends.filter((id) => !onDevice.has(`a/${id}`))).toEqual([]);
    expect(h.contacts()).toHaveLength(130);
    expect(h.state()!.accounts.a).toMatchObject({ reconcile: null });
    expect(h.state()!.accounts.a.selected.sort()).toEqual([`a/${h.book}`, `a/${extra}`].sort());
  });

  it('loads the events of a calendar dropped by a stopped run when it is selected again', async () => {
    const h = real();
    const holidays = h.server.addCalendar('a', { name: 'Holidays' });
    const sports = h.server.addCalendar('a', { name: 'Sports' });
    for (const [calendar, title] of [[holidays, 'Easter'], [holidays, 'Christmas'], [sports, 'Match']] as const) {
      h.server.addEvent('a', { uid: `u-${title}`, title, start: '2026-10-01T09:00:00', duration: 'PT1H', timeZone: 'Europe/Berlin', calendarIds: { [calendar]: true } });
    }
    await h.run(CALENDAR_AUTHORITY);
    expect(h.events()).toHaveLength(3);
    // Both deselected; the run is cancelled once the first calendar's rows are gone.
    h.prefs.calendarSelection[`a/${holidays}`] = false;
    h.prefs.calendarSelection[`a/${sports}`] = false;
    const original = h.deps.isCancelled;
    let cancelled = false;
    h.deps.isCancelled = async (runId) => {
      const left = h.events().length;
      if (!cancelled && left > 0 && left < 3) cancelled = true;
      return cancelled || original(runId);
    };
    expect((await h.run(CALENDAR_AUTHORITY)).outcome).toBe('cancelled');
    h.deps.isCancelled = original;
    const titles = () => h.events().map((e) => String(e[Events.TITLE])).sort();
    const dropped = titles().includes('Match') ? holidays : sports;
    const expected = dropped === holidays ? ['Christmas', 'Easter'] : ['Match'];

    h.prefs.calendarSelection[`a/${dropped}`] = true;
    expect((await h.run(CALENDAR_AUTHORITY)).outcome).toBe('ok');

    expect(titles()).toEqual(expected);
  });
});
