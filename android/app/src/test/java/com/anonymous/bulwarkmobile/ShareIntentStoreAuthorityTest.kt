package com.anonymous.bulwarkmobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// The provider of a shared address, read as Android reads it: Uri.parse ends
// the authority at a backslash as well as at '/', '?' and '#'
// (Uri.StringUri.parseAuthority), so the provider that answers
// "content://<own>\@other/..." is <own>. The same cases as
// src/lib/__tests__/share-intent-authority.test.ts.
class ShareIntentStoreAuthorityTest {
    private val pkg = "com.anonymous.bulwarkmobile"
    private val playPkg = "org.bulwarkmail.mobile"

    @Test
    fun `refuses an own provider followed by a backslash, which Android reads as the end of the authority`() {
        for (p in listOf(pkg, playPkg)) {
            assertFalse(ShareIntentStore.isForeignContentUri("content://$p.FileSystemFileProvider\\@evil.example/expo_files/x"))
            assertFalse(ShareIntentStore.isForeignContentUri("content://$p.SharingFileProvider\\cached_expo_files@evil.example/x"))
            assertFalse(ShareIntentStore.isForeignContentUri("content://$p.rnwidget.imageprovider\\@evil.example/x.png"))
        }
    }

    @Test
    fun `agrees with Android where the spellings resolve the same way`() {
        // Android takes what follows the last '@' as the provider.
        assertTrue(ShareIntentStore.isForeignContentUri("content://$pkg.FileSystemFileProvider@evil.example/x"))
        // An encoded backslash is no delimiter for Android: the provider is what follows the '@'.
        assertTrue(ShareIntentStore.isForeignContentUri("content://$pkg.FileSystemFileProvider%5C@evil.example/x"))
        assertFalse(ShareIntentStore.isForeignContentUri("content://x@$pkg.FileSystemFileProvider/expo_files/x"))
        assertFalse(ShareIntentStore.isForeignContentUri("content://evil:1@$pkg.FileSystemFileProvider/expo_files/x"))
        assertFalse(ShareIntentStore.isForeignContentUri("content://0%40$pkg.FileSystemFileProvider/expo_files/x"))
        assertFalse(ShareIntentStore.isForeignContentUri("content:// $pkg.FileSystemFileProvider/expo_files/x"))
        assertFalse(ShareIntentStore.isForeignContentUri("content://$pkg.FileSystemFileProvider./expo_files/x"))
        assertFalse(ShareIntentStore.isForeignContentUri("content://0@/x"))
    }

    @Test
    fun `keeps a list lined up when one of several is refused`() {
        val uris = listOf(
            "content://media/external/images/media/1",
            "content://$pkg.FileSystemFileProvider\\@evil.example/expo_files/x",
            "content://com.android.providers.downloads.documents/document/42",
        )
        assertEquals(listOf(uris[0], uris[2]), uris.filter { ShareIntentStore.isForeignContentUri(it) })
    }
}
