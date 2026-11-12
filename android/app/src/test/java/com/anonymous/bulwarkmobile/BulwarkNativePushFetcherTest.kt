package com.anonymous.bulwarkmobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.IOException
import java.net.ServerSocket
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

class BulwarkNativePushFetcherTest {

    @Test
    fun `credentialsKey and AsyncStorage keys match JS definitions`() {
        assertEquals(
            "jmap_credentials__ada_mail.example.org_8443",
            BulwarkNativePushFetcher.credentialsKeyFor("ada@mail.example.org:8443"),
        )
        assertEquals(
            "push:notifiedIds:v1:ada@mail.example.org",
            BulwarkNativePushFetcher.notifiedIdsKeyFor("ada@mail.example.org"),
        )
        assertEquals(
            "push:lastNotifiedEmailId:v2:ada@mail.example.org",
            BulwarkNativePushFetcher.lastNotifiedKeyFor("ada@mail.example.org"),
        )
        assertEquals(
            "push:optedOut:v1:ada@mail.example.org",
            BulwarkNativePushFetcher.optedOutKeyFor("ada@mail.example.org"),
        )
    }

    @Test
    fun `notified IDs ring parses and merges with 200-item cap and legacy fallback`() {
        assertEquals(
            listOf("m2", "m1"),
            BulwarkNativePushFetcher.parseNotifiedIds("""["m2","m1"]""", "legacy"),
        )
        assertEquals(
            listOf("legacy"),
            BulwarkNativePushFetcher.parseNotifiedIds(null, "legacy"),
        )
        assertEquals(
            listOf("legacy"),
            BulwarkNativePushFetcher.parseNotifiedIds("not-json", "legacy"),
        )
        assertEquals(
            emptyList<String>(),
            BulwarkNativePushFetcher.parseNotifiedIds(null, null),
        )

        val merged = BulwarkNativePushFetcher.mergeNotifiedIds(
            current = listOf("m2", "m1"),
            newIds = listOf("m3", "m2"),
            limit = 200,
        )
        assertEquals(listOf("m3", "m2", "m1"), merged)

        val capped = BulwarkNativePushFetcher.mergeNotifiedIds(
            current = (1..200).map { "old-$it" },
            newIds = listOf("new-2", "new-1"),
            limit = 5,
        )
        assertEquals(listOf("new-2", "new-1", "old-1", "old-2", "old-3"), capped)
    }

    @Test
    fun `settings parsing honours emailNotificationsEnabled, senderFavicons and deleteAction`() {
        assertTrue(BulwarkNativePushFetcher.isEmailNotificationsEnabledInSettings(null))
        assertTrue(BulwarkNativePushFetcher.isEmailNotificationsEnabledInSettings("{}"))
        assertTrue(BulwarkNativePushFetcher.isEmailNotificationsEnabledInSettings("""{"emailNotificationsEnabled":true}"""))
        assertFalse(BulwarkNativePushFetcher.isEmailNotificationsEnabledInSettings("""{"emailNotificationsEnabled":false}"""))

        assertFalse(BulwarkNativePushFetcher.isSenderFaviconsEnabledInSettings(null))
        assertFalse(BulwarkNativePushFetcher.isSenderFaviconsEnabledInSettings("{}"))
        assertTrue(BulwarkNativePushFetcher.isSenderFaviconsEnabledInSettings("""{"senderFavicons":true}"""))

        assertFalse(BulwarkNativePushFetcher.isDeleteMarksReadInSettings(null))
        assertFalse(BulwarkNativePushFetcher.isDeleteMarksReadInSettings("""{"deleteAction":"trash"}"""))
        assertTrue(BulwarkNativePushFetcher.isDeleteMarksReadInSettings("""{"deleteAction":"trash-and-read"}"""))
    }

    @Test
    fun `cleanPreview and singleLine strip CSS, preheader padding and emphasis markers`() {
        val cssAndPadding = "\u200B\u034F @media screen and (min-width:600px){.hide{display:none!important}} body{color:red} *Hello*   \n  world!"
        assertEquals(
            "Hello world!",
            BulwarkNativePushFetcher.singleLine(BulwarkNativePushFetcher.cleanPreview(cssAndPadding)),
        )
        assertEquals(
            "",
            BulwarkNativePushFetcher.cleanPreview("\u200B\u200C ... "),
        )
        assertEquals(
            "@Page 3 is ready",
            BulwarkNativePushFetcher.cleanPreview("@Page 3 is ready"),
        )
    }

    @Test
    fun `avatar initials, color and favicon domain match JS avatar-utils`() {
        assertEquals("SR", BulwarkNativePushFetcher.getEmailInitials("\"Sofia\" Russo", "sofia@example.org"))
        assertEquals("AL", BulwarkNativePushFetcher.getEmailInitials("Alice", "alice@example.org"))
        assertEquals("B", BulwarkNativePushFetcher.getEmailInitials("", "bob@example.org"))
        assertEquals("?", BulwarkNativePushFetcher.getEmailInitials("", ""))

        val hex = BulwarkNativePushFetcher.generateEmailAvatarColorHex("Alice Lovelace", "alice@example.org")
        assertTrue("Expected #rrggbb, got $hex", hex.matches(Regex("^#[0-9a-f]{6}$")))

        assertNull(BulwarkNativePushFetcher.getFaviconDomain("user@gmail.com"))
        assertNull(BulwarkNativePushFetcher.getFaviconDomain("user@example.org"))
        assertEquals("bulwarkmail.org", BulwarkNativePushFetcher.getFaviconDomain("news@sub.bulwarkmail.org"))
        assertEquals("bbc.co.uk", BulwarkNativePushFetcher.getFaviconDomain("alerts@news.bbc.co.uk"))
    }

    @Test
    fun `parseJmapGetResponse distinguishes failure, all-seen empty success, and ordered unread emails`() {
        // 1. JMAP method error -> Failure (must fall back to headless JS task)
        val errorResp = """
            {
              "methodResponses": [
                ["error", {"type": "accountNotFound"}, "0"]
              ]
            }
        """.trimIndent()
        assertTrue(
            BulwarkNativePushFetcher.parseJmapGetResponse(errorResp, emptySet())
                is BulwarkNativePushFetcher.JmapFetchResult.Failure
        )

        // 2. All returned messages are already $seen or $junk -> Success with empty list
        // (so processPush returns true without waking the freezing headless JS task)
        val seenResp = """
            {
              "methodResponses": [
                ["Email/get", {
                  "accountId": "c",
                  "list": [
                    {
                      "id": "m1",
                      "threadId": "t1",
                      "subject": "Already read elsewhere",
                      "preview": "Body",
                      "receivedAt": "2026-11-11T10:00:00Z",
                      "keywords": {"${'$'}seen": true}
                    },
                    {
                      "id": "m2",
                      "threadId": "t2",
                      "subject": "Spam",
                      "preview": "Spam body",
                      "receivedAt": "2026-11-11T10:01:00Z",
                      "keywords": {"${'$'}junk": true}
                    }
                  ]
                }, "0"],
                ["Mailbox/get", {
                  "accountId": "c",
                  "list": [{"id": "mb-trash", "role": "trash"}]
                }, "1"]
              ]
            }
        """.trimIndent()
        val seenResult = BulwarkNativePushFetcher.parseJmapGetResponse(seenResp, emptySet())
            as BulwarkNativePushFetcher.JmapFetchResult.Success
        assertTrue(seenResult.emails.isEmpty())
        assertTrue(seenResult.hasTrash)

        // 3. Multiple unread messages are filtered against alreadyNotified and sorted oldest-first
        val unreadResp = """
            {
              "methodResponses": [
                ["Email/get", {
                  "accountId": "c",
                  "list": [
                    {
                      "id": "m-newer",
                      "threadId": "t-newer",
                      "from": [{"name": "Grace Hopper", "email": "grace@navy.mil"}],
                      "subject": "Newest\nmessage",
                      "preview": "body{color:black} **Important** update",
                      "receivedAt": "2026-11-11T12:05:00Z",
                      "keywords": {}
                    },
                    {
                      "id": "m-older",
                      "threadId": "t-older",
                      "from": [{"name": "Ada", "email": "ada@ analytical.uk"}],
                      "subject": "Older message",
                      "preview": "First arrived",
                      "receivedAt": "2026-11-11T12:01:00Z",
                      "keywords": {}
                    },
                    {
                      "id": "m-already",
                      "threadId": "t-already",
                      "subject": "Already notified",
                      "preview": "Skip",
                      "receivedAt": "2026-11-11T12:00:00Z",
                      "keywords": {}
                    }
                  ]
                }, "0"],
                ["Mailbox/get", {
                  "accountId": "c",
                  "list": [{"id": "mb-inbox", "role": "inbox"}]
                }, "1"]
              ]
            }
        """.trimIndent()
        val unreadResult = BulwarkNativePushFetcher.parseJmapGetResponse(unreadResp, setOf("m-already"))
            as BulwarkNativePushFetcher.JmapFetchResult.Success
        assertFalse(unreadResult.hasTrash)
        assertEquals(listOf("m-older", "m-newer"), unreadResult.emails.map { it.id })
        assertEquals("Newest message", unreadResult.emails[1].subject)
        assertEquals("Important update", unreadResult.emails[1].preview)
    }

    @Test
    fun `a request gives up at the push deadline, not after the read timeout`() {
        // A server that takes the connection and never answers.
        ServerSocket(0).use { server ->
            val held = mutableListOf<java.net.Socket>()
            thread(isDaemon = true) {
                try {
                    while (true) held += server.accept()
                } catch (_: IOException) {
                }
            }
            val client = OkHttpClient.Builder()
                .connectTimeout(10, TimeUnit.SECONDS)
                .readTimeout(10, TimeUnit.SECONDS)
                .build()
            val request = Request.Builder().url("http://127.0.0.1:${server.localPort}/jmap/").build()
            val started = System.currentTimeMillis()
            var failed = false
            try {
                BulwarkNativePushFetcher.executeBefore(client, request, started + 500) { it.code }
            } catch (_: IOException) {
                failed = true
            }
            val took = System.currentTimeMillis() - started
            assertTrue(failed)
            assertTrue("gave up after $took ms", took < 3_000)

            // No time left: no request at all.
            var refused = false
            try {
                BulwarkNativePushFetcher.executeBefore(client, request, System.currentTimeMillis() - 1) { it.code }
            } catch (e: IOException) {
                refused = e.message?.startsWith("No time left") == true
            }
            assertTrue(refused)
            held.forEach { it.close() }
        }
    }
}
