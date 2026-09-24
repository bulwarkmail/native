import type {
  FilterRule,
  FilterCondition,
  FilterAction,
  FilterMetadata,
  VacationSieveConfig,
} from './types';

// Ported from the webmail's lib/sieve/generator.ts. Emits an RFC 5228 Sieve
// script with a leading `@metadata` JSON comment that lets the parser round-trip
// the visual rules losslessly. Keep this in sync with the web generator so a
// script saved on one client reads back cleanly on the other.

const HEADER_MAP: Record<string, string> = {
  from: 'From',
  to: 'To',
  cc: 'Cc',
  subject: 'Subject',
};

function escapeString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// Normalise the condition value to a non-empty string array. Single-value
// conditions stay one-element; arrays are filtered for empty strings.
function toValueList(value: string | string[]): string[] {
  const arr = Array.isArray(value) ? value : [value];
  return arr.map((v) => (v ?? '').toString()).filter((v) => v.length > 0);
}

// Render one or many strings as a Sieve string-literal-or-list. Sieve treats
// `header :contains "From" ["a", "b"]` as "any of a, b" (built-in OR within
// the condition); the single-string form is emitted unchanged when len === 1
// so existing scripts and tests stay byte-identical.
function formatStringArg(values: string[], transform: (s: string) => string = (s) => s): string {
  if (values.length === 1) {
    return `"${escapeString(transform(values[0]))}"`;
  }
  return `[${values.map((v) => `"${escapeString(transform(v))}"`).join(', ')}]`;
}

function generateCondition(condition: FilterCondition): string {
  const { field, comparator, value } = condition;

  if (field === 'size') {
    // Size is numeric, single value only.
    const sizeValue = Array.isArray(value) ? value[0] : value;
    const op = comparator === 'greater_than' ? ':over' : ':under';
    return `size ${op} ${sizeValue}`;
  }

  const values = toValueList(value);

  if (field === 'body') {
    const matchType = comparator === 'is' ? ':is' : ':contains';
    return `body ${matchType} ${formatStringArg(values)}`;
  }

  if (field === 'attachment') {
    // RFC 5703: :mime :anychild matches against headers of any MIME part.
    // has_any tests Content-Disposition for "attachment"; has_type matches
    // the file extension against the filename across BOTH Content-Disposition
    // (filename= parameter) and Content-Type (name= parameter) - many older
    // senders (Microsoft SMTPSVC, PrintToMail, etc.) put the filename only
    // in Content-Type and leave Content-Disposition without a filename.
    // RFC 5228 §5.7 allows a string-list for header names; the test passes
    // if any listed header matches. Wildcard "*.<ext>*" catches quoted,
    // unquoted, and RFC-2231-encoded forms alike since ".<ext>" appears as
    // a literal substring in all of them.
    // Multiple extensions become a Sieve value-list ["*.pdf*", "*.xml*"]
    // = OR within the condition (any item matches → test passes).
    if (comparator === 'has_any') {
      return `header :mime :anychild :contains "Content-Disposition" "attachment"`;
    }
    const normalised = values.map((v) => v.replace(/^[.*]+/, '').trim()).filter(Boolean);
    return `header :mime :anychild :matches ["Content-Disposition", "Content-Type"] ${formatStringArg(normalised, (ext) => `*.${ext}*`)}`;
  }

  const headerName = field === 'header'
    ? (condition.headerName || 'X-Unknown')
    : HEADER_MAP[field];

  // A field this client does not know (a rule authored by a newer webmail)
  // must never be flattened into `header :contains "undefined"`: that would
  // silently rewrite the user's rule server-side on the next save. Fail the
  // save instead so the script stays untouched.
  if (!headerName) {
    throw new Error(`Unsupported filter condition field: ${String(field)}`);
  }

  switch (comparator) {
    case 'contains':
      return `header :contains "${headerName}" ${formatStringArg(values)}`;
    case 'not_contains':
      return `not header :contains "${headerName}" ${formatStringArg(values)}`;
    case 'is':
      return `header :is "${headerName}" ${formatStringArg(values)}`;
    case 'not_is':
      return `not header :is "${headerName}" ${formatStringArg(values)}`;
    case 'starts_with':
      return `header :matches "${headerName}" ${formatStringArg(values, (v) => `${v}*`)}`;
    case 'ends_with':
      return `header :matches "${headerName}" ${formatStringArg(values, (v) => `*${v}`)}`;
    case 'matches':
      return `header :matches "${headerName}" ${formatStringArg(values)}`;
    default:
      return `header :contains "${headerName}" ${formatStringArg(values)}`;
  }
}

function generateActions(actions: FilterAction[]): string[] {
  return actions.map(action => {
    switch (action.type) {
      case 'move':
        return `fileinto "${escapeString(action.value || '')}";`;
      case 'copy':
        return `fileinto :copy "${escapeString(action.value || '')}";`;
      case 'forward':
        return `redirect "${escapeString(action.value || '')}";`;
      case 'mark_read':
        return 'addflag "\\\\Seen";';
      case 'star':
        return 'addflag "\\\\Flagged";';
      case 'add_label':
        return `addflag "$label:${escapeString(action.value || '')}";`;
      case 'discard':
        return 'discard;';
      case 'reject':
        return `reject "${escapeString(action.value || '')}";`;
      case 'keep':
        // A bare `keep;` delivers to the "default place", which on Stalwart is
        // Junk for a message its spam filter has already classified, so an
        // allow-list rule made with "Keep" would change nothing. An explicit
        // `fileinto "INBOX"` is honored over the spam verdict (#1027).
        return 'fileinto "INBOX";';
      case 'stop':
        return 'stop;';
    }
  });
}

function computeRequires(rules: FilterRule[], vacation?: VacationSieveConfig): string[] {
  const extensions = new Set<string>();
  const enabledRules = rules.filter(r => r.enabled);

  if (vacation?.isEnabled) {
    extensions.add('vacation');
  }

  for (const rule of enabledRules) {
    for (const condition of rule.conditions) {
      if (condition.field === 'body') extensions.add('body');
      if (condition.field === 'attachment') extensions.add('mime');
    }
    for (const action of rule.actions) {
      switch (action.type) {
        case 'move':
        case 'keep':
          extensions.add('fileinto');
          break;
        case 'copy':
          extensions.add('fileinto');
          extensions.add('copy');
          break;
        case 'mark_read':
        case 'star':
        case 'add_label':
          extensions.add('imap4flags');
          break;
        case 'reject':
          extensions.add('reject');
          break;
      }
    }
  }

  return [...extensions];
}

function stripRuleForMetadata(r: FilterRule): Omit<FilterRule, 'origin' | 'originLabel' | 'rawBlock'> {
  return {
    id: r.id,
    name: r.name,
    enabled: r.enabled,
    matchType: r.matchType,
    conditions: r.conditions,
    actions: r.actions,
    stopProcessing: r.stopProcessing,
  };
}

export interface GenerateOptions {
  /**
   * Require extensions used by external (non-Bulwark) rules that we must
   * preserve in the top-level `require` directive. Duplicates with Bulwark's
   * own requires are deduplicated.
   */
  externalRequires?: string[];
}

export function generateScript(
  rules: FilterRule[],
  vacation?: VacationSieveConfig,
  options: GenerateOptions = {},
): string {
  // Partition rules by origin. Treat missing origin as 'bulwark' for back-compat.
  const bulwarkRules: FilterRule[] = [];
  const externalRules: FilterRule[] = [];
  for (const r of rules) {
    if (r.origin && r.origin !== 'bulwark') externalRules.push(r);
    else bulwarkRules.push(r);
  }

  const metadata: FilterMetadata = {
    version: 1,
    rules: bulwarkRules.map(stripRuleForMetadata) as FilterRule[],
  };
  if (vacation?.isEnabled) {
    metadata.vacation = vacation;
  }
  const metadataJson = JSON.stringify(metadata);
  const lines: string[] = [];

  lines.push('/* @metadata:begin');
  lines.push(metadataJson);
  lines.push('@metadata:end */');
  lines.push('');

  const bulwarkRequires = computeRequires(bulwarkRules, vacation);
  const externalRequires = options.externalRequires ?? [];
  const allRequires = [...new Set([...bulwarkRequires, ...externalRequires])].sort();

  if (allRequires.length > 0) {
    lines.push(`require [${allRequires.map(r => `"${r}"`).join(', ')}];`);
  }

  if (vacation?.isEnabled) {
    lines.push('');
    lines.push('# Vacation auto-reply');
    const vacationParts: string[] = [];
    if (vacation.subject) {
      vacationParts.push(`:subject "${escapeString(vacation.subject)}"`);
    }
    vacationParts.push(`"${escapeString(vacation.textBody || '')}"`);
    lines.push(`vacation ${vacationParts.join(' ')};`);
  }

  const enabledBulwarkRules = bulwarkRules.filter(r => r.enabled);

  for (const rule of enabledBulwarkRules) {
    if (rule.conditions.length === 0 || rule.actions.length === 0) {
      console.warn(`[filters] Skipping rule "${rule.name}": empty conditions or actions`);
      continue;
    }

    lines.push('');
    lines.push(`# Rule: ${rule.name}`);

    const conditions = rule.conditions.map(generateCondition);
    let conditionStr: string;

    if (conditions.length === 0) {
      conditionStr = 'true';
    } else if (conditions.length === 1) {
      conditionStr = conditions[0];
    } else {
      const wrapper = rule.matchType === 'all' ? 'allof' : 'anyof';
      conditionStr = `${wrapper}(${conditions.join(', ')})`;
    }

    const actionLines = generateActions(rule.actions);

    if (rule.stopProcessing) {
      const lastAction = rule.actions[rule.actions.length - 1];
      if (!lastAction || !['stop', 'discard', 'reject'].includes(lastAction.type)) {
        actionLines.push('stop;');
      }
    }

    lines.push(`if ${conditionStr} {`);
    for (const actionLine of actionLines) {
      lines.push(`    ${actionLine}`);
    }
    lines.push('}');
  }

  // Append preserved external rules verbatim. Each rawBlock already carries its
  // own leading comments and trailing whitespace from the source script.
  if (externalRules.length > 0) {
    lines.push('');
    lines.push('# --- External rules (managed outside Bulwark) ---');
    for (const ext of externalRules) {
      if (!ext.rawBlock) continue;
      lines.push(ext.rawBlock.replace(/\s+$/, ''));
    }
  }

  lines.push('');
  return lines.join('\n');
}
