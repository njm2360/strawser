package com.njm2360.strawser

import android.content.Context
import android.content.SharedPreferences
import java.net.URLEncoder

data class Settings(
    val serverUrl: String,
    val token: String,
    val searchEngine: SearchEngine = SearchEngine.DEFAULT,
) {
    // サーバーはトークン必須なので、空のまま接続しても弾かれる
    val isConfigured: Boolean get() = serverUrl.isNotBlank() && token.isNotBlank()

    fun connectUrl(): String =
        serverUrl.trimEnd('/') + "/?token=" + URLEncoder.encode(token, "UTF-8")

    fun save(prefs: SharedPreferences) {
        prefs.edit()
            .putString(KEY_SERVER_URL, serverUrl)
            .putString(KEY_TOKEN, token)
            .putString(KEY_SEARCH_ENGINE, searchEngine.name)
            .apply()
    }

    companion object {
        const val DEFAULT_SERVER_URL = "ws://192.168.1.100:8080"

        private const val PREFS_NAME = "settings"
        private const val KEY_SERVER_URL = "serverUrl"
        private const val KEY_TOKEN = "token"
        private const val KEY_SEARCH_ENGINE = "searchEngine"

        fun prefs(context: Context): SharedPreferences =
            context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

        fun load(prefs: SharedPreferences) = Settings(
            serverUrl = prefs.getString(KEY_SERVER_URL, "")?.trim().orEmpty(),
            token = prefs.getString(KEY_TOKEN, "")?.trim().orEmpty(),
            searchEngine = SearchEngine.of(prefs.getString(KEY_SEARCH_ENGINE, null)),
        )
    }
}
