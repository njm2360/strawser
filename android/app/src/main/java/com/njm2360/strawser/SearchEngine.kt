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
