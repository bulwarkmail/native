package com.anonymous.bulwarkmobile.sync

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Base64
import android.util.Log
import java.io.File
import kotlin.concurrent.thread

/**
 * Debug builds only: lets adb set up device sync accounts and drive the
 * provider bridge without the settings UI or JS, for the device tests in
 * docs/device-sync.md ("Testing"). Protected by android.permission.DUMP,
 * which only the shell and the system hold. Syncs themselves are triggered
 * with `adb shell requestsync`.
 *
 *     adb shell am broadcast -n com.anonymous.bulwarkmobile/.sync.DeviceSyncDebugReceiver \
 *       --es cmd ensure --es name usera@example.org --es registry usera@example.org@10.0.2.2 \
 *       --es enable contacts,calendar
 *
 * Commands: `ensure` (name, registry, optional enable), `enable` (name,
 * authority, optional --ez on false), `remove` (name), `list`, and the
 * provider calls `query` and `batch` (name, authority, and the
 * `ProviderQuery`/`ProviderOp[]` JSON base64-encoded in `b64`, which spares
 * the shell's quoting, or pushed to the app's external files directory and
 * named by `file` when it is too long for a command line), `syncstate`
 * (name, authority) and `photo` (name, `--el id`, optional `--ei max`); and
 * the sync-problem notification, `problem` (name, title, text, uri, optional
 * channel) and `clearproblem` (name). Results go to logcat (tag
 * BulwarkDeviceSync) and the broadcast's result data.
 */
class DeviceSyncDebugReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val pending = goAsync()
        // Provider calls block; keep them off the main thread.
        thread(name = "DeviceSyncDebugReceiver") {
            val result = try {
                run(context, intent)
            } catch (e: Exception) {
                "error: ${e.javaClass.simpleName}: ${e.message}"
            }
            Log.i(TAG, "debug command: $result")
            pending.resultData = result
            pending.finish()
        }
    }

    private fun run(context: Context, intent: Intent): String {
        val name = intent.getStringExtra("name")
        return when (intent.getStringExtra("cmd")) {
            "ensure" -> {
                val created = DeviceSyncAccounts.ensure(context, name!!, intent.getStringExtra("registry")!!)
                for (which in intent.getStringExtra("enable").orEmpty().split(',').filter { it.isNotBlank() }) {
                    DeviceSyncAccounts.setSyncEnabled(context, name, authority(which), true)
                }
                "created=$created"
            }
            "enable" -> {
                val on = intent.getBooleanExtra("on", true)
                DeviceSyncAccounts.setSyncEnabled(context, name!!, authority(intent.getStringExtra("authority")!!), on)
                "enabled=$on"
            }
            "remove" -> "removed=${DeviceSyncAccounts.remove(context, name!!)}"
            "list" -> DeviceSyncAccounts.list(context).joinToString(";") { (account, registryId) -> "${account.name}=$registryId" }
            "query" -> io(context, intent) { it.query(json(context, intent)) }
            "batch" -> io(context, intent) { it.applyBatch(json(context, intent)) }
            "syncstate" -> io(context, intent) { it.readSyncState().toString() }
            "photo" -> ProviderIo(context, name!!, DeviceSyncAccounts.CONTACTS_AUTHORITY).use {
                it.readPhoto(intent.getLongExtra("id", -1), intent.getIntExtra("max", 512)).toString()
            }
            "problem" -> {
                SyncProblemNotifier.show(
                    context,
                    name!!,
                    intent.getStringExtra("title").orEmpty(),
                    intent.getStringExtra("text").orEmpty(),
                    intent.getStringExtra("uri").orEmpty(),
                    intent.getStringExtra("channel"),
                )
                "shown"
            }
            "clearproblem" -> {
                SyncProblemNotifier.clear(context, name!!)
                "cleared"
            }
            else -> "unknown cmd"
        }
    }

    private fun io(context: Context, intent: Intent, call: (ProviderIo) -> String): String =
        ProviderIo(context, intent.getStringExtra("name")!!, authority(intent.getStringExtra("authority")!!)).use(call)

    private fun json(context: Context, intent: Intent): String {
        intent.getStringExtra("file")?.let { return File(context.getExternalFilesDir(null), it).readText() }
        return String(Base64.decode(intent.getStringExtra("b64")!!, Base64.DEFAULT), Charsets.UTF_8)
    }

    private fun authority(which: String) = when (which) {
        "contacts" -> DeviceSyncAccounts.CONTACTS_AUTHORITY
        "calendar" -> DeviceSyncAccounts.CALENDAR_AUTHORITY
        else -> which
    }

    companion object {
        private const val TAG = "BulwarkDeviceSync"
    }
}
