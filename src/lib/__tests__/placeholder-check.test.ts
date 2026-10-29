import { describe, it, expect } from 'vitest';
import { SUPPORTED_LOCALES } from '../../i18n';
import {
  findUnfilledPlaceholders, placeholderWordsFor, unfilledPlaceholdersInMessage, type PlaceholderWords,
} from '../placeholder-check';
import { SIGNATURE_RANGE_MARKER } from '../signature-utils';

// Ported from the webmail's lib/__tests__/placeholder-check.test.ts. The words
// come from the RN overlays (locales/rn/<lang>.json) until the vendored
// catalogs carry them.
const locales = SUPPORTED_LOCALES.map((l) => l.code as string);

function wordsOf(locale: string): PlaceholderWords {
  return placeholderWordsFor(locale).at(-1)!;
}

// What the composer passes: English and the UI language.
const withUi = (locale: string) => placeholderWordsFor(locale);
const EN = withUi('en');
const ALL = locales.map(wordsOf);

describe('findUnfilledPlaceholders', () => {
  it('finds template placeholders in the subject and the body', () => {
    expect(findUnfilledPlaceholders('Follow-up: {{subject}}', 'Hi {{ recipient_name }},')).toEqual([
      '{{subject}}',
      '{{ recipient_name }}',
    ]);
  });

  it('finds upper-case fill-ins in brackets', () => {
    expect(findUnfilledPlaceholders('', 'See you at [TIME]. It costs [PRICE] per [UNIT_NAME].'))
      .toEqual(['[TIME]', '[PRICE]', '[UNIT_NAME]']);
    expect(findUnfilledPlaceholders('', 'Best regards, [YOUR NAME]')).toEqual(['[YOUR NAME]']);
    expect(findUnfilledPlaceholders('', 'Treffpunkt: [ÜBERGABEORT]')).toEqual(['[ÜBERGABEORT]']);
  });

  it('finds fill-ins that ask the sender to write something', () => {
    expect(findUnfilledPlaceholders('', 'Best regards,\n[Your Name]\n[Insert date]', EN)).toEqual([
      '[Your Name]',
      '[Insert date]',
    ]);
    expect(findUnfilledPlaceholders('', 'Viele Grüße\n[Ihr Name], [Datum einfügen]', withUi('de'))).toEqual([
      '[Ihr Name]',
      '[Datum einfügen]',
    ]);
  });

  it.each([
    ['ar', '[أدخل الاسم]'],
    ['ca', '[El teu nom]'],
    ['cs', '[Vaše jméno]'],
    ['da', '[Dit navn]'],
    ['de', '[Unterschrift eintragen]'],
    ['es', '[Tu nombre]'],
    ['es', '[Inserte la fecha]'],
    ['fa', '[نام شما]'],
    ['fr', '[Votre nom]'],
    ['fr', '[Insérer la date]'],
    ['he', '[השם שלך]'],
    ['hu', '[Az Ön neve]'],
    ['it', '[Il tuo nome]'],
    ['it', '[Inserisci la data]'],
    ['ja', '[あなたの名前]'],
    ['ja', '［会社名を入力］'],
    ['ko', '[귀하의 이름]'],
    ['ko', '[날짜 입력]'],
    ['lv', '[Jūsu vārds]'],
    ['mn', '[Таны нэр]'],
    ['nb', '[Ditt navn]'],
    ['nl', '[Uw naam]'],
    ['nl', '[Datum invullen]'],
    ['pl', '[Twoje imię]'],
    ['pt', '[Seu nome]'],
    ['ro', '[Numele tău]'],
    ['ru', '[Ваше имя]'],
    ['ru', '[Укажите дату]'],
    ['sk', '[Vaše meno]'],
    ['tr', '[Adınız]'],
    ['tr', '[Tarih ekleyin]'],
    ['uk', '[Ваше ім’я]'],
    ['zh', '[您的姓名]'],
    ['zh', '【插入日期】'],
    ['zh-TW', '[填寫公司名稱]'],
  ])('finds a %s fill-in with that UI language: %s', (locale, fillIn) => {
    expect(findUnfilledPlaceholders('', `Text ${fillIn} text`, withUi(locale))).toEqual([fillIn]);
  });

  it('checks only the languages it is given', () => {
    expect(findUnfilledPlaceholders('', 'Cordialement, [Votre nom]', withUi('de'))).toEqual([]);
    expect(findUnfilledPlaceholders('', 'Cordialement, [Votre nom]', withUi('fr'))).toEqual(['[Votre nom]']);
  });

  it('finds English fill-ins whatever the UI language', () => {
    expect(findUnfilledPlaceholders('', 'Thanks, [Your Name]. TODO', withUi('ja'))).toEqual(['[Your Name]', 'TODO']);
  });

  it('skips word lists that are not lists of strings', () => {
    const broken = [{ before: 'your' }, { before: [1, '', '-', null] }, null, { after: {} }] as unknown as PlaceholderWords[];
    expect(findUnfilledPlaceholders('', '[Your Name] [TIME]', broken)).toEqual(['[TIME]']);
  });

  it('finds the circles that stand in for a name in Japanese and Korean', () => {
    expect(findUnfilledPlaceholders('', '〇〇様\nお世話になっております。○○○ 님')).toEqual(['〇〇', '○○○']);
  });

  it('leaves bracketed words and headings in other languages alone', () => {
    const text = [
      '【重要】お知らせ 【通知】',
      '[Votre] [Ваше] [您的]',
      'Le [ton] juste. Vote [tu].',
      'Siehe [Anlage 2] und [Kapitel 3].',
      'Termin: ○ und ◯.',
    ].join('\n');
    expect(findUnfilledPlaceholders('', text, ALL)).toEqual([]);
  });

  it('finds unfinished-text markers', () => {
    expect(findUnfilledPlaceholders('', 'The venue is TBD. TODO: add the agenda. Room XXX', EN)).toEqual([
      'TBD',
      'TODO',
      'XXX',
    ]);
  });

  it('reports a marker in brackets once', () => {
    expect(findUnfilledPlaceholders('', 'Agenda: [TODO]', EN)).toEqual(['[TODO]']);
  });

  it('lists each placeholder once', () => {
    expect(findUnfilledPlaceholders('{{name}}', 'Hi {{name}}, at [TIME] or [TIME]?')).toEqual([
      '{{name}}',
      '[TIME]',
    ]);
  });

  it('leaves ordinary text alone', () => {
    const text = [
      'See footnote [1] and tick [x].',
      'Option [A] is fine, so is [3D] and [2026].',
      'I still have a todo list and the date is tba.',
      'Read [the docs](https://example.com) and [Your account](https://example.com/me).',
      'The mastodon handle is TODOS and the size is XXXL.',
      'Signed, [Yours truly].',
      'A {single} brace and {{}} are not placeholders.',
    ].join('\n');
    expect(findUnfilledPlaceholders('', text, ALL)).toEqual([]);
  });

  it('ignores bracket tags and markers in the subject', () => {
    expect(findUnfilledPlaceholders('Re: [EXTERNAL] Venue TBD', 'Thanks!', ALL)).toEqual([]);
  });
});

describe('placeholder words in the locale files', () => {
  it.each(locales)('%s has lists of strings', (locale) => {
    const words = wordsOf(locale) as Record<string, unknown>;
    for (const key of ['before', 'after', 'unfinished']) {
      expect(Array.isArray(words[key]), `${locale}: ${key} is not a list`).toBe(true);
      for (const word of words[key] as unknown[]) {
        expect(typeof word === 'string' && word.replace(/-/g, '').trim() !== '', `${locale}: ${JSON.stringify(word)}`).toBe(true);
      }
    }
  });
});

describe('unfilledPlaceholdersInMessage', () => {
  const signature = { name: 'Me', email: 'me@example.com', textSignature: 'Me\n[YOUR TITLE]', htmlSignature: '' };

  it('leaves the embedded signature and the quoted original out', () => {
    const body = '<p>See you at [TIME].</p>'
      + `<p ${SIGNATURE_RANGE_MARKER}="separator">-- </p><p>Me, [YOUR TITLE]</p><p ${SIGNATURE_RANGE_MARKER}="end"></p>`
      + '<blockquote><p>Please confirm [DATE]</p></blockquote>';
    expect(unfilledPlaceholdersInMessage({
      subject: 'Re: hello', body, plainTextMode: false, signature, words: EN,
    })).toEqual(['[TIME]']);
  });

  it('leaves the plain text signature and quoted lines out', () => {
    const body = 'See you at [TIME].\n\n-- \nMe\n[YOUR TITLE]\n\n> Please confirm [DATE]';
    expect(unfilledPlaceholdersInMessage({
      subject: '{{subject}}', body, plainTextMode: true, signature, words: EN,
    })).toEqual(['{{subject}}', '[TIME]']);
  });

  // The plain text of a link is "text <href>": a URL's {{id}} or [TODO]
  // stopped the send though the sender never sees it.
  it('leaves link targets out and keeps the link text', () => {
    const body = '<p>See <a href="https://example.com/wiki/[TODO]?u={{id}}">the [DRAFT] page</a>'
      + " and <a class=x href='https://example.com/TODO'>this</a>.</p>";
    expect(unfilledPlaceholdersInMessage({
      subject: 'Hello', body, plainTextMode: false, signature, words: EN,
    })).toEqual(['[DRAFT]']);
  });
});
