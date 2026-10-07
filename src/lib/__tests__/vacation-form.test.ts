import { describe, it, expect } from 'vitest';
import { translate } from '../../i18n';
import type { MessageParams } from '../../i18n';
import {
  audienceDomains,
  vacationErrorMessage,
  vacationFiltersForm,
  vacationFiltersWarnings,
  vacationSaveFailure,
  type FiltersFormInput,
} from '../vacation-form';
import { VacationFiltersError } from '../../stores/vacation-store';
import { OpaqueFiltersError } from '../filters/account-filters';
import { SieveCapabilitiesUnknownError } from '../../stores/filter-store';
import { AccountNotServedError } from '../../stores/email-store';
import { StaleLoadError } from '../../api/jmap-client';

// Records the keys asked for, answering with the English text.
function recorder() {
  const keys: string[] = [];
  const t = (key: string, fallback?: string, params?: MessageParams) => {
    keys.push(key);
    return translate('en', key, fallback, params);
  };
  return { t, keys };
}
const tEn = (key: string, fallback?: string, params?: MessageParams) => translate('en', key, fallback, params);

const FORWARD = { enabled: true, to: 'me@elsewhere.org', keepCopy: false };

function input(overrides: Partial<FiltersFormInput> = {}): FiltersFormInput {
  return {
    managed: false,
    forwardAvailable: true,
    audienceAvailable: true,
    domains: ['example.com'],
    storedForward: null,
    storedAudience: null,
    forwardEnabled: false,
    forwardTo: '',
    forwardKeep: false,
    audienceOnly: 'all',
    otherForwards: 0,
    forwardLimit: 1,
    notRunning: false,
    periodChanged: false,
    filtersStopped: false,
    includeAvailable: true,
    ...overrides,
  };
}

describe('audienceDomains', () => {
  const ids = [{ email: 'Me@Example.com' }, { email: 'alias@example.com' }, { email: 'x@other.net' }];

  it('takes the domains of the identities read for the account shown', () => {
    expect(audienceDomains(ids, 'srv|me|A', 'srv|me|A')).toEqual(['example.com', 'other.net']);
  });

  it('offers none when the identities belong to another account, or none were read', () => {
    expect(audienceDomains(ids, 'srv|me|A', 'srv|you|A')).toEqual([]);
    expect(audienceDomains(ids, null, 'srv|me|A')).toEqual([]);
    expect(audienceDomains(ids, 'srv|me|A', null)).toEqual([]);
    expect(audienceDomains(ids, null, null)).toEqual([]);
  });
});

describe('vacationFiltersForm: who can narrow the reply', () => {
  it('narrows when the server can, on the own account, with domains', () => {
    expect(vacationFiltersForm(input()).canNarrow).toBe(true);
  });

  it('does not on a managed account, without the server, or without domains', () => {
    expect(vacationFiltersForm(input({ managed: true })).canNarrow).toBe(false);
    expect(vacationFiltersForm(input({ audienceAvailable: false })).canNarrow).toBe(false);
    expect(vacationFiltersForm(input({ domains: [] })).canNarrow).toBe(false);
  });

  it('shows forwarding only where it is available and not on a managed account', () => {
    expect(vacationFiltersForm(input()).showForward).toBe(true);
    expect(vacationFiltersForm(input({ forwardAvailable: false })).showForward).toBe(false);
    expect(vacationFiltersForm(input({ managed: true })).showForward).toBe(false);
  });
});

describe('vacationFiltersForm: what a save sends', () => {
  it('sends nothing for the forward or audience when neither changed', () => {
    const form = vacationFiltersForm(input({
      storedForward: { ...FORWARD, activeFrom: '2026-10-10T00:00:00Z' },
      forwardEnabled: true, forwardTo: FORWARD.to,
      storedAudience: { only: 'internal', domains: ['example.com'] },
      audienceOnly: 'internal',
    }));
    expect(form.forward).toBeUndefined();
    expect(form.audience).toBeUndefined();
  });

  it('sends a forward that was turned on, edited or turned off', () => {
    expect(vacationFiltersForm(input({ forwardEnabled: true, forwardTo: FORWARD.to })).forward).toEqual(FORWARD);
    expect(vacationFiltersForm(input({
      storedForward: FORWARD, forwardEnabled: true, forwardTo: FORWARD.to, forwardKeep: true,
    })).forward).toEqual({ ...FORWARD, keepCopy: true });
    // Off, a usable address is kept for next time.
    expect(vacationFiltersForm(input({
      storedForward: FORWARD, forwardEnabled: false, forwardTo: FORWARD.to,
    })).forward).toEqual({ ...FORWARD, enabled: false });
  });

  it('drops a forward that is off with no usable address', () => {
    expect(vacationFiltersForm(input({
      storedForward: { ...FORWARD, enabled: false }, forwardEnabled: false, forwardTo: 'not an address',
    })).forward).toBeNull();
    // Nothing was stored, nothing is sent.
    expect(vacationFiltersForm(input({ forwardTo: 'half@' })).forward).toBeUndefined();
  });

  it('sends a changed audience, and null for everyone', () => {
    expect(vacationFiltersForm(input({ audienceOnly: 'external' })).audience)
      .toEqual({ only: 'external', domains: ['example.com'] });
    expect(vacationFiltersForm(input({
      storedAudience: { only: 'internal', domains: ['example.com'] }, audienceOnly: 'all',
    })).audience).toBeNull();
  });

  it('sends the audience again when the domains changed', () => {
    expect(vacationFiltersForm(input({
      storedAudience: { only: 'internal', domains: ['old.org'] }, audienceOnly: 'internal',
    })).audience).toEqual({ only: 'internal', domains: ['example.com'] });
  });

  it('sends neither on a managed account, whatever is stored', () => {
    const form = vacationFiltersForm(input({
      managed: true,
      storedForward: FORWARD, forwardEnabled: false,
      storedAudience: { only: 'internal', domains: ['example.com'] }, audienceOnly: 'all',
    }));
    expect(form.forward).toBeUndefined();
    expect(form.audience).toBeUndefined();
  });

  it('counts the forward and audience as involved when a save rewrites them', () => {
    const kept = { storedForward: FORWARD, forwardEnabled: true, forwardTo: FORWARD.to };
    const audience = { storedAudience: { only: 'external' as const, domains: ['example.com'] }, audienceOnly: 'external' as const };
    expect(vacationFiltersForm(input()).filtersInvolved).toBe(false);
    expect(vacationFiltersForm(input({ audienceOnly: 'internal' })).filtersInvolved).toBe(true);
    // Stored, untouched and running: only the dates or a restart bring them in.
    expect(vacationFiltersForm(input(kept)).filtersInvolved).toBe(false);
    expect(vacationFiltersForm(input({ ...kept, periodChanged: true })).filtersInvolved).toBe(true);
    expect(vacationFiltersForm(input({ ...kept, notRunning: true })).filtersInvolved).toBe(true);
    expect(vacationFiltersForm(input({ ...audience, notRunning: true })).filtersInvolved).toBe(true);
    // Hidden on a managed account, so never sent or rewritten from here.
    expect(vacationFiltersForm(input({ ...kept, managed: true, periodChanged: true, notRunning: true })).filtersInvolved).toBe(false);
  });
});

describe('vacationFiltersForm: checks', () => {
  it('blocks a forward that is on without a usable address', () => {
    const form = vacationFiltersForm(input({ forwardEnabled: true, forwardTo: 'nope' }));
    expect(form.forwardInvalid).toBe(true);
    expect(form.blocking).toBe(true);
    expect(vacationFiltersForm(input({ forwardEnabled: true, forwardTo: FORWARD.to })).blocking).toBe(false);
    expect(vacationFiltersForm(input({ forwardEnabled: false, forwardTo: 'nope' })).blocking).toBe(false);
  });

  it('flags a kept forward over the limit with the rules\' forwards', () => {
    const on = { forwardEnabled: true, forwardTo: FORWARD.to, forwardKeep: true };
    expect(vacationFiltersForm(input({ ...on, otherForwards: 1, forwardLimit: 1 })).forwardOverLimit).toBe(true);
    expect(vacationFiltersForm(input({ ...on, otherForwards: 0, forwardLimit: 1 })).forwardOverLimit).toBe(false);
    expect(vacationFiltersForm(input({ ...on, otherForwards: 1, forwardLimit: 2 })).forwardOverLimit).toBe(false);
    // Without keep-copy the rules never run, unknown or unlimited never trips.
    expect(vacationFiltersForm(input({ ...on, forwardKeep: false, otherForwards: 3 })).forwardOverLimit).toBe(false);
    expect(vacationFiltersForm(input({ ...on, otherForwards: 3, forwardLimit: undefined })).forwardOverLimit).toBe(false);
    expect(vacationFiltersForm(input({ ...on, otherForwards: 3, forwardLimit: 0 })).forwardOverLimit).toBe(false);
  });

  it('lets a save restart what is stored but not running', () => {
    expect(vacationFiltersForm(input()).restartable).toBe(false);
    expect(vacationFiltersForm(input({ notRunning: true })).restartable).toBe(true);
    expect(vacationFiltersForm(input({ filtersStopped: true, includeAvailable: true })).restartable).toBe(true);
    expect(vacationFiltersForm(input({ filtersStopped: true, includeAvailable: false })).restartable).toBe(false);
    // Forwarding and the audience are hidden there: saving does not set them right.
    expect(vacationFiltersForm(input({ notRunning: true, managed: true })).restartable).toBe(false);
  });
});

describe('vacationFiltersWarnings', () => {
  const warn = (o: Partial<FiltersFormInput>) => {
    const i = input(o);
    const { t, keys } = recorder();
    const texts = vacationFiltersWarnings(vacationFiltersForm(i), i, t);
    return { texts, keys };
  };

  it('says nothing when all is well', () => {
    expect(warn({}).texts).toEqual([]);
  });

  it('warns of an unusable address and of the forward limit', () => {
    expect(warn({ forwardEnabled: true, forwardTo: 'x' }).keys).toEqual(['settings.vacation.warnings.forward_address']);
    const over = warn({ forwardEnabled: true, forwardTo: FORWARD.to, forwardKeep: true, otherForwards: 1, forwardLimit: 1 });
    expect(over.keys).toEqual(['settings.filters.forward_limit']);
    expect(over.texts[0]).toContain('1');
  });

  it('keeps the not-running warning to forwarding and the audience', () => {
    expect(warn({ notRunning: true }).keys).toEqual(['settings.vacation.warnings.not_running']);
    expect(warn({ notRunning: true, managed: true }).keys).toEqual([]);
  });

  it('tells stopped filters apart by whether a save restarts them', () => {
    expect(warn({ filtersStopped: true, includeAvailable: true }).keys)
      .toEqual(['settings.vacation.warnings.filters_stopped_restart']);
    expect(warn({ filtersStopped: true, includeAvailable: false }).keys)
      .toEqual(['settings.vacation.warnings.filters_stopped_paused']);
  });
});

describe('vacation error messages', () => {
  it('maps the known errors to their own text', () => {
    const opaque = vacationErrorMessage(new OpaqueFiltersError(), tEn);
    const caps = vacationErrorMessage(new SieveCapabilitiesUnknownError(), tEn);
    const stale = vacationErrorMessage(new StaleLoadError(), tEn);
    const generic = vacationErrorMessage(new Error('Unusable vacation forwarding'), tEn);
    expect(new Set([opaque, caps, stale, generic]).size).toBe(4);
    expect(generic).not.toContain('Unusable');
    expect(vacationErrorMessage('boom', tEn)).toBe(generic);
  });

  it('keeps the already translated text of an account refusal', () => {
    const err = new AccountNotServedError('switched');
    expect(vacationErrorMessage(err, tEn)).toBe(err.message);
  });

  it('titles a filters-only failure as saved, by what it involved', () => {
    const { t, keys } = recorder();
    const involved = vacationSaveFailure(new VacationFiltersError(new Error('x')), true, t);
    expect(keys[0]).toBe('notifications.vacation_filters_save_failed');
    expect(involved.message).toBeUndefined();
    const plain = vacationSaveFailure(new VacationFiltersError(new Error('x')), false, t);
    expect(keys).toContain('notifications.vacation_filters_restart_failed');
    expect(plain.title).not.toBe(involved.title);
    expect(plain.title).not.toBe(tEn('notifications.vacation_save_failed'));
  });

  it('picks the filters-only title by what the save rewrote', () => {
    const err = new VacationFiltersError(new Error('x'));
    const restart = tEn('notifications.vacation_filters_restart_failed');
    const forwarding = tEn('notifications.vacation_filters_save_failed');
    const title = (o: Partial<FiltersFormInput>) =>
      vacationSaveFailure(err, vacationFiltersForm(input(o)).filtersInvolved, tEn).title;
    // A managed account with a stored forward.
    expect(title({ managed: true, storedForward: FORWARD, forwardEnabled: true, forwardTo: FORWARD.to, notRunning: true }))
      .toBe(restart);
    // The own account, its forward untouched and running: the save only restarted the filters.
    expect(title({ storedForward: FORWARD, forwardEnabled: true, forwardTo: FORWARD.to, filtersStopped: true }))
      .toBe(restart);
    // A forward sent.
    expect(title({ forwardEnabled: true, forwardTo: FORWARD.to })).toBe(forwarding);
  });

  it('explains a filters-only failure a hand edit caused', () => {
    const failure = vacationSaveFailure(new VacationFiltersError(new OpaqueFiltersError()), false, tEn);
    expect(failure.message).toBe(vacationErrorMessage(new OpaqueFiltersError(), tEn));
  });

  it('titles any other failure as not saved, with a translated reason', () => {
    const failure = vacationSaveFailure(new OpaqueFiltersError(), true, tEn);
    expect(failure.title).toBe(tEn('notifications.vacation_save_failed'));
    expect(failure.message).toBe(vacationErrorMessage(new OpaqueFiltersError(), tEn));
  });

  it('has every key in the English catalog', () => {
    const { t, keys } = recorder();
    const all = [
      input({ forwardEnabled: true, forwardTo: 'x' }),
      input({ forwardEnabled: true, forwardTo: FORWARD.to, forwardKeep: true, otherForwards: 1 }),
      input({ notRunning: true }),
      input({ filtersStopped: true, includeAvailable: true }),
      input({ filtersStopped: true, includeAvailable: false }),
    ];
    for (const i of all) vacationFiltersWarnings(vacationFiltersForm(i), i, t);
    for (const err of [new OpaqueFiltersError(), new SieveCapabilitiesUnknownError(), new StaleLoadError(), new Error('x')]) {
      vacationErrorMessage(err, t);
      vacationSaveFailure(err, false, t);
    }
    vacationSaveFailure(new VacationFiltersError(null), true, t);
    vacationSaveFailure(new VacationFiltersError(null), false, t);
    for (const key of new Set(keys)) expect(translate('en', key), key).not.toBe(key);
  });
});
