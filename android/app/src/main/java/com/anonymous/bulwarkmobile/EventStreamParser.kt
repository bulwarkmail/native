package com.anonymous.bulwarkmobile

import java.io.ByteArrayOutputStream

/**
 * Reads `text/event-stream` (the HTML living standard's format, which JMAP
 * uses): fed the bytes as they arrive, in chunks cut anywhere, it returns
 * the events completed so far. Lines end in CR, LF or CRLF; a line
 * starting with a colon is a comment; a blank line ends an event. Bytes
 * are kept until their line is complete, so a character cut in two by a
 * chunk boundary is decoded whole.
 */
class EventStreamParser {
    data class Event(val type: String, val data: String)

    private val line = ByteArrayOutputStream()
    private var afterCr = false
    private var type = ""
    private val data = StringBuilder()
    private var hasData = false
    private var tooLong = false

    fun feed(bytes: ByteArray, length: Int = bytes.size): List<Event> {
        val out = ArrayList<Event>()
        for (i in 0 until length) {
            val b = bytes[i]
            if (afterCr) {
                afterCr = false
                if (b == LF) continue
            }
            when (b) {
                CR -> {
                    afterCr = true
                    endLine(out)
                }
                LF -> endLine(out)
                else -> if (line.size() < MAX_LINE_BYTES) line.write(b.toInt()) else tooLong = true
            }
        }
        return out
    }

    private fun endLine(out: MutableList<Event>) {
        val text = line.toString(Charsets.UTF_8.name())
        line.reset()
        if (text.isEmpty()) {
            if (hasData && !tooLong) out += Event(type.ifEmpty { "message" }, data.toString())
            type = ""
            data.setLength(0)
            hasData = false
            tooLong = false
            return
        }
        if (tooLong) {
            data.setLength(0)
            return
        }
        if (text.startsWith(":")) return
        val colon = text.indexOf(':')
        val field = if (colon < 0) text else text.substring(0, colon)
        var value = if (colon < 0) "" else text.substring(colon + 1)
        if (value.startsWith(" ")) value = value.substring(1)
        when (field) {
            "event" -> type = value
            "data" -> {
                if (hasData) data.append('\n')
                data.append(value)
                hasData = true
                if (data.length > MAX_LINE_BYTES) {
                    tooLong = true
                    data.setLength(0)
                }
            }
        }
    }

    companion object {
        /** Longer lines are dropped with their event: what arrives is no event stream. */
        const val MAX_LINE_BYTES = 1 shl 20

        private const val CR = '\r'.code.toByte()
        private const val LF = '\n'.code.toByte()
    }
}
