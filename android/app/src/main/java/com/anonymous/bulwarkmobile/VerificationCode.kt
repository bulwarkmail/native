package com.anonymous.bulwarkmobile

import kotlin.math.max
import kotlin.math.min

/**
 * The one-time code in a sign-in mail, for the Copy code action of a new-mail
 * notification posted here (BulwarkNativePushFetcher). A port of
 * findVerificationCode and listVerificationCode in src/lib/verification-code.ts,
 * which the JS push task and the mail list use; the unit test runs the same
 * fixture mails through both.
 *
 * JavaScript and Java regexes differ in two places that matter here: `\s` is
 * ASCII-only in Java (WS lists what JavaScript counts), and Java's `$` also
 * matches before a final line break, so the patterns end in `\z`.
 */
object VerificationCode {
    private const val MAX_AFTER = 120
    private const val MAX_BEFORE = 60
    private const val MAX_SUBJECT = 1_000
    private const val MAX_BODY_TEXT = 50_000
    private const val GLUED_CONTEXT = 40
    const val MAX_AGE_MS = 24L * 60 * 60 * 1000

    // What JavaScript's \s matches, for use inside a character class.
    private const val WS = "\\s\\x{a0}\\x{1680}\\x{2000}-\\x{200a}\\x{2028}\\x{2029}\\x{202f}\\x{205f}\\x{3000}\\x{feff}"
    private val SPACE = Regex("[$WS]")

    private val NOT_A_CODE_PREFIXES = setOf(
        "en", "de", "uni", "x", "vs", "op", "byte", "bar", "post", "zip", "qr", "geo", "short", "pseudo",
        "hash", "leet", "trans", "re", "source", "quell", "programm", "program", "status", "error",
        "fehler", "dress", "color", "colour", "farb", "html", "css", "embed", "tracking", "sendungs",
        "referral", "empfehlungs", "sort", "swift", "tax", "ean", "produkt", "product", "artikel",
        "promo", "coupon", "discount", "voucher", "gift", "gutschein", "rabatt", "aktions", "geschenk",
        "bonus", "vorteils", "area", "country", "länder", "laender", "landes", "claude", "studio",
    )

    private val CODE_WORD_ENDINGS = listOf(
        "code", "codes", "codice", "codici", "código", "códigos", "codigo", "codigos", "cod", "kod",
        "kodu", "kodem", "kodunuz", "kód", "kódot", "kódu", "kode", "koden", "koodi", "koodia", "kood",
        "kods", "kodas", "код", "кода", "коду", "кодом", "κωδικός", "κωδικό", "קוד", "رمز", "کد",
    )

    private val CODE_WORDS_EXACT = setOf("passcode", "einmalkennwort", "einmalpasswort")

    private val UPPERCASE_CODE_WORDS = Regex("^(?:PIN|OTP|(?:m|sms|push|chip|photo|i|e)?TAN)$")
    private val CJK_CODE_WORDS = Regex("コード|認証番号|確認番号|验证码|驗證碼|校验码|动态码|인증[$WS]?번호|인증[$WS]?코드|코드")
    private val ONE_TIME_PASSWORD = Regex("\\b(?:one[- ]time|single[- ]use|temporary) pass(?:word|code)\\b", RegexOption.IGNORE_CASE)
    private val WORD = Regex("[\\p{L}\\p{M}]+(?:-[\\p{L}\\p{M}]+)*")
    private val LABELS_SHORT_NUMBER = Regex("^[$WS]*[:=]?[$WS]*\\d{1,3}(?![\\p{L}\\p{N}]|[.,]\\d|[ -]\\d)")
    private val OF_NEXT = Regex("^[$WS]+of[$WS]", RegexOption.IGNORE_CASE)

    private val CANDIDATE = Regex(
        listOf(
            "(?<![\\p{L}\\p{N}])[A-Za-z0-9]{2,8}(?:-[A-Za-z0-9]{2,8}){1,3}(?![\\p{L}\\p{N}])",
            "(?<!\\d)\\d{3,4}[ -]\\d{3,4}(?!\\d)",
            "(?<![\\p{L}\\p{N}])\\d(?: \\d){3,9}(?![\\p{L}\\p{N}])",
            "(?<![\\p{L}\\p{N}])[A-Za-z0-9]{4,10}(?![\\p{L}\\p{N}])",
        ).joinToString("|"),
    )
    private val GLUED_DIGITS = Regex("(?<=\\p{L})\\d{4,10}(?!\\d)|(?<!\\d)\\d{4,10}(?=\\p{L})")
    private val ALNUM = Regex("[\\p{L}\\p{N}]")
    private val LETTER = Regex("\\p{L}")
    private val GLUED_TOKEN = Regex("^\\p{L}*\\d+\\p{L}*\\z")

    private val YEAR = Regex("^(?:19|20)\\d\\d\\z")
    private val NUMBER_WITH_UNIT = Regex("^\\d+[a-z]{1,3}\\z", RegexOption.IGNORE_CASE)
    private val PROMO_CODE = Regex("^[A-Z]{4,}\\d{1,4}\\z")
    private val PROMO_WORDS = Regex(
        "%|(?<!\\p{L})(?:off|rabatt|spar\\p{L}*|save|discount|coupon|gutschein\\p{L}*|voucher|sale|angebot\\p{L}*)(?!\\p{L})",
        RegexOption.IGNORE_CASE,
    )
    private val LABELLED_AS_OTHER = Regex(
        "(?:(?:\\p{L}*(?:nummer|number)|(?<!\\p{L})(?:nr|no|id|line|zeile|version|tel|telefon|phone|fax|mobil|plz))\\.?:?" +
            "|(?<!\\p{L})(?:order|bestellung|account|konto|invoice|rechnung|ticket|case|page|seite|room|zimmer|commit|issue|pr|build|run|job|step|port)" +
            "|ending in|endet auf|endend auf|ends with)[ #]*\\z",
        RegexOption.IGNORE_CASE,
    )
    private val LOWERCASE_HEX = Regex("^[0-9a-f-]+\\z")
    private val LINKED_BY = Regex(
        "(?::|=|(?<!\\p{L})(?:is|lautet|ist|est|es|è|é|är|er|jest|je))[$WS]*\\z",
        RegexOption.IGNORE_CASE,
    )

    private val GROUPED_DIGITS = Regex("^\\d{3,4}-\\d{3,4}\\z")
    private val BEFORE_IN_NUMBER = Regex("\\d[.,:/-]\\z")
    private val AFTER_IN_NUMBER = Regex("^[.,:/-]\\d")
    private val BEFORE_ISSUE_OR_PHONE = Regex("[#+]\\z")
    private val BEFORE_DIGIT_GROUP = Regex("(?:\\d|\\))[ /-]?\\z")
    private val AFTER_DIGIT_GROUP = Regex("^[ /-]?\\d")
    private val BEFORE_AMOUNT = Regex("[€\$£][$WS]?\\z")
    private val AFTER_AMOUNT = Regex("^[$WS]?(?:[€\$£%]|eur\\b|usd\\b|chf\\b)", RegexOption.IGNORE_CASE)
    private val ISO_TIMESTAMP = Regex("^\\d{4}-\\d\\d-\\d\\dT\\d", RegexOption.IGNORE_CASE)
    private val OWN_LINE_BEFORE = Regex("(?:^|\\n)[$WS]*\\z")
    private val OWN_LINE_AFTER = Regex("^[$WS]*(?:\\n|\\z)")

    private val INVISIBLE = Regex("[\\x{ad}\\x{200b}-\\x{200f}\\x{2060}\\x{feff}]|\\x{34f}")
    private val LINKS = Regex("https?://[^$WS]+|www\\.[^$WS]+", RegexOption.IGNORE_CASE)
    private val ADDRESSES = Regex("(?<![^$WS])[^$WS]*@[^$WS]+")
    private val SPACE_RUNS = Regex("[$WS&&[^\\n]]+")
    private val LINE_BREAKS = Regex(" ?\\n[$WS]*")
    private val CUT_OFF = Regex("(?<![\\p{L}\\p{N}-])[\\p{L}\\p{N}-]*(?:\\.\\.\\.|…)[$WS]*\\z")

    private data class Span(val start: Int, val end: Int)
    private data class Candidate(val start: Int, val end: Int, val code: String, val score: Double)

    private fun isCodeWordPart(part: String, previous: String?): Boolean {
        if (UPPERCASE_CODE_WORDS.matches(part)) return true
        val lower = part.lowercase()
        if (CODE_WORDS_EXACT.contains(lower)) return true
        for (ending in CODE_WORD_ENDINGS) {
            if (!lower.endsWith(ending)) continue
            val prefix = lower.substring(0, lower.length - ending.length)
            // A bare "code" takes its meaning from the word before it.
            val qualifier = prefix.ifEmpty { previous?.lowercase() }
            return qualifier.isNullOrEmpty() || !NOT_A_CODE_PREFIXES.contains(qualifier)
        }
        return false
    }

    private fun findCodeWords(text: String): List<Span> {
        val spans = mutableListOf<Span>()
        var previousWord: String? = null
        for (match in WORD.findAll(text)) {
            val start = match.range.first
            val end = match.range.last + 1
            val parts = match.value.split('-')
            val hit = parts.indices.any { i -> isCodeWordPart(parts[i], if (i > 0) parts[i - 1] else previousWord) }
            val next = text.substring(end, min(text.length, end + 12))
            // "Code of Conduct", "code of practice"
            if (hit && !OF_NEXT.containsMatchIn(next) && !LABELS_SHORT_NUMBER.containsMatchIn(next)) spans.add(Span(start, end))
            previousWord = parts.last()
        }
        for (re in listOf(CJK_CODE_WORDS, ONE_TIME_PASSWORD)) {
            for (match in re.findAll(text)) spans.add(Span(match.range.first, match.range.last + 1))
        }
        return spans
    }

    private fun isAlnum(c: Char): Boolean = ALNUM.matches(c.toString())
    private fun isLetter(c: Char): Boolean = LETTER.matches(c.toString())

    private fun gluedToWords(text: String, from: Int, to: Int): Boolean {
        var start = from
        var end = to
        val floor = max(0, start - GLUED_CONTEXT)
        val ceiling = min(text.length, end + GLUED_CONTEXT)
        while (start > floor && isAlnum(text[start - 1])) start--
        while (end < ceiling && isAlnum(text[end])) end++
        if ((start > 0 && isAlnum(text[start - 1])) || (end < text.length && isAlnum(text[end]))) return false
        return GLUED_TOKEN.matches(text.substring(start, end))
    }

    private fun contextWindow(text: String, from: Int, to: Int): String {
        var start = max(0, from)
        var end = min(text.length, to)
        while (start > 0 && start < end && isLetter(text[start - 1]) && isLetter(text[start])) start++
        while (end < text.length && end > start && isLetter(text[end]) && isLetter(text[end - 1])) end--
        return if (start < end) text.substring(start, end) else ""
    }

    private fun scoreCandidate(text: String, raw: String, start: Int, keywords: List<Span>): Candidate? {
        val end = start + raw.length
        val letters = raw.filter { it in 'A'..'Z' || it in 'a'..'z' }
        val digits = raw.filter { it in '0'..'9' }
        val before = contextWindow(text, start - 40, start)
        val after = text.substring(min(end, text.length), min(text.length, end + 8))

        if (digits.isEmpty()) return null
        if (letters.isNotEmpty() && letters != letters.uppercase() && letters != letters.lowercase()) return null

        var code = raw
        if (letters.isEmpty()) {
            // Grouped digits are typed without the gaps: "557 260" is 557260.
            code = digits
            if (raw.contains('-') && !GROUPED_DIGITS.containsMatchIn(raw)) return null
            if (digits.length < 4 || digits.length > 10) return null
            if (BEFORE_IN_NUMBER.containsMatchIn(before) || AFTER_IN_NUMBER.containsMatchIn(after)) return null
            if (BEFORE_ISSUE_OR_PHONE.containsMatchIn(before) || BEFORE_DIGIT_GROUP.containsMatchIn(before) ||
                AFTER_DIGIT_GROUP.containsMatchIn(after)
            ) return null
            if (BEFORE_AMOUNT.containsMatchIn(before) || AFTER_AMOUNT.containsMatchIn(after)) return null
        } else if (NUMBER_WITH_UNIT.containsMatchIn(raw) || PROMO_CODE.containsMatchIn(raw)) {
            return null
        } else if (ISO_TIMESTAMP.containsMatchIn(raw)) {
            return null
        }
        if (LABELLED_AS_OTHER.containsMatchIn(before)) return null
        if (PROMO_WORDS.containsMatchIn(contextWindow(text, start - 60, end + 40))) return null

        var best = Double.POSITIVE_INFINITY
        var bestAfter = Double.POSITIVE_INFINITY
        for (kw in keywords) {
            if (kw.start < end && kw.end > start) return null // part of a keyword ("2FA-Code")
            if (kw.end <= start && start - kw.end <= MAX_AFTER) {
                bestAfter = min(bestAfter, (start - kw.end).toDouble())
                best = min(best, (start - kw.end).toDouble())
            }
            if (kw.start >= end && kw.start - end <= MAX_BEFORE) best = min(best, (kw.start - end) * 1.5)
        }
        if (best == Double.POSITIVE_INFINITY) return null

        if (letters.isNotEmpty() && letters == letters.lowercase()) {
            if (bestAfter > 40) return null
            if (LOWERCASE_HEX.containsMatchIn(raw) && bestAfter > 2) return null
        }

        val linked = LINKED_BY.containsMatchIn(before)
        val ownLine = OWN_LINE_BEFORE.containsMatchIn(before) && OWN_LINE_AFTER.containsMatchIn(after)
        // "KI Palooza 2026": a year is only the code when it is presented as one.
        if (letters.isEmpty() && YEAR.containsMatchIn(digits) && !linked && !ownLine) return null

        var score = best
        if (linked) score -= 15
        if (ownLine) score -= 15
        return Candidate(start, end, code, score)
    }

    private fun jsTrim(text: String): String = text.trim { SPACE.matches(it.toString()) }

    private fun normalize(text: String): String {
        var out = INVISIBLE.replace(text, "")
        out = LINKS.replace(out, " ")
        out = ADDRESSES.replace(out, " ")
        out = SPACE_RUNS.replace(out, " ")
        out = LINE_BREAKS.replace(out, "\n")
        out = CUT_OFF.replace(out, "")
        return jsTrim(out)
    }

    private fun bestCandidate(rawText: String): Candidate? {
        val text = normalize(rawText)
        if (text.isEmpty()) return null
        val keywords = findCodeWords(text)
        if (keywords.isEmpty()) return null
        var best: Candidate? = null
        for (re in listOf(CANDIDATE, GLUED_DIGITS)) {
            for (match in re.findAll(text)) {
                val start = match.range.first
                if (re === GLUED_DIGITS && !gluedToWords(text, start, match.range.last + 1)) continue
                val candidate = scoreCandidate(text, match.value, start, keywords) ?: continue
                if (best == null || candidate.score < best.score) best = candidate
            }
        }
        return best
    }

    /** The one-time code in a mail, or null; a code in the subject wins. */
    fun find(subject: String?, text: String?): String? =
        bestCandidate((subject ?: "").take(MAX_SUBJECT))?.code
            ?: bestCandidate((text ?: "").take(MAX_BODY_TEXT))?.code

    /** Only fresh mail gets one: codes expire within minutes to a day. */
    fun isFresh(receivedAtEpochMs: Long, nowMs: Long): Boolean {
        if (receivedAtEpochMs <= 0L) return false
        val age = nowMs - receivedAtEpochMs
        return age >= -5L * 60 * 1000 && age <= MAX_AGE_MS
    }

    /** listVerificationCode: from the subject and preview, fresh mail only. */
    fun forNotification(subject: String?, preview: String?, receivedAtEpochMs: Long, nowMs: Long): String? =
        if (isFresh(receivedAtEpochMs, nowMs)) find(subject, preview) else null
}
