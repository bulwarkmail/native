import { describe, it, expect } from 'vitest';
import { buildNoticeToasts, selectNoticeToasts } from '../calendar-event-notification-toast';

const t = (key: string, fallback?: string, params?: Record<string, string | number>) =>
  (fallback ?? key).replace(/\{(\w+)\}/g, (_m, k) => String(params?.[k] ?? ''));

const base = { id: 'n', created: '', comment: null, calendarEventId: 'ev1', isDraft: false, accountId: 'acc-1' };
const by = { name: 'Dana', email: 'dana@x.com', principalId: null, scheduleId: null };

describe('buildNoticeToasts', () => {
  it('maps created/updated/destroyed to info/info/warning and skips drafts', () => {
    const out = buildNoticeToasts([
      { ...base, id: '1', type: 'created', changedBy: by, event: { title: 'Lunch' } },
      { ...base, id: '2', type: 'updated', changedBy: by, event: { title: 'Lunch' } },
      { ...base, id: '3', type: 'destroyed', changedBy: by, event: { title: 'Lunch' } },
      { ...base, id: '4', type: 'created', changedBy: by, isDraft: true },
    ] as never, t as never);
    expect(out.map((o) => o.level)).toEqual(['info', 'info', 'warning']);
    expect(out[0].title).toBe('Dana invited you to "Lunch"');
    expect(out[1].title).toBe('Dana updated "Lunch"');
    expect(out[2].title).toBe('Dana cancelled "Lunch"');
  });

  it('falls back to email, someone and untitled', () => {
    const [a, b] = buildNoticeToasts([
      { ...base, id: '1', type: 'created', changedBy: { ...by, name: '' } },
      { ...base, id: '2', type: 'created', changedBy: { ...by, name: '', email: '' } },
    ] as never, t as never);
    expect(a.title).toBe('dana@x.com invited you to "Untitled event"');
    expect(b.title).toBe('Someone invited you to "Untitled event"');
  });

  it('truncates sender-controlled text and keeps it plain', () => {
    const long = 'x'.repeat(500);
    const [o] = buildNoticeToasts([
      { ...base, type: 'created', changedBy: { ...by, name: '<b>[Hi](http://evil)</b>' }, comment: long, event: { title: long } },
    ] as never, t as never);
    expect(o.message!.length).toBeLessThanOrEqual(200);
    expect(o.message!.endsWith('…')).toBe(true);
    expect(o.title.length).toBeLessThan(300);
    expect(o.title).toContain('<b>[Hi](http://evil)</b>'); // verbatim text, rendered as <Text>
  });

  it('strips control characters', () => {
    const [o] = buildNoticeToasts([
      { ...base, type: 'created', changedBy: { ...by, name: 'A\u0000B\u202eC' }, comment: 'l1\nl2\u0007' },
    ] as never, t as never);
    expect(o.title).not.toMatch(/[\u0000-\u0008\u202e]/);
    expect(o.message).toBe('l1\nl2');
  });

  it.each([
    ['a line feed', 'Dana\nYour account will be suspended'],
    ['an Arabic letter mark', 'Dana\u061cYour account will be suspended'],
    ['a line separator', 'Dana\u2028Your account will be suspended'],
  ])('keeps the sender name and event title on one line despite %s', (_what, value) => {
    const [o] = buildNoticeToasts([
      { ...base, type: 'created', changedBy: { ...by, name: value }, event: { title: value } },
    ] as never, t as never);
    expect(o.title).not.toMatch(/[\n\r\u061c\u2028\u2029]/);
    expect(o.title).toContain('Your account will be suspended');
  });

  it('offers Open only for a loadable, non-cancelled event on the active account', () => {
    const notes = [
      { ...base, id: '1', type: 'created', changedBy: by },
      { ...base, id: '2', type: 'destroyed', changedBy: by },
      { ...base, id: '3', type: 'updated', changedBy: by, calendarEventId: '' },
      { ...base, id: '4', type: 'updated', changedBy: by, accountId: 'other' },
    ] as never;
    const out = buildNoticeToasts(notes, t as never, 'acc-1');
    expect(out.map((o) => o.openEventId)).toEqual(['ev1', undefined, undefined, undefined]);
  });

  it('offers Open only when the app account matches too (JMAP ids repeat across servers)', () => {
    const notes = [{ ...base, id: '1', type: 'created', changedBy: by, appAccountId: 'app-1' }] as never;
    expect(buildNoticeToasts(notes, t as never, 'acc-1', 'app-1')[0].openEventId).toBe('ev1');
    expect(buildNoticeToasts(notes, t as never, 'acc-1', 'app-2')[0].openEventId).toBeUndefined();
    expect(buildNoticeToasts(notes, t as never, 'acc-1')[0].openEventId).toBeUndefined();
  });
});

describe('selectNoticeToasts', () => {
  const toasts = (n: number) => Array.from({ length: n }, (_v, i) => ({ id: `t${i}`, level: 'info' as const, title: `T${i}` }));

  it('shows up to three individually', () => {
    expect(selectNoticeToasts(toasts(0))).toEqual({ individual: [], overflow: 0 });
    expect(selectNoticeToasts(toasts(3)).individual.map((x) => x.id)).toEqual(['t0', 't1', 't2']);
    expect(selectNoticeToasts(toasts(3)).overflow).toBe(0);
  });

  it('adds at most `room` toasts when the host has less space', () => {
    expect(selectNoticeToasts(toasts(2), 2)).toEqual({ individual: toasts(2), overflow: 0 });
    const r = selectNoticeToasts(toasts(5), 2);
    expect(r.individual.map((x) => x.id)).toEqual(['t4']);
    expect(r.overflow).toBe(4);
    expect(selectNoticeToasts(toasts(5), 1)).toEqual({ individual: [], overflow: 5 });
  });

  it('for a bigger burst keeps the newest two and counts the rest', () => {
    const r = selectNoticeToasts(toasts(7));
    expect(r.individual.map((x) => x.id)).toEqual(['t5', 't6']);
    expect(r.overflow).toBe(5);
    expect(selectNoticeToasts(toasts(4))).toMatchObject({ overflow: 2 });
  });
});
