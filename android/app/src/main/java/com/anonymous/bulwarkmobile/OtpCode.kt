package com.anonymous.bulwarkmobile

import java.text.Normalizer

/**
 * Finds a sign-in code (two-factor, verification, one-time password) in a
 * new mail's subject and preview, for the notification's Copy action. A
 * number only counts close to a word that names a code, so order numbers,
 * prices, dates and phone numbers in other mail offer nothing. Offering a
 * wrong number is worse than offering none: when in doubt, it offers none.
 */
object OtpCode {
    // Words that name a code, in the app's languages. The short Latin ones
    // need word edges ("pin" is in "shipping"); "code" and "kod" may end a
    // longer word ("Bestätigungscode", "engangskode", "verifieringskod").
    private val KEYWORD = Regex(
        "\\b(?:otp|pin|tan|2fa|mfa)\\b|code|passcode|verification|one[- ]time|two[- ]factor|" +
            "código|codigo|codice|\\bcod(?:ul)?\\b|kod(?:e|en|s|u|unuz)?\\b|kód|koodi|код|κωδικ|" +
            "コード|認証|验证码|驗證碼|인증|코드|รหัส|رمز|קוד",
        RegexOption.IGNORE_CASE,
    )

    // A bare English "code" is also prose ("a code formatter"). Text whose
    // only code word is that must say what the code is for somewhere.
    private val SIGN_IN = Regex(
        "v[eé]rif|one[- ]time|\\b(?:otp|2fa|mfa|pin)\\b|two[- ]factor|passcode|sign[- ]?in|log[- ]?in|inlog|" +
            "anmeld|connexion|confirm|authenticat|password|reset|security code|access code|your code|this code|" +
            "code is|code:",
        RegexOption.IGNORE_CASE,
    )

    // A code word that names something else when one of these comes right
    // before it: "promo code", "gift card code", "postal code", "error
    // code", or glued on: "barcode", "Unicode", "decode", "Aktionscode".
    private val NOT_A_SIGN_IN_CODE = Regex(
        "(?:\\b(?:promo|promotional|discount|coupon|voucher|gift|card|referral|invite|invitation|zip|postal|" +
            "post|area|country|error|exit|decline|status|source|tracking|order|booking|qr|bar|dress|" +
            "rabatt|gutschein|aktions)[\\s-]*|" +
            "(?<!\\p{L})(?:uni|bar|de|en|geo|op|short|post|zip|promo|qr))$",
        RegexOption.IGNORE_CASE,
    )

    // A number right after one of these is not the code but what it is for:
    // "card ending in 4821", "Account 40021987", "Issue 48213", "Flight PD
    // 2241". "PIN number 4821" is still a PIN.
    private val NAMED_NUMBER = Regex(
        "\\b(?:ending in|ending with|account|acct|card|order|invoice|ticket|ref|reference|id|no|" +
            "(?<!(?:pin|code)\\s)number|issue|case|request|build|version|shipment|flight(?:\\s+[A-Z]{2})?)" +
            "[\\s:#.]*$",
        RegexOption.IGNORE_CASE,
    )

    // Mail that sells something or invites to a meeting: a code there is a
    // discount or a meeting passcode, not a sign-in. Travel mail may still
    // carry a numeric code, so only codes with letters are left out there.
    private val NOT_SIGN_IN_MAIL = Regex(
        "\\d\\s?% off|\\b(?:discount|coupon|voucher|promo|sale|checkout)\\b|" +
            "\\b(?:meeting|conference) id\\b|dial-in|join the meeting",
        RegexOption.IGNORE_CASE,
    )
    private val TRAVEL = Regex(
        "\\b(?:flight|booking|reservation|itinerary|boarding|check-in)\\b",
        RegexOption.IGNORE_CASE,
    )

    // A word followed by a number, or a number by a word: "BF2026", "SAVE20".
    private val WORD_AND_NUMBER = Regex("[A-Z]+[0-9]+|[0-9]+[A-Z]+")

    private const val SPACED_LETTER =
        "\\p{IsLatin}\\p{IsCyrillic}\\p{IsGreek}\\p{IsArabic}\\p{IsHebrew}\\p{IsHangul}\\p{IsThai}"

    // 4 to 8 digits, or two groups of 3 or 4 split by a space or hyphen, or
    // 5 to 8 capitals and digits (Steam's F4K2N), or two groups of 3 of them
    // (Slack's Q7K-2M9). Nothing that runs on into a word, an address, a
    // price, a time, a date, a decimal or a longer row of digit groups (a
    // phone or dial-in number: "1 888 555 0199"). A full stop or comma that
    // ends the sentence is fine. Chinese and Japanese put no space before a
    // code ("验证码是308451"), so only letters of spaced scripts count as a
    // word running on. [0-9], not \d: Android's \d takes any script's digits.
    private val CANDIDATE = Regex(
        "(?<![$SPACED_LETTER\\p{N}@#\$€£¥+/.,_=-])(?<![0-9][ -])" +
            "((?:[0-9]{3}[ -][0-9]{3}|[0-9]{4}[ -][0-9]{4})(?![ -][0-9])|[0-9]{4,8}|" +
            "[A-Z0-9]{3}-[A-Z0-9]{3}|[A-Z0-9]{5,8})" +
            "(?![$SPACED_LETTER\\p{N}@%/:_=-]|[.,]\\p{N})",
    )

    // How far, in characters, a code may stand from the word that names it.
    private const val MAX_GAP = 60

    // A code before its word counts only where it leads the subject or a
    // line ("482913 is your code"); elsewhere a number before the word is
    // what the code is for ("Account 4002 code: 4829"). It loses to one after.
    private const val BEFORE_PENALTY = 20

    // A year ("© 2026") only counts as a code straight after the word
    // ("PIN 2048", "your code is 1987").
    private val YEAR_AFTER_WORD = Regex("[\\s:：]{1,3}|\\s+is\\s+", RegexOption.IGNORE_CASE)

    fun find(subject: String?, preview: String?): String? {
        val joined = listOfNotNull(subject, preview).filter { it.isNotBlank() }.joinToString("\n")
        // Full-width digits and letters ("４８２９１３") become plain ones.
        val text = Normalizer.normalize(joined, Normalizer.Form.NFKC)
        if (text.isEmpty() || NOT_SIGN_IN_MAIL.containsMatchIn(text)) return null
        val digitsOnly = TRAVEL.containsMatchIn(text)

        val keywords = KEYWORD.findAll(text)
            .filter { !NOT_A_SIGN_IN_CODE.containsMatchIn(text.substring(0, it.range.first)) }
            .toList()
        if (keywords.isEmpty()) return null
        if (keywords.all { isBareCode(text, it) } && !SIGN_IN.containsMatchIn(text)) return null
        val ranges = keywords.map { it.range }

        var best: String? = null
        var bestScore = Int.MAX_VALUE
        for (match in CANDIDATE.findAll(text)) {
            val code = match.value.filter { it != ' ' && it != '-' }
            if (!plausible(code) || (digitsOnly && !code.all { it.isDigit() })) continue
            if (NAMED_NUMBER.containsMatchIn(text.substring(maxOf(0, match.range.first - 20), match.range.first))) continue
            val leadsLine = match.range.first == 0 || text[match.range.first - 1] == '\n'
            val score = ranges.minOf { score(it, match.range, leadsLine) }
            if (score == Int.MAX_VALUE) continue
            if (isYear(code) && ranges.none { yearFollows(text, it, match.range) }) continue
            if (score < bestScore) {
                best = code
                bestScore = score
            }
        }
        return best
    }

    private fun plausible(code: String): Boolean {
        if (code.all { it.isDigit() }) return true
        // Capitals and digits: a code mixes them through (F4K2N, Q7K2M9) with
        // at least two digits, so a shouted word ("ACCOUNT"), a model name
        // ("A1") or a promotion ("HERBST25", "BF2026") is not one.
        return code.count { it.isDigit() } >= 2 && code.any { it.isLetter() } && !WORD_AND_NUMBER.matches(code)
    }

    private fun isBareCode(text: String, keyword: MatchResult): Boolean =
        keyword.value.equals("code", ignoreCase = true) &&
            (keyword.range.first == 0 || !text[keyword.range.first - 1].isLetter())

    private fun isYear(code: String): Boolean = code.length == 4 && code.all { it.isDigit() } && code.toInt() in 1900..2099

    private fun yearFollows(text: String, keyword: IntRange, code: IntRange): Boolean =
        keyword.last < code.first && YEAR_AFTER_WORD.matches(text.substring(keyword.last + 1, code.first))

    // The characters between the word and the code, plus the penalty for a
    // code before the word. Past MAX_GAP, or before the word anywhere but
    // at the start of a line, it does not count at all.
    private fun score(keyword: IntRange, code: IntRange, leadsLine: Boolean): Int = when {
        keyword.last < code.first -> (code.first - keyword.last - 1).takeIf { it <= MAX_GAP }
        code.last < keyword.first ->
            if (leadsLine) (keyword.first - code.last - 1).takeIf { it <= MAX_GAP }?.plus(BEFORE_PENALTY) else null
        else -> 0
    } ?: Int.MAX_VALUE
}
