package com.anonymous.bulwarkmobile.sync

import com.anonymous.bulwarkmobile.sync.DeviceSyncAccounts.EnsureAction
import org.junit.Assert.assertEquals
import org.junit.Test

class DeviceSyncAccountsTest {
    @Test
    fun `ensureAccount creates, keeps, adopts or refuses`() {
        assertEquals(EnsureAction.CREATE, DeviceSyncAccounts.ensureAction(false, null, "alice@example.org@mail"))
        assertEquals(EnsureAction.KEEP, DeviceSyncAccounts.ensureAction(true, "alice@example.org@mail", "alice@example.org@mail"))
        // An account whose setup never wrote a registry id.
        assertEquals(EnsureAction.ADOPT, DeviceSyncAccounts.ensureAction(true, null, "alice@example.org@mail"))
        assertEquals(EnsureAction.ADOPT, DeviceSyncAccounts.ensureAction(true, "", "alice@example.org@mail"))
        // Its rows and SyncState belong to another app account: never rewritten.
        assertEquals(EnsureAction.CONFLICT, DeviceSyncAccounts.ensureAction(true, "alice@example.org@old", "alice@example.org@mail"))
    }

    @Test
    fun `an address book's account is kept for that book only`() {
        val registryId = "alice@example.org@mail"
        assertEquals(EnsureAction.CREATE, DeviceSyncAccounts.ensureAction(false, null, registryId, null, "a/b"))
        assertEquals(EnsureAction.KEEP, DeviceSyncAccounts.ensureAction(true, registryId, registryId, "a/b", "a/b"))
        assertEquals(EnsureAction.ADOPT, DeviceSyncAccounts.ensureAction(true, null, registryId, null, "a/b"))
        // Its rows are another book's, or the app account's own.
        assertEquals(EnsureAction.CONFLICT, DeviceSyncAccounts.ensureAction(true, registryId, registryId, "a/c", "a/b"))
        assertEquals(EnsureAction.CONFLICT, DeviceSyncAccounts.ensureAction(true, registryId, registryId, null, "a/b"))
        assertEquals(EnsureAction.CONFLICT, DeviceSyncAccounts.ensureAction(true, registryId, registryId, "a/b", null))
    }
}
