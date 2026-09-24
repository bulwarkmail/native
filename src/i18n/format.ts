// Minimal ICU MessageFormat subset, enough for the webmail catalogs:
//
//   "Hello {name}"                                        → argument
//   "{count, plural, one {# email} other {# emails}}"     → plural
//   "{count, plural, =0 {none} one {one} other {# more}}" → exact matches
//
// next-intl (the webmail) uses the full ICU grammar, but a scan of every
// catalog shows only these two forms in use (no select/number/date), so a
// hand-rolled parser keeps a heavy dependency out of the Hermes bundle.
// Unknown placeholders are left untouched so callers that still do
// `.replace('{x}', …)` on the result keep working.

export type MessageParams = Record<string, string | number | null | undefined>;

type PluralCategory = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other';

const pluralRulesCache = new Map<string, Intl.PluralRules | null>();

function pluralRulesFor(locale: string): Intl.PluralRules | null {
  if (pluralRulesCache.has(locale)) return pluralRulesCache.get(locale) ?? null;
  let rules: Intl.PluralRules | null = null;
  try {
    if (typeof Intl !== 'undefined' && typeof Intl.PluralRules === 'function') {
      rules = new Intl.PluralRules(locale);
    }
  } catch {
    rules = null;
  }
  pluralRulesCache.set(locale, rules);
  return rules;
}

// ─── Built-in CLDR cardinal rules ─────────────────────────────────────────
// Hermes ships no Intl.PluralRules, so without these every locale would get
// the English one/other split ("2 писем" instead of "2 письма"). These are the
// CLDR 48 cardinal rules (unicode.org/cldr/charts/latest/supplemental/
// language_plural_rules.html) for the app's locales, written out from the
// rule text. Operands as in UTS #35: n absolute value, i integer digits,
// v number of visible fraction digits, f visible fraction digits (with
// Intl's default formatting there are no trailing zeros, so t = f).

interface PluralOperands {
  n: number;
  i: number;
  v: number;
  f: number;
}

function pluralOperands(value: number): PluralOperands {
  // Intl.PluralRules formats with at most three fraction digits by default.
  const n = Number(Math.abs(value).toFixed(3));
  if (Number.isInteger(n)) return { n, i: n, v: 0, f: 0 };
  const [int, frac] = String(n).split('.');
  return { n, i: Number(int), v: frac.length, f: Number(frac) };
}

// CLDR ranges (`a..b`) only match integers: 3.5 is not in 3..10.
function inRange(x: number, lo: number, hi: number): boolean {
  return Number.isInteger(x) && x >= lo && x <= hi;
}

type PluralRule = (o: PluralOperands) => PluralCategory;

// "many" for whole millions (fr "1 million de …"): e = 0 and i != 0 and
// i % 1000000 = 0 and v = 0. Plain numbers never use compact exponents.
const isMillions = ({ i, v }: PluralOperands) => v === 0 && i !== 0 && i % 1000000 === 0;

const oneForIntegerOne: PluralRule = ({ i, v }) => (i === 1 && v === 0 ? 'one' : 'other');
const oneForOne: PluralRule = ({ n }) => (n === 1 ? 'one' : 'other');
const otherOnly: PluralRule = () => 'other';

// ru, uk
const eastSlavic: PluralRule = ({ i, v }) => {
  if (v !== 0) return 'other';
  if (i % 10 === 1 && i % 100 !== 11) return 'one';
  if (inRange(i % 10, 2, 4) && !inRange(i % 100, 12, 14)) return 'few';
  return 'many';
};

// cs, sk
const czechSlovak: PluralRule = ({ i, v }) => {
  if (v !== 0) return 'many';
  if (i === 1) return 'one';
  if (inRange(i, 2, 4)) return 'few';
  return 'other';
};

const PLURAL_RULES: Record<string, PluralRule> = {
  ar: ({ n }) => {
    if (n === 0) return 'zero';
    if (n === 1) return 'one';
    if (n === 2) return 'two';
    if (inRange(n % 100, 3, 10)) return 'few';
    if (inRange(n % 100, 11, 99)) return 'many';
    return 'other';
  },
  ca: (o) => (o.i === 1 && o.v === 0 ? 'one' : isMillions(o) ? 'many' : 'other'),
  cs: czechSlovak,
  sk: czechSlovak,
  da: ({ n, i, f }) => (n === 1 || (f !== 0 && (i === 0 || i === 1)) ? 'one' : 'other'),
  de: oneForIntegerOne,
  en: oneForIntegerOne,
  fa: ({ n, i }) => (i === 0 || n === 1 ? 'one' : 'other'),
  es: (o) => (o.n === 1 ? 'one' : isMillions(o) ? 'many' : 'other'),
  fr: (o) => (o.i === 0 || o.i === 1 ? 'one' : isMillions(o) ? 'many' : 'other'),
  he: ({ i, v }) => {
    if ((i === 1 && v === 0) || (i === 0 && v !== 0)) return 'one';
    if (i === 2 && v === 0) return 'two';
    return 'other';
  },
  it: (o) => (o.i === 1 && o.v === 0 ? 'one' : isMillions(o) ? 'many' : 'other'),
  hu: oneForOne,
  lv: ({ n, v, f }) => {
    if (n % 10 === 0 || inRange(n % 100, 11, 19) || (v === 2 && inRange(f % 100, 11, 19))) return 'zero';
    if (
      (n % 10 === 1 && n % 100 !== 11)
      || (v === 2 && f % 10 === 1 && f % 100 !== 11)
      || (v !== 2 && f % 10 === 1)
    ) return 'one';
    return 'other';
  },
  nl: oneForIntegerOne,
  nb: oneForOne,
  pl: ({ i, v }) => {
    if (v !== 0) return 'other';
    if (i === 1) return 'one';
    if (inRange(i % 10, 2, 4) && !inRange(i % 100, 12, 14)) return 'few';
    return 'many';
  },
  pt: (o) => (o.i === 0 || o.i === 1 ? 'one' : isMillions(o) ? 'many' : 'other'),
  ro: ({ n, i, v }) => {
    if (i === 1 && v === 0) return 'one';
    if (v !== 0 || n === 0 || (n !== 1 && inRange(n % 100, 1, 19))) return 'few';
    return 'other';
  },
  tr: oneForOne,
  ru: eastSlavic,
  uk: eastSlavic,
  ko: otherOnly,
  ja: otherOnly,
  mn: oneForOne,
  zh: otherOnly,
};

/**
 * Plural category from the built-in CLDR rules above, by language subtag
 * (`zh-TW` → `zh`). Languages without a rule get the English one.
 */
export function builtinPluralCategory(n: number, locale: string): PluralCategory {
  const language = locale.toLowerCase().split(/[-_]/)[0];
  const rule = PLURAL_RULES[language] ?? oneForIntegerOne;
  return rule(pluralOperands(n));
}

/**
 * CLDR plural category for `n` in `locale`. Uses Intl.PluralRules where the
 * engine has it and the built-in rules where it doesn't (Hermes) or rejects
 * the locale.
 */
export function pluralCategory(n: number, locale: string): PluralCategory {
  const rules = pluralRulesFor(locale);
  if (rules) {
    try {
      return rules.select(n) as PluralCategory;
    } catch {
      // fall through
    }
  }
  return builtinPluralCategory(n, locale);
}

// Find the index of the `}` that closes the `{` at `open`, honouring nesting.
function findClosingBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Parse the `one {…} other {…}` branch list of a plural argument.
function parsePluralBranches(body: string): Map<string, string> {
  const branches = new Map<string, string>();
  let i = 0;
  while (i < body.length) {
    while (i < body.length && /\s/.test(body[i])) i++;
    if (i >= body.length) break;
    let selector = '';
    while (i < body.length && body[i] !== '{' && !/\s/.test(body[i])) {
      selector += body[i];
      i++;
    }
    while (i < body.length && /\s/.test(body[i])) i++;
    if (body[i] !== '{') break;
    const close = findClosingBrace(body, i);
    if (close === -1) break;
    branches.set(selector, body.slice(i + 1, close));
    i = close + 1;
  }
  return branches;
}

function formatNumber(n: number, locale: string): string {
  try {
    if (typeof Intl !== 'undefined' && typeof Intl.NumberFormat === 'function') {
      return new Intl.NumberFormat(locale).format(n);
    }
  } catch {
    // fall through
  }
  return String(n);
}

function selectPluralBranch(
  branches: Map<string, string>,
  n: number,
  locale: string,
): string | undefined {
  const exact = branches.get(`=${n}`);
  if (exact !== undefined) return exact;
  const category = pluralCategory(n, locale);
  return branches.get(category) ?? branches.get('other');
}

/**
 * Substitute `{name}` and `{count, plural, …}` arguments in `message`.
 * Placeholders whose argument is not in `params` are returned verbatim.
 */
export function formatMessage(
  message: string,
  params: MessageParams | undefined,
  locale: string,
): string {
  if (!params || message.indexOf('{') === -1) return message;

  let out = '';
  let i = 0;
  while (i < message.length) {
    const open = message.indexOf('{', i);
    if (open === -1) {
      out += message.slice(i);
      break;
    }
    const close = findClosingBrace(message, open);
    if (close === -1) {
      out += message.slice(i);
      break;
    }
    out += message.slice(i, open);
    const inner = message.slice(open + 1, close);
    const raw = message.slice(open, close + 1);
    const comma = inner.indexOf(',');

    if (comma === -1) {
      const name = inner.trim();
      const value = params[name];
      out += value === undefined || value === null ? raw : String(value);
    } else {
      const name = inner.slice(0, comma).trim();
      const rest = inner.slice(comma + 1);
      const comma2 = rest.indexOf(',');
      const type = (comma2 === -1 ? rest : rest.slice(0, comma2)).trim();
      const value = params[name];
      if (type === 'plural' && comma2 !== -1 && value !== undefined && value !== null) {
        const n = typeof value === 'number' ? value : Number(value);
        const branches = parsePluralBranches(rest.slice(comma2 + 1));
        const branch = selectPluralBranch(branches, n, locale);
        if (branch === undefined) {
          out += raw;
        } else {
          // `#` inside a branch is the formatted number; branches may nest
          // further arguments, so format them recursively.
          out += formatMessage(branch.replace(/#/g, formatNumber(n, locale)), params, locale);
        }
      } else if (value !== undefined && value !== null) {
        // `{name, number}` / unknown types: plain substitution.
        out += String(value);
      } else {
        out += raw;
      }
    }
    i = close + 1;
  }
  return out;
}
