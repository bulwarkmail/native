package com.anonymous.bulwarkmobile

import okhttp3.OkHttpClient
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.time.Instant
import java.time.ZoneId
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

/**
 * Archive and Copy code on a new-mail notification (webmail public/sw.js,
 * app/api/push/action, desktop 677903094), and the client certificate on the
 * native lookup (#3).
 */
class NotificationMailActionsTest {

    // ─── Copy code: the same answers as src/lib/verification-code.ts ─────

    /** Mails whose code is in neither the subject nor the preview (verification-code.test.ts). */
    private val notInPreview = setOf(
        "Lieferando", "Planauskunft", "Tuya", "Telekom Geschäftskunden", "Telekom Login", "Steam", "Autodesk",
        "Amazon Visa",
    )

    private fun fixtureMails(): JSONArray {
        val file = File("../../src/lib/__tests__/fixtures/verification-code-mails.json")
        return JSONArray(file.readText(Charsets.UTF_8))
    }

    @Test
    fun `finds the code of each fixture mail in the subject and preview as the JS finder does`() {
        val mails = fixtureMails()
        assertTrue(mails.length() > 40)
        for (i in 0 until mails.length()) {
            val mail = mails.getJSONObject(i)
            val sender = mail.getString("sender")
            val expected = if (notInPreview.contains(sender)) null else mail.getString("code")
            assertEquals("preview of $sender", expected, VerificationCode.find(mail.getString("subject"), mail.getString("preview")))
            assertEquals("body of $sender", mail.getString("code"), VerificationCode.find(mail.getString("subject"), mail.getString("body")))
        }
    }

    @Test
    fun `reads grouped, lettered and glued codes and other languages`() {
        assertEquals("557260", VerificationCode.find("557 260 is your Instagram recovery code", ""))
        assertEquals("304627", VerificationCode.find("", "Bitte gebe folgenden Bestätigungs-Code ein: 3 0 4 6 2 7 Gebe diesen"))
        assertEquals("6ZA-BRE", VerificationCode.find("Slack confirmation code: 6ZA-BRE", ""))
        assertEquals("177945", VerificationCode.find("", "Sign in to Claude.ai177945Copy and paste the temporary verification code"))
        assertEquals("482913", VerificationCode.find("", "Your verification code for account 12345678 is 482913."))
        assertEquals("482913", VerificationCode.find("", "Ваш код подтверждения: 482913"))
        assertEquals("482913", VerificationCode.find("", "您的验证码是 482913"))
        assertEquals("2013", VerificationCode.find("", "Your code is 2013"))
        assertNull(VerificationCode.find("", "Your Login Passcode for KI Palooza 2026"))
        assertNull(VerificationCode.find("", "Your code is 1234..."))
        assertNull(VerificationCode.find("", "Rejected with code 550 (5.1.1) after 48291733 ms"))
        assertNull(VerificationCode.find("Updates to our Code of Conduct", "We updated our Code of Conduct effective 1 October 2026."))
        assertNull(VerificationCode.find("Nur heute: 25 % auf alles", "Mit dem Gutscheincode HERBST25 sparst du 25 %. Or use code THANKS10 for 10% off."))
        assertNull(VerificationCode.find("Ihre Kreditkarte", "Geben Sie niemals Ihren Sicherheitscode oder Ihre PIN weiter. Ihre Karte endet auf 4821. Meeting-ID: 845 1234 5678"))
        assertNull(VerificationCode.find("Your access code", "Your code expires 2026-10-13T15:37:13Z."))
    }

    @Test
    fun `offers a code only for fresh mail`() {
        val now = Instant.parse("2026-09-27T12:00:00Z").toEpochMilli()
        val at = { iso: String -> Instant.parse(iso).toEpochMilli() }
        assertEquals("482913", VerificationCode.forNotification("Your code is 482913", "", at("2026-09-27T11:58:00Z"), now))
        assertEquals("482913", VerificationCode.forNotification("Your code is 482913", "", at("2026-09-27T12:02:00Z"), now))
        assertNull(VerificationCode.forNotification("Your code is 482913", "", at("2026-09-26T11:59:00Z"), now))
        assertNull(VerificationCode.forNotification("Your code is 482913", "", 0L, now))
    }

    @Test
    fun `stays fast on crafted mail`() {
        val started = System.nanoTime()
        VerificationCode.find("", "code " + "a".repeat(50_000))
        VerificationCode.find("", "code " + "a1234".repeat(10_000))
        VerificationCode.find("code " + "a".repeat(200_000), "")
        VerificationCode.find("", "code " + "a".repeat(20_000) + "...")
        assertTrue((System.nanoTime() - started) / 1_000_000 < 2_000)
        assertEquals("177945", VerificationCode.find("Your code is 177945 " + "x".repeat(2_000), ""))
        assertEquals("482910", VerificationCode.find("", "Your code: 482910 reply to noreply@example.com"))
    }

    @Test
    fun `parses the code of fresh pushed mail`() {
        val now = Instant.parse("2026-11-12T12:00:00Z").toEpochMilli()
        val resp = JSONObject().put("methodResponses", JSONArray().put(JSONArray().apply {
            put("Email/get")
            put(JSONObject().put("list", JSONArray().apply {
                put(JSONObject().put("id", "m1").put("subject", "Your verification code is 482913").put("preview", "")
                    .put("receivedAt", "2026-11-12T11:59:00Z").put("keywords", JSONObject()))
                put(JSONObject().put("id", "m2").put("subject", "Lunch").put("preview", "Room 4821 at noon")
                    .put("receivedAt", "2026-11-12T11:59:30Z").put("keywords", JSONObject()))
            }))
            put("0")
        })).toString()
        val result = BulwarkNativePushFetcher.parseJmapGetResponse(resp, emptySet(), now)
            as BulwarkNativePushFetcher.JmapFetchResult.Success
        assertEquals(listOf("482913", null), result.emails.map { it.verificationCode })
    }

    // ─── Which buttons a notification gets ───────────────────────────────

    @Test
    fun `shows at most three actions in the webmail's order`() {
        assertEquals(listOf("markRead", "delete", "reply"), BulwarkFcmModule.mailActions(hasCode = false, archive = false))
        assertEquals(listOf("archive", "delete", "reply"), BulwarkFcmModule.mailActions(hasCode = false, archive = true))
        assertEquals(listOf("copyCode", "markRead", "delete"), BulwarkFcmModule.mailActions(hasCode = true, archive = false))
        assertEquals(listOf("copyCode", "archive", "delete"), BulwarkFcmModule.mailActions(hasCode = true, archive = true))
    }

    @Test
    fun `reads the archive gate and the settings the actions follow`() {
        assertTrue(BulwarkNativePushFetcher.isArchiveEnabledForAccount(JSONObject()))
        assertFalse(BulwarkNativePushFetcher.isArchiveEnabledForAccount(JSONObject().put("archiveEnabled", false)))
        assertEquals("single", BulwarkNativePushFetcher.archiveModeInSettings(null))
        assertEquals("month", BulwarkNativePushFetcher.archiveModeInSettings("""{"archiveMode":"month"}"""))
        assertEquals("single", BulwarkNativePushFetcher.archiveModeInSettings("""{"archiveMode":"weird"}"""))
        assertTrue(BulwarkNativePushFetcher.isShowVerificationCodesInSettings("{}"))
        assertFalse(BulwarkNativePushFetcher.isShowVerificationCodesInSettings("""{"showVerificationCodes":false}"""))
    }

    // ─── Where Archive files the message ─────────────────────────────────

    private val utc = ZoneId.of("UTC")
    private val nov3 = Instant.parse("2026-11-03T10:00:00Z").toEpochMilli()

    @Test
    fun `files into the Archive folder and makes it where there is none`() {
        val archive = BulwarkNativePushFetcher.ArchiveMailbox("arch", "Archive", "archive", null)
        assertEquals(
            BulwarkNativePushFetcher.ArchivePlan("arch", emptyMap()),
            BulwarkNativePushFetcher.planArchive(listOf(archive), "single", nov3, utc),
        )
        val byName = BulwarkNativePushFetcher.ArchiveMailbox("a2", "archive", null, null)
        assertEquals("a2", BulwarkNativePushFetcher.planArchive(listOf(byName), "single", nov3, utc).destination)
        val none = BulwarkNativePushFetcher.planArchive(emptyList(), "single", nov3, utc)
        assertEquals("#archive", none.destination)
        assertEquals(mapOf("archive" to BulwarkNativePushFetcher.ArchiveFolder("Archive", null, "archive")), none.create)
    }

    @Test
    fun `files by year and month in the user's time zone`() {
        val archive = BulwarkNativePushFetcher.ArchiveMailbox("arch", "Archive", "archive", null)
        val year = BulwarkNativePushFetcher.ArchiveMailbox("y26", "2026", null, "arch")
        val plan = BulwarkNativePushFetcher.planArchive(listOf(archive, year), "month", nov3, utc)
        assertEquals("#month", plan.destination)
        assertEquals(mapOf("month" to BulwarkNativePushFetcher.ArchiveFolder("11", "y26")), plan.create)
        // 23:30 UTC on 31 December is already January in Berlin.
        val newYear = Instant.parse("2026-12-31T23:30:00Z").toEpochMilli()
        val berlin = BulwarkNativePushFetcher.planArchive(listOf(archive), "month", newYear, ZoneId.of("Europe/Berlin"))
        assertEquals(
            mapOf(
                "year" to BulwarkNativePushFetcher.ArchiveFolder("2027", "arch"),
                "month" to BulwarkNativePushFetcher.ArchiveFolder("01", "#year"),
            ),
            berlin.create,
        )
    }

    @Test
    fun `reads folders with their rights`() {
        val list = JSONArray().apply {
            put(JSONObject().put("id", "arch").put("name", "Archive").put("role", "archive").put("parentId", JSONObject.NULL)
                .put("myRights", JSONObject().put("mayAddItems", false)))
            put(JSONObject().put("id", "x").put("name", "Sub").put("role", JSONObject.NULL).put("parentId", "arch"))
        }
        assertEquals(
            listOf(
                BulwarkNativePushFetcher.ArchiveMailbox("arch", "Archive", "archive", null, false),
                BulwarkNativePushFetcher.ArchiveMailbox("x", "Sub", null, "arch", null),
            ),
            BulwarkNativePushFetcher.parseArchiveMailboxes(list),
        )
    }

    // ─── Client certificate on the native lookup (#3) ────────────────────

    private fun systemSsl(): Pair<javax.net.ssl.SSLSocketFactory, X509TrustManager> {
        val tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
        tmf.init(null as java.security.KeyStore?)
        val tm = tmf.trustManagers.first { it is X509TrustManager } as X509TrustManager
        val ctx = SSLContext.getInstance("TLS")
        ctx.init(null, arrayOf(tm), null)
        return ctx.socketFactory to tm
    }

    @Test
    fun `presents the picked client certificate on the lookup and the token refresh`() {
        val ssl = systemSsl()
        var built = 0
        val (jmap, token) = BulwarkNativePushFetcher.clientsFor("my-cert") { alias ->
            assertEquals("my-cert", alias)
            built++
            ssl
        }
        assertSame(ssl.first, jmap.sslSocketFactory)
        assertSame(ssl.first, token.sslSocketFactory)
        // The token client still refuses redirects.
        assertFalse(token.followRedirects)
        // Kept for the alias.
        val again = BulwarkNativePushFetcher.clientsFor("my-cert") { error("built twice") }
        assertSame(jmap, again.first)
        assertEquals(1, built)
    }

    @Test
    fun `uses the plain clients without a certificate or when it can't be loaded`() {
        val (plain, _) = BulwarkNativePushFetcher.clientsFor(null) { error("no alias, no certificate") }
        val (failed, _) = BulwarkNativePushFetcher.clientsFor("gone") { throw IllegalStateException("KeyChain refused") }
        assertSame(plain, failed)
        val (withCert, _) = BulwarkNativePushFetcher.clientsFor("other") { systemSsl() }
        assertNotSame(plain, withCert)
        assertTrue(plain is OkHttpClient)
    }
}
