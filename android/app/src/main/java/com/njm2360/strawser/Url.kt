package com.njm2360.strawser

import java.net.URLDecoder

// server/src/browser.tsのNEW_TAB_URLと合わせる
private const val NEW_TAB_URL = "about:blank"

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

fun isBlankUrl(url: String): Boolean = url.isBlank() || url == NEW_TAB_URL

fun decodeUrlForDisplay(url: String): String = try {
    // URLDecoderは+を空白にするので一旦退避する
    URLDecoder.decode(url.replace("+", "%2B"), "UTF-8")
} catch (_: Exception) {
    url
}
