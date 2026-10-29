package com.anonymous.bulwarkmobile.sync

import android.accounts.AbstractAccountAuthenticator
import android.accounts.Account
import android.accounts.AccountAuthenticatorResponse
import android.accounts.AccountManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.IBinder
import com.anonymous.bulwarkmobile.MainActivity

/**
 * The authenticator of the "Bulwark" account type. The app holds the
 * credentials, not the account: accounts are only ever created by the app,
 * from Settings → Contacts or Calendar, for an account that is signed in.
 */
class BulwarkAuthenticator(private val context: Context) : AbstractAccountAuthenticator(context) {

    /** Settings → Accounts → Add account opens the app's device sync settings instead. */
    override fun addAccount(
        response: AccountAuthenticatorResponse?,
        accountType: String?,
        authTokenType: String?,
        requiredFeatures: Array<out String>?,
        options: Bundle?,
    ): Bundle {
        val intent = Intent(context, MainActivity::class.java)
            .setAction(Intent.ACTION_VIEW)
            .setData(Uri.parse(SETTINGS_URI))
        return Bundle().apply { putParcelable(AccountManager.KEY_INTENT, intent) }
    }

    /** Removal from Android Settings is allowed; the app notices and turns device sync off. */
    override fun getAccountRemovalAllowed(response: AccountAuthenticatorResponse?, account: Account?): Bundle =
        Bundle().apply { putBoolean(AccountManager.KEY_BOOLEAN_RESULT, true) }

    override fun getAuthToken(
        response: AccountAuthenticatorResponse?,
        account: Account?,
        authTokenType: String?,
        options: Bundle?,
    ): Bundle = unsupported()

    override fun confirmCredentials(response: AccountAuthenticatorResponse?, account: Account?, options: Bundle?): Bundle =
        unsupported()

    override fun updateCredentials(
        response: AccountAuthenticatorResponse?,
        account: Account?,
        authTokenType: String?,
        options: Bundle?,
    ): Bundle = unsupported()

    override fun editProperties(response: AccountAuthenticatorResponse?, accountType: String?): Bundle = unsupported()

    override fun getAuthTokenLabel(authTokenType: String?): String? = null

    override fun hasFeatures(response: AccountAuthenticatorResponse?, account: Account?, features: Array<out String>?): Bundle =
        Bundle().apply { putBoolean(AccountManager.KEY_BOOLEAN_RESULT, false) }

    private fun unsupported() = Bundle().apply {
        putInt(AccountManager.KEY_ERROR_CODE, AccountManager.ERROR_CODE_UNSUPPORTED_OPERATION)
        putString(AccountManager.KEY_ERROR_MESSAGE, "Bulwark signs in from the app")
    }

    companion object {
        /** Handled by the app's deep links: Settings → Contacts, with its "Sync to this device" section. */
        const val SETTINGS_URI = "bulwarkmobile://settings/contacts"
    }
}

class BulwarkAuthenticatorService : Service() {
    private val authenticator by lazy { BulwarkAuthenticator(this) }

    override fun onBind(intent: Intent): IBinder? = authenticator.iBinder
}
