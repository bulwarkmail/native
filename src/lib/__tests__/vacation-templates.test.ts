import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  formatAbsenceDate,
  deputyFieldsNeeded,
  fillVacationTemplate,
  sortedVacationTemplates,
  vacationValues,
} from '../vacation-templates';
import { organisationFor, type OrgVacationTemplate } from '../org-organisation';
import { sanitizePolicy } from '../org-policy';

// The organisation's out-of-office templates (webmail lib/vacation-templates.ts,
// components/settings/vacation-template-picker.tsx).

const tpl = (over: Partial<OrgVacationTemplate> = {}): OrgVacationTemplate => ({
  id: 't1', name: 'Holiday', category: '', subject: 'Away until {end}', html: '',
  text: 'Hello,\nI am away from {start} until {end}.\nFor urgent matters write to {deputy_name} <{deputy}>.\nKind regards\n{name}\n{title}',
  ...over,
});

const base = {
  name: 'Ada Lovelace', email: 'ada@example.org', company: 'Example Ltd',
  from: new Date(2026, 11, 21), to: new Date(2027, 0, 4, 9, 30), locale: 'en-GB',
};

describe('vacation templates', () => {
  it('asks for the deputy only when the text names one', () => {
    expect(deputyFieldsNeeded(tpl())).toEqual({ address: true, name: true });
    expect(deputyFieldsNeeded(tpl({ text: 'Ask {deputy}.' }))).toEqual({ address: true, name: false });
    expect(deputyFieldsNeeded(tpl({ text: 'Away.', subject: 'Away' }))).toEqual({ address: false, name: false });
  });

  it('fills the text, dates in the user language, and keeps other braces as typed', () => {
    const filled = fillVacationTemplate(tpl(), vacationValues({ ...base, deputy: 'bob@example.org', deputyName: 'Bob' }));
    const start = formatAbsenceDate(base.from, 'en-GB');
    const end = formatAbsenceDate(base.to, 'en-GB');
    // The day alone at midnight, day and time otherwise.
    expect(start).toMatch(/21 December 2026$/);
    expect(end).toMatch(/4 January 2027.*9:30$/);
    expect(filled.subject).toBe(`Away until ${end}`);
    expect(filled.text).toBe([
      'Hello,',
      `I am away from ${start} until ${end}.`,
      'For urgent matters write to Bob <bob@example.org>.',
      'Kind regards',
      'Ada Lovelace',
      '{title}',
    ].join('\n'));
    expect(filled.html).toBe('');
  });

  it('drops a line whose placeholders are all empty, and closes up the subject', () => {
    const filled = fillVacationTemplate(
      tpl({ subject: 'Away until {end} ({company})' }),
      vacationValues({ ...base, from: null, to: null, company: '', deputy: 'bob@example.org', deputyName: 'Bob' }),
    );
    expect(filled.subject).toBe('Away until ()');
    expect(filled.text).not.toContain('away from');
  });

  it('escapes values in the HTML version', () => {
    const filled = fillVacationTemplate(
      tpl({ html: '<p>Ask {deputy_name}</p>', text: '' }),
      vacationValues({ ...base, deputy: 'x@example.org', deputyName: '<b>Bob</b>' }),
    );
    expect(filled.html).toBe('<p>Ask &lt;b&gt;Bob&lt;/b&gt;</p>');
    expect(filled.text).toBe('');
  });

  it('reads the library from the policy, adding up across scopes, sorted by category and name', () => {
    const policy = sanitizePolicy({
      organisation: { vacationTemplates: { library: [{ id: 'b', name: 'Sick', category: 'HR' }, { id: 'bad id', name: 'x' }] } },
      scopes: [{ id: 'eu', match: { domains: ['example.org'] }, policy: { organisation: { vacationTemplates: { library: [{ id: 'a', name: 'Holiday', category: '' }] } } } }],
    })!;
    const library = organisationFor(policy, { email: 'ada@example.org', groups: [] }).vacationTemplates.library;
    expect(sortedVacationTemplates(library).map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('is offered on the out-of-office page', () => {
    const page = readFileSync(join(__dirname, '../../components/settings/VacationSettings.tsx'), 'utf8');
    expect(page).toContain('const vacationLibrary = useAccountOrganisation().vacationTemplates.library;');
    expect(page).toMatch(/<VacationTemplatePicker\s+library=\{vacationLibrary\}/);
  });
});
