package com.anonymous.bulwarkmobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

// The code a new mail's notification offers to copy (OtpCode). The texts are
// shaped like real sign-in mail: the code is in the subject, in the preview,
// or both, and other numbers stand nearby.
class OtpCodeTest {
    @Test
    fun `finds the code in the subject`() {
        assertEquals("482913", OtpCode.find("482913 is your verification code", null))
        assertEquals("482913", OtpCode.find("Your sign-in code: 482913", "Enter it on the page."))
    }

    @Test
    fun `finds the code in the preview`() {
        assertEquals(
            "731045",
            OtpCode.find(
                "Your Example account security code",
                "Please use the following security code for the Example account wy***@example.com. Security code: 731045",
            ),
        )
        assertEquals("9055", OtpCode.find("Sign in to Example", "Your one-time PIN is 9055. It expires in 10 minutes."))
    }

    @Test
    fun `takes a code split in two groups whole`() {
        assertEquals("123456", OtpCode.find("Verification code", "Your code is 123 456"))
        assertEquals("12345678", OtpCode.find("Verification code", "Your code is 1234-5678."))
    }

    @Test
    fun `finds a code of capitals and digits`() {
        assertEquals("K7Q2X9", OtpCode.find("Confirm your email", "Your confirmation code is K7Q2X9"))
        assertEquals("F4K2N", OtpCode.find("Your Steam account: Access from new computer", "Login Code F4K2N"))
        assertEquals("Q7K2M9", OtpCode.find("Slack confirmation code: Q7K-2M9", null))
    }

    @Test
    fun `finds a code right after a colon`() {
        assertEquals("731045", OtpCode.find("Sign in", "Your code:731045"))
        assertEquals("308451", OtpCode.find("验证码:308451", null))
    }

    @Test
    fun `takes a year-like code only right after the code word`() {
        assertEquals("2048", OtpCode.find("Your PIN 2048", null))
        assertEquals("1987", OtpCode.find("Your Example code is 1987", null))
        assertEquals("4821", OtpCode.find("Your temporary PIN number 4821", null))
    }

    @Test
    fun `takes full-width digits as plain ones`() {
        assertEquals("482913", OtpCode.find("確認コード：４８２９１３", null))
    }

    @Test
    fun `finds the code in other languages`() {
        assertEquals("583920", OtpCode.find("Ihr Bestätigungscode", "Ihr Code lautet 583920."))
        assertEquals("482913", OtpCode.find("Votre code de vérification", "Votre code de vérification est : 482913."))
        assertEquals("204816", OtpCode.find("Tu código de verificación es 204816", null))
        assertEquals("661204", OtpCode.find("Код подтверждения: 661204", null))
        assertEquals("308451", OtpCode.find("您的验证码是308451", null))
        assertEquals("520731", OtpCode.find("인증 코드: 520731", null))
        assertEquals("447120", OtpCode.find("รหัส OTP ของคุณคือ 447120", null))
        assertEquals("482913", OtpCode.find("Din engangskode er 482913", null))
        assertEquals("482913", OtpCode.find("Din verifieringskod: 482913", null))
        assertEquals("482913", OtpCode.find("Doğrulama kodunuz: 482913", null))
        assertEquals("482913", OtpCode.find("Codul tău de verificare este 482913", null))
    }

    @Test
    fun `takes the code after the word over the number before it`() {
        assertEquals("482913", OtpCode.find("Account 40021987 verification code: 482913", null))
        assertEquals("482913", OtpCode.find("Ref 77812 code: 482913", null))
    }

    @Test
    fun `offers nothing for a meeting invite`() {
        assertNull(OtpCode.find("Zoom meeting invitation", "Meeting ID: 812 3456 7890 Passcode: 448812"))
        assertNull(OtpCode.find("Weekly sync", "Join by phone: PIN: 482 913 117#, dial-in +1 555 0100"))
    }

    @Test
    fun `takes a code before its word only where it leads a line`() {
        assertNull(OtpCode.find("Issue 48213 updated: Login code no longer sent", null))
        assertNull(OtpCode.find("Your shipment 7712 3456 9012 is on its way", "Delivery code needed at the door"))
    }

    @Test
    fun `offers nothing for a phone number near a code word`() {
        assertNull(OtpCode.find("Reset your password", "Use the link below. No code? Call 1 888 555 0199"))
    }

    @Test
    fun `takes the number nearest the code word`() {
        assertEquals(
            "904417",
            OtpCode.find(
                "Order 55512345 shipped",
                "Someone tried to sign in. If it was you, your verification code is 904417",
            ),
        )
    }

    @Test
    fun `offers nothing without a word that names a code`() {
        assertNull(OtpCode.find("Your order 482913 has shipped", "Track it at the link below."))
        assertNull(OtpCode.find("Invoice 2026-0042", "Amount due: 1234"))
        assertNull(OtpCode.find("Lunch at 1230?", "Call me at 5551234"))
    }

    @Test
    fun `offers nothing for codes that are not for signing in`() {
        assertNull(OtpCode.find("20% off this week", "Use promo code SAVE2026 at checkout"))
        assertNull(OtpCode.find("Delivery update", "We could not find postal code 90210"))
        assertNull(OtpCode.find("Build failed", "The server answered with error code 5003"))
        assertNull(OtpCode.find("Fall sale", "Use code FALL25 for 25% off"))
        assertNull(OtpCode.find("A gift for you", "Your gift card code: 4829 1739"))
        assertNull(OtpCode.find("Your trip to Lisbon", "Your flight confirmation code is HX4K92"))
        assertNull(OtpCode.find("Scan to pay", "Show this barcode 48291739 at the till"))
        assertNull(OtpCode.find("Black Friday early access", "Your early access code: BF2026"))
        assertNull(OtpCode.find("Herbstaktion", "Dein Aktionscode: HERBST25"))
        assertNull(OtpCode.find("Payment failed", "The bank answered with decline code 2051"))
        assertNull(OtpCode.find("Porter booking", "Confirmation code: 4X7K2P. Flight PD 2241 departs at 09:10"))
    }

    @Test
    fun `finds the code of a password reset`() {
        assertEquals("482913", OtpCode.find("Reset your password", "Use this code to reset your password: 482913"))
    }

    @Test
    fun `offers nothing for code in prose`() {
        assertNull(OtpCode.find("Kotlin weekly", "A new code formatter, 4500 commits from 300 people"))
    }

    @Test
    fun `offers nothing for the number a code word is about`() {
        assertNull(OtpCode.find("Action needed", "Your card ending in 4821 needs to be verified"))
        assertNull(OtpCode.find("Verification needed", "We need to verify account 12345678"))
    }

    @Test
    fun `offers nothing for prices, times, dates, years and decimals near a code word`() {
        assertNull(OtpCode.find("Your code", "Your code expires at 12:30 on 2026/11/14"))
        assertNull(OtpCode.find("Gift card code", "Balance \$1234.56"))
        assertNull(OtpCode.find("Verification", "© 2026 Example Inc."))
        assertNull(OtpCode.find("Verification code", "Ticket #123456 was updated"))
    }

    @Test
    fun `offers nothing for a number too far from the code word`() {
        val filler = "x".repeat(80)
        assertNull(OtpCode.find("Verification", "$filler 482913"))
    }

    @Test
    fun `takes a code that ends the sentence`() {
        assertEquals("482913", OtpCode.find(null, "Your verification code is 482913."))
        assertEquals("482913", OtpCode.find(null, "Your verification code is 482913, valid for 5 minutes"))
    }

    @Test
    fun `offers nothing for an empty mail`() {
        assertNull(OtpCode.find(null, null))
        assertNull(OtpCode.find("", " "))
    }
}
