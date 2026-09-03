package com.njm2360.strawser

import java.net.URLEncoder

enum class SearchEngine(val label: String, private val queryUrl: String) {
    GOOGLE("Google", "https://www.google.com/search?q="),
    BING("Bing", "https://www.bing.com/search?q="),
    DUCKDUCKGO("DuckDuckGo", "https://duckduckgo.com/?q="),
    YAHOO_JAPAN("Yahoo! JAPAN", "https://search.yahoo.co.jp/search?p="),
    ;

    fun search(query: String): String = queryUrl + URLEncoder.encode(query, "UTF-8")

    companion object {
        val DEFAULT = GOOGLE

        fun of(name: String?): SearchEngine = entries.firstOrNull { it.name == name } ?: DEFAULT
    }
}

private val SCHEME = Regex("^[a-zA-Z][a-zA-Z0-9+.\\-]*://")
private val LOCALHOST = Regex("^localhost(:\\d+)?([/?#].*)?$", RegexOption.IGNORE_CASE)
private val IPV4_HOST = Regex("^\\d{1,3}(\\.\\d{1,3}){3}(:\\d+)?([/?#].*)?$")
private val DOTTED_HOST = Regex("^[^\\s/:?#]+\\.[a-zA-Z]{2,}\\.?(:\\d+)?([/?#].*)?$")

/** 入力をアドレスか検索語に振り分ける。navigateは絶対URLしか受け付けない */
fun resolveInput(input: String, engine: SearchEngine): String {
    val text = input.trim()
    return when {
        SCHEME.containsMatchIn(text) || text.startsWith("about:") -> text
        // ローカル向けはhttpsで待ち受けていないことがほとんど
        LOCALHOST.matches(text) || IPV4_HOST.matches(text) -> "http://$text"
        DOTTED_HOST.matches(text) -> "https://$text"
        else -> engine.search(text)
    }
}
