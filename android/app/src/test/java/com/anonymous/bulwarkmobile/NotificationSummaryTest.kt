package com.anonymous.bulwarkmobile

import org.junit.Assert.assertEquals
import org.junit.Test

// The lines of an account's group summary. Under the organisation's rule
// (withoutContent from src/lib/push-background-task.ts) the summary lists
// nothing from the group: it can still hold message notifications the app
// has just taken out, with sender and subject.
class NotificationSummaryTest {
    private val group = listOf<Pair<CharSequence?, CharSequence?>>(
        "Ann" to "Quarterly numbers",
        "New email" to "alice",
        "Bob" to null,
    )

    @Test
    fun `lists no line from the group under the rule`() {
        assertEquals(emptyList<String>(), NotificationSummary.lines(group, withoutContent = true))
    }

    @Test
    fun `lists title and text of the newest notifications without the rule`() {
        assertEquals(
            listOf("Ann  Quarterly numbers", "New email  alice", "Bob"),
            NotificationSummary.lines(group, withoutContent = false),
        )
    }

    @Test
    fun `lists at most five and skips empty ones`() {
        val many = List(7) { "Sender $it" to "Subject $it" } + listOf<Pair<CharSequence?, CharSequence?>>(null to " ")
        assertEquals(5, NotificationSummary.lines(many, withoutContent = false).size)
        assertEquals(emptyList<String>(), NotificationSummary.lines(listOf(null to " "), withoutContent = false))
    }
}
