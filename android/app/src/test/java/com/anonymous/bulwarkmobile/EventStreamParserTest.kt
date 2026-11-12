package com.anonymous.bulwarkmobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class EventStreamParserTest {
    private fun parse(vararg chunks: String): List<EventStreamParser.Event> {
        val parser = EventStreamParser()
        return chunks.flatMap { parser.feed(it.toByteArray(Charsets.UTF_8)) }
    }

    // As Stalwart writes them (crates/jmap/src/api/event_source.rs).
    private val ping = "event: ping\ndata: {\"interval\": 120}\n\n"
    private val state = "event: state\ndata: {\"@type\":\"StateChange\",\"changed\":{\"c\":{\"EmailDelivery\":\"s1\"}}}\n\n"

    @Test
    fun `reads a ping and a state event`() {
        val events = parse(ping + state)
        assertEquals(listOf("ping", "state"), events.map { it.type })
        assertEquals("{\"interval\": 120}", events[0].data)
    }

    @Test
    fun `skips comment lines`() {
        val events = parse(": keep-alive\n\n$ping")
        assertEquals(listOf("ping"), events.map { it.type })
    }

    @Test
    fun `an event cut anywhere comes out whole`() {
        val whole = (ping + state).toByteArray(Charsets.UTF_8)
        for (cut in 1 until whole.size) {
            val parser = EventStreamParser()
            val events = parser.feed(whole.copyOfRange(0, cut)) + parser.feed(whole.copyOfRange(cut, whole.size))
            assertEquals("cut at $cut", listOf("ping", "state"), events.map { it.type })
            assertEquals("cut at $cut", state.lines()[1].removePrefix("data: "), events[1].data)
        }
    }

    @Test
    fun `a character cut in two by a chunk is decoded whole`() {
        val bytes = "data: Zoë\n\n".toByteArray(Charsets.UTF_8)
        val split = bytes.indexOfFirst { it < 0 } + 1
        val parser = EventStreamParser()
        val events = parser.feed(bytes.copyOfRange(0, split)) + parser.feed(bytes.copyOfRange(split, bytes.size))
        assertEquals(listOf(EventStreamParser.Event("message", "Zoë")), events)
    }

    @Test
    fun `CRLF line ends, also split between chunks`() {
        val events = parse("event: ping\r", "\ndata: {\"interval\": 30}\r\n\r\n")
        assertEquals(listOf(EventStreamParser.Event("ping", "{\"interval\": 30}")), events)
    }

    @Test
    fun `bare CR line ends`() {
        val events = parse("event: ping\rdata: {\"interval\": 30}\r\r")
        assertEquals(listOf(EventStreamParser.Event("ping", "{\"interval\": 30}")), events)
    }

    @Test
    fun `several data lines are joined`() {
        val events = parse("event: state\ndata: {\"a\":\ndata: 1}\n\n")
        assertEquals("{\"a\":\n1}", events.single().data)
    }

    @Test
    fun `an unfinished event is held back`() {
        assertTrue(parse("event: state\ndata: {}\n").isEmpty())
    }

    @Test
    fun `a field without a space after the colon`() {
        val events = parse("event:state\ndata:{}\n\n")
        assertEquals(listOf(EventStreamParser.Event("state", "{}")), events)
    }

    @Test
    fun `an oversized line drops its event and the stream goes on`() {
        val parser = EventStreamParser()
        val huge = ByteArray(EventStreamParser.MAX_LINE_BYTES + 10) { 'x'.code.toByte() }
        val events = parser.feed("event: state\ndata: ".toByteArray()) +
            parser.feed(huge) +
            parser.feed("\n\n$ping".toByteArray())
        assertEquals(listOf("ping"), events.map { it.type })
    }

    @Test
    fun `many data lines past the cap drop the event`() {
        val line = "data: " + "y".repeat(1000) + "\n"
        val text = "event: state\n" + line.repeat(EventStreamParser.MAX_LINE_BYTES / 1000 + 2) + "\n" + ping
        assertEquals(listOf("ping"), parse(text).map { it.type })
    }
}
