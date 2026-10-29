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
}
