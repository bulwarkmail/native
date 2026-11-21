package com.anonymous.bulwarkmobile.sync

import android.accounts.Account
import android.accounts.AccountManager
import android.content.ContentResolver
import android.content.Context
import android.os.Bundle
import android.provider.CalendarContract
import android.provider.ContactsContract
import com.anonymous.bulwarkmobile.R

/**
 * The Android accounts of device sync (#34) and their sync settings. One
 * account per app account that has device sync on, plus one per synced
 * address book when the app account shows each book as a contact source of
 * its own (#155); see docs/device-sync.md.
 *
 * Android's own sync settings are the source of truth for on/off: the
 * Contacts and Calendar toggles in Settings → Accounts are
 * `getSyncAutomatically`, and the app reads them back instead of keeping a
 * copy.
 */
object DeviceSyncAccounts {
    const val CONTACTS_AUTHORITY: String = ContactsContract.AUTHORITY
    const val CALENDAR_AUTHORITY: String = CalendarContract.AUTHORITY
    val AUTHORITIES = listOf(CONTACTS_AUTHORITY, CALENDAR_AUTHORITY)

    /** userData key holding the app account (`AccountEntry.id`) an Android account belongs to. */
    const val USER_DATA_REGISTRY_ID = "registryId"

    /**
     * userData key of an address book's account: the book it holds, as
     * `<jmapAccountId>/<addressBookId>`. The app account's own account has none.
     */
    const val USER_DATA_COLLECTION = "collection"

    /** `<applicationId>.account`, set in build.gradle so the package name is never hard-coded. */
    fun accountType(context: Context): String = context.getString(R.string.device_sync_account_type)

    fun account(context: Context, name: String) = Account(name, accountType(context))

    /** An account of ours with the app account and, for an address book's account, the book it belongs to. */
    data class Entry(val account: Account, val registryId: String?, val collection: String?)

    fun list(context: Context): List<Entry> {
        val manager = AccountManager.get(context)
        return manager.getAccountsByType(accountType(context)).map {
            Entry(it, manager.getUserData(it, USER_DATA_REGISTRY_ID), manager.getUserData(it, USER_DATA_COLLECTION))
        }
    }

    fun exists(context: Context, name: String): Boolean =
        AccountManager.get(context).getAccountsByType(accountType(context)).any { it.name == name }

    /**
     * Adds the account when it is missing. Both authorities start syncable
     * with automatic sync off; the app turns on the ones the user picked.
     * An address book's account ([collection] set) syncs contacts only and
     * starts with that on: it follows the app account's own switch, and one
     * left off by a failed second step would look switched off by the user.
     * Returns true when the account was created, false when it exists for
     * [registryId] and [collection] already. An account that belongs to
     * another registry id or address book keeps it
     * ([AccountConflictException]): its rows and SyncState were written for
     * that one.
     */
    fun ensure(context: Context, name: String, registryId: String, collection: String? = null): Boolean {
        val manager = AccountManager.get(context)
        val account = account(context, name)
        val exists = manager.getAccountsByType(account.type).any { it.name == name }
        val current = if (exists) manager.getUserData(account, USER_DATA_REGISTRY_ID) else null
        val currentCollection = if (exists) manager.getUserData(account, USER_DATA_COLLECTION) else null
        when (ensureAction(exists, current, registryId, currentCollection, collection)) {
            EnsureAction.KEEP -> return false
            EnsureAction.ADOPT -> {
                manager.setUserData(account, USER_DATA_REGISTRY_ID, registryId)
                manager.setUserData(account, USER_DATA_COLLECTION, collection)
                return false
            }
            EnsureAction.CONFLICT -> throw AccountConflictException(
                "The Android account $name belongs to another app account or address book ($current)",
            )
            EnsureAction.CREATE -> Unit
        }
        val userData = Bundle().apply {
            putString(USER_DATA_REGISTRY_ID, registryId)
            if (collection != null) putString(USER_DATA_COLLECTION, collection)
        }
        check(manager.addAccountExplicitly(account, null, userData)) { "Android refused to add the account" }
        for (authority in AUTHORITIES) {
            val syncable = collection == null || authority == CONTACTS_AUTHORITY
            ContentResolver.setIsSyncable(account, authority, if (syncable) 1 else 0)
            ContentResolver.setSyncAutomatically(account, authority, collection != null && syncable)
        }
        return true
    }

    enum class EnsureAction { CREATE, KEEP, ADOPT, CONFLICT }

    /**
     * An existing account without a registry id (never completed) is adopted;
     * one with another id, or of another address book, is not touched.
     */
    fun ensureAction(
        exists: Boolean,
        currentRegistryId: String?,
        registryId: String,
        currentCollection: String? = null,
        collection: String? = null,
    ): EnsureAction = when {
        !exists -> EnsureAction.CREATE
        currentRegistryId.isNullOrEmpty() -> EnsureAction.ADOPT
        currentRegistryId == registryId && currentCollection.orEmpty() == collection.orEmpty() -> EnsureAction.KEEP
        else -> EnsureAction.CONFLICT
    }

    /** Removes the account; the Contacts and Calendar providers drop all of its rows. */
    fun remove(context: Context, name: String): Boolean {
        val manager = AccountManager.get(context)
        val account = account(context, name)
        if (manager.getAccountsByType(account.type).none { it.name == name }) return false
        return manager.removeAccountExplicitly(account)
    }

    fun setSyncEnabled(context: Context, name: String, authority: String, enabled: Boolean) {
        requireAuthority(authority)
        val account = account(context, name)
        ContentResolver.setIsSyncable(account, authority, 1)
        ContentResolver.setSyncAutomatically(account, authority, enabled)
    }

    /** Replaces our periodic sync for the authority; 0 removes it. */
    fun setPeriodicSync(context: Context, name: String, authority: String, seconds: Long) {
        requireAuthority(authority)
        val account = account(context, name)
        for (periodic in ContentResolver.getPeriodicSyncs(account, authority)) {
            ContentResolver.removePeriodicSync(account, authority, periodic.extras)
        }
        if (seconds > 0) ContentResolver.addPeriodicSync(account, authority, Bundle.EMPTY, seconds)
    }

    /**
     * Requests a sync. SyncManager drops a request that matches a sync it is
     * running, so a run of that account and authority is also flagged to
     * ask for another sync when it ends (see [DeviceSyncRuns.flagSyncAgain]).
     */
    fun requestSync(context: Context, name: String, authority: String, flags: SyncRequestFlags) {
        requireAuthority(authority)
        DeviceSyncRuns.flagSyncAgain(name, authority)
        ContentResolver.requestSync(account(context, name), authority, flags.toExtras())
    }

    fun requireAuthority(authority: String) {
        require(authority in AUTHORITIES) { "Unknown authority $authority" }
    }
}

/** [DeviceSyncAccounts.ensure] refused to hand an account of one app account to another. */
class AccountConflictException(message: String) : Exception(message)

/** The SYNC_EXTRAS_* flags a request carries. Constant extras let repeated requests coalesce. */
data class SyncRequestFlags(
    val manual: Boolean = false,
    val expedited: Boolean = false,
    val upload: Boolean = false,
    val overrideTooManyDeletions: Boolean = false,
    val discardLocalDeletions: Boolean = false,
) {
    fun toExtras(): Bundle = Bundle().apply {
        if (manual) putBoolean(ContentResolver.SYNC_EXTRAS_MANUAL, true)
        if (expedited) putBoolean(ContentResolver.SYNC_EXTRAS_EXPEDITED, true)
        if (upload) putBoolean(ContentResolver.SYNC_EXTRAS_UPLOAD, true)
        if (overrideTooManyDeletions) putBoolean(ContentResolver.SYNC_EXTRAS_OVERRIDE_TOO_MANY_DELETIONS, true)
        if (discardLocalDeletions) putBoolean(ContentResolver.SYNC_EXTRAS_DISCARD_LOCAL_DELETIONS, true)
    }
}
