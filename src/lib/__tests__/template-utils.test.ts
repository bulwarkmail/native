import { describe, it, expect } from 'vitest';
import {
  extractPlaceholders,
  substitutePlaceholders,
  hasUnresolvedPlaceholders,
  getAutoFilledPlaceholders,
  exportTemplates,
  importTemplates,
  templateBodyToHtml,
  validateTemplateName,
  getPlaceholdersFromTemplate,
  getPlaceholderDefaults,
  placeholderPromptValues,
  embedTemplateImages,
} from '../template-utils';

describe('placeholders', () => {
  it('extracts unique placeholder names', () => {
    expect(extractPlaceholders('Hi {{recipient_name}}, {{date}} {{recipient_name}}')).toEqual(['recipient_name', 'date']);
  });

  it('substitutes known values and leaves the others', () => {
    expect(substitutePlaceholders('Hi {{a}} {{b}}', { a: 'x' })).toBe('Hi x {{b}}');
    expect(hasUnresolvedPlaceholders('Hi {{b}}')).toBe(true);
    expect(hasUnresolvedPlaceholders('Hi')).toBe(false);
  });

  // Ported from the webmail's lib/__tests__/template-utils.test.ts (#1609).
  it('escapes values going into an HTML template and keeps them as typed in a plain one', () => {
    expect(substitutePlaceholders('<p>{{name}}</p>', { name: 'Smith <j@x.com>' }, { html: true })).toBe('<p>Smith &lt;j@x.com&gt;</p>');
    expect(substitutePlaceholders('To {{name}}', { name: 'Smith & Co <j@x.com>' })).toBe('To Smith & Co <j@x.com>');
  });

  it('knows a placeholder with a default', () => {
    expect(extractPlaceholders('From {{time:15:00}} for {{guests:2}}, {{time}}')).toEqual(['time', 'guests']);
    expect(substitutePlaceholders('At {{time:15:00}}, again {{time}}', { time: '17:00' })).toBe('At 17:00, again 17:00');
    expect(substitutePlaceholders('At {{time:15:00}}', {})).toBe('At {{time:15:00}}');
    expect(hasUnresolvedPlaceholders('Hello {{name:Ada}}')).toBe(true);
  });

  it('auto-fills date, weekday and sender', () => {
    const v = getAutoFilledPlaceholders({ senderName: 'Jane', locale: 'en' });
    expect(v.sender_name).toBe('Jane');
    expect(v.date.length).toBeGreaterThan(0);
    expect(v.day_of_week.length).toBeGreaterThan(0);
  });

  it('validates names', () => {
    expect(validateTemplateName('  ')).toBe('empty');
    expect(validateTemplateName('x'.repeat(201))).toBe('too_long');
    expect(validateTemplateName('ok')).toBeNull();
  });
});

describe('export / import', () => {
  const tpl = {
    id: 't1', name: 'Hello', subject: 'S', body: 'B', category: 'c', isFavorite: true,
    isHTML: false, defaultRecipients: { to: ['a@b.c'] }, identityId: 'id1',
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  };

  it('emits the webmail envelope', () => {
    const parsed = JSON.parse(exportTemplates([tpl]));
    expect(parsed.type).toBe('webmail-templates');
    expect(parsed.version).toBe(1);
    expect(typeof parsed.exportedAt).toBe('string');
    expect(parsed.templates[0].defaultRecipients).toEqual({ to: ['a@b.c'] });
  });

  it('round-trips isHTML / defaultRecipients / identityId with fresh ids', () => {
    const { templates, errors } = importTemplates(exportTemplates([tpl]));
    expect(errors).toEqual([]);
    expect(templates).toHaveLength(1);
    expect(templates[0].id).not.toBe('t1');
    expect(templates[0]).toMatchObject({ name: 'Hello', isHTML: false, identityId: 'id1', defaultRecipients: { to: ['a@b.c'] }, isFavorite: true });
  });

  it('rejects foreign envelopes and bad JSON', () => {
    expect(importTemplates('{"type":"other","templates":[]}').errors).toEqual(['invalid_type']);
    expect(importTemplates('nope').errors).toEqual(['invalid_json']);
    expect(importTemplates('{"templates":[{"body":"x"}]}').errors).toEqual(['missing_template_name']);
  });

  it('accepts the legacy RN export without a type', () => {
    expect(importTemplates('{"version":1,"templates":[{"name":"n","body":"b"}]}').templates).toHaveLength(1);
  });

  it('escapes plain-text bodies for the editor', () => {
    expect(templateBodyToHtml({ body: 'a<b\nc', isHTML: false })).toBe('<p>a&lt;b<br>c</p>');
    expect(templateBodyToHtml({ body: '<p>x</p>', isHTML: true })).toBe('<p>x</p>');
  });
});

describe('placeholder defaults', () => {
  const tpl = (t: { subject?: string; body: string; isHTML?: boolean }) => ({ subject: '', isHTML: false, ...t });

  it('returns the first default of each placeholder, subject first', () => {
    const t = tpl({
      subject: 'Stay from {{arrival:Sat 13 Feb}}',
      body: '{{greeting}}, see you {{arrival:Sun 14 Feb}} at {{time:15:00}} with {{guests}} {{guests:2}}',
    });
    expect(getPlaceholdersFromTemplate(t)).toEqual(['arrival', 'greeting', 'time', 'guests']);
    expect(getPlaceholderDefaults(t)).toEqual(new Map([['arrival', 'Sat 13 Feb'], ['time', '15:00'], ['guests', '2']]));
  });

  it('decodes the default in an HTML body, not in a plain one', () => {
    expect(getPlaceholderDefaults(tpl({ body: '<p>{{company:Smith &amp; Co}}</p>', isHTML: true })))
      .toEqual(new Map([['company', 'Smith & Co']]));
    expect(getPlaceholderDefaults(tpl({ body: '{{company:Smith &amp; Co}}' })))
      .toEqual(new Map([['company', 'Smith &amp; Co']]));
  });

  it('takes no default across a tag or a line break', () => {
    expect(getPlaceholderDefaults(tpl({ body: '<p>{{name:<b>Ada</b>}}</p>', isHTML: true }))).toEqual(new Map());
    expect(getPlaceholderDefaults(tpl({ body: '{{name:Ada\nLovelace}}' }))).toEqual(new Map());
  });

  it('gives an HTML default back escaped when it is substituted', () => {
    const t = tpl({ body: '<p>{{name:&lt;img src=x onerror=alert(1)&gt;}}</p>', isHTML: true });
    const name = getPlaceholderDefaults(t).get('name')!;
    expect(substitutePlaceholders(t.body, { name }, { html: true })).toBe('<p>&lt;img src=x onerror=alert(1)&gt;</p>');
  });

  it('takes a default with an address in a subject or a plain body', () => {
    const t = tpl({ subject: 'For {{contact:Jane <jane@x.com>}}', body: 'Copy {{cc:Bob <bob@x.com>}}' });
    expect(getPlaceholdersFromTemplate(t)).toEqual(['contact', 'cc']);
    expect(getPlaceholderDefaults(t)).toEqual(new Map([['contact', 'Jane <jane@x.com>'], ['cc', 'Bob <bob@x.com>']]));
  });

  // A webmail template with {{checkin_time:15:00}} got no fill sheet in the app.
  it('asks for a placeholder with a default and starts its field with the default', () => {
    const t = tpl({ subject: 'Your stay', body: 'Check-in from {{checkin_time:15:00}}, {{sender_name}}' });
    expect(placeholderPromptValues(t, { sender_name: 'Ada' })).toEqual({ checkin_time: '15:00' });
    expect(placeholderPromptValues(tpl({ body: 'Hi {{guest}}' }), {})).toEqual({ guest: '' });
    expect(placeholderPromptValues(tpl({ body: 'On {{date}}' }), { date: '1 May' })).toEqual({});
  });
});

// Webmail #1492: a template's pictures went out as data: URIs that Gmail and
// Outlook don't show. They are uploaded and sent as inline cid: parts.
describe('embedTemplateImages', () => {
  const PNG = 'data:image/png;base64,iVBORw0KGgo=';

  it('uploads each data: image once and tags it with its cid', async () => {
    const uploads: Array<{ type: string; size: number; name: string }> = [];
    let n = 0;
    const html = `<p>Hi</p><img src="${PNG}" alt="logo"><img src='${PNG}'><img src="https://x.test/a.png">`;
    const out = await embedTemplateImages(html, async (image) => {
      uploads.push({ type: image.type, size: image.bytes.byteLength, name: image.name });
      n += 1;
      return { cid: `c${n}@x` };
    });
    expect(uploads).toEqual([{ type: 'image/png', size: 8, name: 'image-1.png' }]);
    expect(out).toBe(`<p>Hi</p><img data-cid="c1@x" src="${PNG}" alt="logo"><img data-cid="c1@x" src='${PNG}'><img src="https://x.test/a.png">`);
  });

  it('leaves an image whose upload fails, and HTML without data: images, as it is', async () => {
    const html = `<img src="${PNG}">`;
    expect(await embedTemplateImages(html, async () => null)).toBe(html);
    expect(await embedTemplateImages(html, async () => { throw new Error('offline'); })).toBe(html);
    const none = '<p><img src="cid:a@b"></p>';
    expect(await embedTemplateImages(none, async () => ({ cid: 'x' }))).toBe(none);
  });

  it('skips an image the editor already tracks and a non-image data: URI', async () => {
    const html = `<img data-cid="old@x" src="${PNG}"><img src="data:text/html;base64,PGI+">`;
    let called = false;
    expect(await embedTemplateImages(html, async () => { called = true; return { cid: 'new@x' }; })).toBe(html);
    expect(called).toBe(false);
  });
});
