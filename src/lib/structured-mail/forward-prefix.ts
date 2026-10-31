// Mirrors hasForwardPrefix and the prefix tokens of webmail lib/subject-prefix.ts
// at 8098039d6; keep the two in step. The app's own src/lib/subject-prefix.ts
// has the same token lists but no forward check.

const REPLY_TOKENS = [
  "Re",      // English, Italian, French (also generic ISO)
  "RE",      // Outlook variant
  "AW",      // German (Antwort)
  "Antw",    // German verbose
  "Sv",      // Danish / Swedish / Norwegian (Svar)
  "Yn",      // Turkish (Yanit)
  "Yanit",   // Turkish verbose
  "Odp",     // Polish (Odpowiedz)
  "Ответ",   // Russian
  "Resp",    // Spanish/Portuguese variant
  "Vá",      // Hungarian
  "回复",    // Chinese
  "回覆",    // Chinese traditional
  "답장",    // Korean
  // NB: deliberately no bare "R" token — a single letter would strip the first
  // word of legitimate subjects like "R: budget 2024". The full "Re" covers
  // the common Italian/English case anyway.
];

const FORWARD_TOKENS = [
  "Fwd",     // English standard
  "Fw",      // English short / Polish / German short
  "WG",      // German (Weitergeleitet)
  "Tr",      // French (Transfert)
  "Vs",      // Danish (Videresend)
  "Enc",     // Portuguese (Encaminhar)
  "ENC",     // Portuguese caps
  "Rv",      // Spanish (Reenviar)
  "RV",      // Spanish caps
  "Rvf",     // Spanish variant
  "Inol",    // Italian (Inoltro)
  // NB: deliberately no bare "I" token — see the REPLY_TOKENS note above.
  "PD",      // Polish (Przekazane Dalej)
  "PR",      // Czech (Preposlat)
  "İlt",     // Turkish (Ilet)
  "Ilt",     // Turkish ASCII
  "Пересл",  // Russian (Peresylka)
  "Пер",     // Russian short
  "转发",    // Chinese
  "轉寄",    // Chinese traditional
  "전달",    // Korean
];

// Match a single prefix token + optional [N] counter (Outlook) or *N (Eudora)
// + colon + whitespace. Case-insensitive. The non-capturing groups keep the
// regex composable for stripping multiple prefixes in a row.
function buildPrefixRegex(tokens: string[]): RegExp {
  // Escape regex specials in tokens (none currently, but be defensive)
  const escaped = tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  // Sort by length DESC so longer tokens (e.g. "Пересл") win over their
  // shorter prefixes (e.g. "Пер") during alternation matching.
  escaped.sort((a, b) => b.length - a.length);
  // Accept both the ASCII colon and the full-width colon "：" (U+FF1A) that CJK
  // mail clients emit after a localized prefix (e.g. "回复：foo").
  return new RegExp(
    `^\\s*(?:${escaped.join("|")})(?:\\[\\d+\\]|\\*\\d*)?\\s*[:\\uFF1A]\\s*`,
    "i",
  );
}

const FORWARD_RE = buildPrefixRegex(FORWARD_TOKENS);
const REPLY_RE = buildPrefixRegex(REPLY_TOKENS);

/**
 * Whether the subject's leading prefix chain marks a forward anywhere in it
 * ("Fwd:", "Re: Fwd:", "AW: WG:"), case-insensitively. Booking cards use it:
 * a forwarded booking mail was authenticated for the forwarder, not for the
 * airline or shop it quotes.
 */
export function hasForwardPrefix(subject: string | undefined | null): boolean {
  let rest = (subject ?? "").trimStart();
  for (let i = 0; i < 20; i++) {
    const forward = FORWARD_RE.exec(rest);
    if (forward && forward[0].length > 0) return true;
    const reply = REPLY_RE.exec(rest);
    if (!reply || reply[0].length === 0) return false;
    rest = rest.slice(reply[0].length).trimStart();
  }
  return false;
}
