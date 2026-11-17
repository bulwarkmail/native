package com.anonymous.bulwarkmobile

/**
 * The wait before a refresh token is sent to the token endpoint again after
 * the endpoint answered a refresh with it with an error: `refreshBackoff` in
 * src/lib/oauth.ts. Each push
 * and notification action refreshes on its own, so without a wait a token
 * endpoint answering 429 or 5xx gets a refresh for every push (#166). The
 * wait doubles with each failure in a row, from [minMs] to [maxMs], and
 * follows the server's Retry-After when that is longer. A refresh token that
 * worked, or a new one written by the app, has no wait.
 */
internal class RefreshBackoff(
    private val minMs: Long = 30_000L,
    private val maxMs: Long = 30L * 60 * 1000,
    private val capacity: Int = 64,
) {
    private data class Entry(val failures: Int, val untilMs: Long)

    private val entries = LinkedHashMap<String, Entry>()

    /** Milliseconds left before [refreshToken] may be sent again; 0 when it may. */
    @Synchronized
    fun waitingMs(refreshToken: String, nowMs: Long): Long =
        ((entries[refreshToken]?.untilMs ?: 0L) - nowMs).coerceAtLeast(0L)

    @Synchronized
    fun failed(refreshToken: String, nowMs: Long, retryAfterMs: Long?) {
        val failures = (entries.remove(refreshToken)?.failures ?: 0) + 1
        val doubling = if (failures > 20) maxMs else (minMs shl (failures - 1)).coerceAtMost(maxMs)
        val wait = maxOf(doubling, retryAfterMs ?: 0L).coerceAtMost(maxMs)
        if (entries.size >= capacity) entries.remove(entries.keys.first())
        entries[refreshToken] = Entry(failures, nowMs + wait)
    }

    @Synchronized
    fun succeeded(refreshToken: String) {
        entries.remove(refreshToken)
    }

    companion object {
        /** A `Retry-After` in seconds as milliseconds; null when absent or a date. */
        fun retryAfterMs(header: String?): Long? =
            header?.trim()?.toLongOrNull()?.takeIf { it > 0 }?.let { it * 1000 }
    }
}
