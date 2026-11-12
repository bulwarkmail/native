package com.anonymous.bulwarkmobile

/**
 * The lines of an account's group summary (BulwarkFcmModule.postGroupSummary):
 * title and text of the newest notifications in the group, at most
 * [MAX_LINES]. None while the login's organisation wants notifications that
 * say only that there is new mail: the group the summary is built from can
 * still hold message notifications the app has just taken out.
 */
object NotificationSummary {
    const val MAX_LINES = 5

    /** [newestFirst]: each notification's title and text, newest first. */
    fun lines(newestFirst: List<Pair<CharSequence?, CharSequence?>>, withoutContent: Boolean): List<String> {
        if (withoutContent) return emptyList()
        return newestFirst.take(MAX_LINES).mapNotNull { (title, text) ->
            listOfNotNull(title, text).joinToString("  ").takeIf { it.isNotBlank() }
        }
    }

    /**
     * Whether the summary is posted for a group of [children] notifications
     * (at least one). From [minChildren] on it is. Below that a summary is
     * left alone, because cancelling it takes its last notification with it.
     * Under the rule ([withoutContent]) one that is showing is posted again,
     * without lines: the app has just taken the account's message
     * notifications out, and left alone it would keep their lines and count.
     * No summary is made over a single notification.
     */
    fun posts(children: Int, minChildren: Int, withoutContent: Boolean, summaryShowing: Boolean): Boolean =
        children >= minChildren || (withoutContent && summaryShowing)

    /**
     * "N new messages", or nothing under the rule: there one notification
     * stands for all new mail of the account, so the number of notifications
     * is not the number of messages.
     */
    fun countText(count: Int, withoutContent: Boolean): String? = when {
        withoutContent -> null
        count == 1 -> "1 new message"
        else -> "$count new messages"
    }
}
