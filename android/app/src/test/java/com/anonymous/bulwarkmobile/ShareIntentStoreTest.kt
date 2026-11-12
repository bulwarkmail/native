package com.anonymous.bulwarkmobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// The same cases as src/lib/__tests__/share-intent-private-files.test.ts: a
// file shared into the app is accepted only from another app's provider.
class ShareIntentStoreTest {
    private val pkg = "com.anonymous.bulwarkmobile"
    private val playPkg = "org.bulwarkmail.mobile"

    private fun accepted(uris: List<String>) = uris.filter { ShareIntentStore.isForeignContentUri(it) }

    @Test
    fun `drops file URIs, which reach the app-private data directory`() {
        assertEquals(emptyList<String>(), accepted(listOf(
            "file:///data/user/0/$pkg/databases/RKStorage",
            "file:///data/data/$pkg/shared_prefs/SecureStore.xml",
            "file:///data/user/0/$pkg/files/offline-attachments/a/invoice.pdf",
            "FILE:///data/user/0/$pkg/databases/RKStorage",
            "file:/data/user/0/$pkg/databases/RKStorage",
            "file://localhost/data/user/0/$pkg/databases/RKStorage",
            "file:///sdcard/Download/report.pdf",
        )))
    }

    @Test
    fun `drops content URIs of the app's own providers, in both flavours and every spelling`() {
        val own = mutableListOf<String>()
        for (p in listOf(pkg, playPkg)) {
            for (provider in listOf("FileSystemFileProvider", "SharingFileProvider", "ImagePickerFileProvider", "ClipboardFileProvider")) {
                own.add("content://$p.$provider/expo_files/offline-attachments/a/invoice.pdf")
            }
            own.add("CONTENT://$p.FileSystemFileProvider/expo_files/x")
            own.add("content://${p.uppercase()}.FileSystemFileProvider/expo_files/x")
            own.add("content://0@$p.FileSystemFileProvider/expo_files/x")
            own.add("content://10@$p.SharingFileProvider/cached_expo_files/x.eml")
            own.add("content://$p.SomeNewProvider/x")
            own.add("content://$p/x")
            // Android decodes the authority before it looks the provider up.
            own.add("content://${p.replace(".", "%2E")}.FileSystemFileProvider/expo_files/x")
            own.add("content://$p.FileSystemFileProvider:80/expo_files/x")
        }
        assertEquals(emptyList<String>(), accepted(own))
    }

    @Test
    fun `drops every scheme that is not content`() {
        assertEquals(emptyList<String>(), accepted(listOf(
            "android.resource://$pkg/raw/secret",
            "http://example.org/a.pdf",
            "https://example.org/a.pdf",
            "data:text/plain;base64,QQ==",
            "javascript:alert(1)",
            "/data/user/0/$pkg/databases/RKStorage",
            "",
            "content:$pkg.FileSystemFileProvider/x",
            "content:///x",
            "content://%zz/x",
        )))
    }

    @Test
    fun `keeps what another app shares`() {
        val foreign = listOf(
            "content://media/external/images/media/1000000027",
            "content://com.android.providers.downloads.documents/document/42",
            "content://com.other.app.FileSystemFileProvider/expo_files/shared.pdf",
            "content://0@com.google.android.apps.photos.contentprovider/1/2/x",
            "content://com.anonymous.bulwarkmobilex.files/x",
        )
        assertEquals(foreign, accepted(foreign))
        assertTrue(ShareIntentStore.isForeignContentUri("content://media/external/images/media/1"))
        assertFalse(ShareIntentStore.isForeignContentUri("file:///data/user/0/$pkg/databases/RKStorage"))
    }
}
