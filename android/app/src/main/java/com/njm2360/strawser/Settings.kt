package com.njm2360.strawser

import android.content.Context
import android.content.SharedPreferences
import java.net.URLEncoder

data class Settings(
    val serverUrl: String,
    val token: String,
    val searchEngine: SearchEngine = SearchEngine.DEFAULT,
    val tileCacheMb: Int = DEFAULT_TILE_CACHE_MB,
) {
    // サーバーはトークン必須なので、空のまま接続しても弾かれる
    val isConfigured: Boolean get() = serverUrl.isNotBlank() && token.isNotBlank()

    val tileCacheBytes: Int get() = tileCacheMb * 1024 * 1024

    fun connectUrl(): String =
        serverUrl.trimEnd('/') + "/?token=" + URLEncoder.encode(token, "UTF-8")

    fun save(prefs: SharedPreferences) {
        prefs.edit()
            .putString(KEY_SERVER_URL, serverUrl)
            .putString(KEY_TOKEN, token)
            .putString(KEY_SEARCH_ENGINE, searchEngine.name)
            .putInt(KEY_TILE_CACHE_MB, tileCacheMb)
            .apply()
    }

    companion object {
        const val DEFAULT_SERVER_URL = "ws://192.168.1.100:8080"

        // 溜めるほど戻る・進むが実体の再送なしで済む。サーバーもこの容量で手元を推定する
        const val DEFAULT_TILE_CACHE_MB = 16
        val TILE_CACHE_CHOICES = listOf(8, 16, 32, 64, 128)

        private const val PREFS_NAME = "settings"
        private const val KEY_SERVER_URL = "serverUrl"
        private const val KEY_TOKEN = "token"
        private const val KEY_SEARCH_ENGINE = "searchEngine"
        private const val KEY_TILE_CACHE_MB = "tileCacheMb"

        fun prefs(context: Context): SharedPreferences =
            context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

        fun load(prefs: SharedPreferences) = Settings(
            serverUrl = prefs.getString(KEY_SERVER_URL, "")?.trim().orEmpty(),
            token = prefs.getString(KEY_TOKEN, "")?.trim().orEmpty(),
            searchEngine = SearchEngine.of(prefs.getString(KEY_SEARCH_ENGINE, null)),
            tileCacheMb = prefs.getInt(KEY_TILE_CACHE_MB, DEFAULT_TILE_CACHE_MB),
        )
    }
}
