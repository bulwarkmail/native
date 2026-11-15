package com.anonymous.bulwarkmobile

import java.util.concurrent.ConcurrentHashMap

/**
 * Where an account's ring of notified message ids is kept
 * (`push:notifiedIds:v1:<accountId>`, newest first).
 */
internal interface NotifiedIdsStore {
    fun read(accountId: String): List<String>
    fun write(accountId: String, ring: List<String>)
    fun remove(accountId: String)
}

/**
 * Posts a message notification at most once per account, whichever runtime
 * and thread handles the push: the native lookup and the push task (through
 * BulwarkFcmModule) both post through here. Reading the ring, posting and
 * writing the ids posted happen under one lock per account, so two pushes
 * that bring the same new mail cannot both find it missing. An id is written
 * only after its notification was posted; a post that throws records nothing,
 * and a later push can still show it. Another account's posts do not wait.
 */
internal class NotifiedOnce {
    private val locks = ConcurrentHashMap<String, Any>()

    private fun lockFor(accountId: String): Any = locks.computeIfAbsent(accountId) { Any() }

    /**
     * Runs [post] unless every one of [ids] is in the account's ring, then
     * puts them at its front. Returns whether it posted.
     */
    fun post(store: NotifiedIdsStore, accountId: String, ids: List<String>, post: () -> Unit): Boolean =
        synchronized(lockFor(accountId)) {
            val ring = store.read(accountId)
            if (ring.containsAll(ids)) return false
            post()
            store.write(accountId, BulwarkNativePushFetcher.mergeNotifiedIds(ring, ids))
            true
        }

    /** Forgets the account's ring, after any post already reading it has written. */
    fun forget(store: NotifiedIdsStore, accountId: String) {
        synchronized(lockFor(accountId)) { store.remove(accountId) }
    }
}
