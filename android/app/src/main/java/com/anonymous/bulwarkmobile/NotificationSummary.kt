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
}
