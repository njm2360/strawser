package com.njm2360.strawser.net

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

// /protocol/messages.ts の転記。変更時は両方を更新すること。
// 座標系はサーバー側エミュレーション幅（=こちらの表示幅dp）が基準。
// 基準値はpageBegin/liveFrameHeaderのpageWidthで毎回渡される。

val protocolJson = Json {
    classDiscriminator = "type"
    ignoreUnknownKeys = true
    encodeDefaults = true
}

// ---- クライアント → サーバー ----
@Serializable
sealed interface ClientMsg {
    // viewportW/Hはdp。サーバーはこの幅でエミュレートするので1 CSS px = 1 dpになる
    @Serializable
    @SerialName("hello")
    data class Hello(
        val ver: Int = 1,
        val token: String,
        val viewportW: Int,
        val viewportH: Int,
        val dpr: Float,
    ) : ClientMsg

    // 画面回転などで表示領域が変わったとき
    @Serializable
    @SerialName("viewport")
    data class Viewport(
        val width: Int,
        val height: Int,
        val dpr: Float,
    ) : ClientMsg

    @Serializable
    @SerialName("navigate")
    data class Navigate(val url: String) : ClientMsg

    @Serializable
    @SerialName("back")
    data object Back : ClientMsg

    @Serializable
    @SerialName("forward")
    data object Forward : ClientMsg

    @Serializable
    @SerialName("reload")
    data object Reload : ClientMsg

    @Serializable
    @SerialName("newTab")
    data class NewTab(val url: String? = null) : ClientMsg

    @Serializable
    @SerialName("closeTab")
    data class CloseTab(val tabId: String) : ClientMsg

    @Serializable
    @SerialName("selectTab")
    data class SelectTab(val tabId: String) : ClientMsg

    @Serializable
    @SerialName("tap")
    data class Tap(val x: Double, val y: Double) : ClientMsg

    @Serializable
    @SerialName("longPress")
    data class LongPress(val x: Double, val y: Double) : ClientMsg

    // ローカルスクロール位置通知（300ms スロットル、ページ座標）。
    // ライブモード中は「実ページをこの位置へスクロールせよ」の意味になる
    @Serializable
    @SerialName("scrollPos")
    data class ScrollPos(val y: Int) : ClientMsg

    // IME で確定した文字列をまとめて送る
    @Serializable
    @SerialName("insertText")
    data class InsertText(val text: String) : ClientMsg

    @Serializable
    @SerialName("key")
    data class Key(val key: String) : ClientMsg // "Enter" | "Backspace"

    @Serializable
    @SerialName("setMode")
    data class SetMode(val mode: String) : ClientMsg // "page" | "live"

    // ライブフレーム受信確認（これを返すまでサーバーは次フレームを送らない）
    @Serializable
    @SerialName("liveAck")
    data object LiveAck : ClientMsg

    @Serializable
    @SerialName("requestTiles")
    data class RequestTiles(val indices: List<Int>) : ClientMsg
}

// ---- サーバー → クライアント ----
@Serializable
sealed interface ServerMsg {
    @Serializable
    @SerialName("helloAck")
    data class HelloAck(val ver: Int, val sessionId: String) : ServerMsg

    // 直後のバイナリフレームが画像本体。width/height はページ座標（720px 基準）
    @Serializable
    @SerialName("screenshotHeader")
    data class ScreenshotHeader(
        val format: String,
        val width: Int,
        val height: Int,
        val byteLength: Int,
    ) : ServerMsg

    // 以後このページのタイルが届く。pageWidthが以降の座標の基準
    @Serializable
    @SerialName("pageBegin")
    data class PageBegin(
        val pageId: String,
        val url: String,
        val title: String,
        val pageWidth: Int,
        val fullHeight: Int,
        val tileHeight: Int,
        val tileCount: Int,
    ) : ServerMsg

    // 直後のバイナリフレームがタイル本体。offsetY はページ座標
    @Serializable
    @SerialName("tileHeader")
    data class TileHeader(
        val pageId: String,
        val tileIndex: Int,
        val offsetY: Int,
        val format: String,
        val byteLength: Int,
    ) : ServerMsg

    // ページ末尾への継ぎ足し（無限スクロール・長大ページ対応）
    @Serializable
    @SerialName("pageExtend")
    data class PageExtend(
        val pageId: String,
        val newFullHeight: Int,
        val addedTiles: Int,
    ) : ServerMsg

    @Serializable
    @SerialName("navState")
    data class NavState(
        val canGoBack: Boolean,
        val canGoForward: Boolean,
        val url: String,
        val loading: Boolean,
    ) : ServerMsg

    // 直後のバイナリフレームがライブモードの JPEG フレーム。
    // scrollY はフレーム時点の実ページのスクロール位置（ページ座標）
    @Serializable
    @SerialName("liveFrameHeader")
    data class LiveFrameHeader(
        val format: String,
        val byteLength: Int,
        val scrollY: Int,
        val pageWidth: Int,
    ) : ServerMsg

    @Serializable
    data class TabInfo(val id: String, val title: String, val url: String)

    // タブの増減・表示中タブ・タイトル更新のたびに一覧ごと届く
    @Serializable
    @SerialName("tabs")
    data class Tabs(val tabs: List<TabInfo>, val activeId: String) : ServerMsg

    @Serializable
    @SerialName("focus")
    data class Focus(val kind: String) : ServerMsg

    @Serializable
    @SerialName("error")
    data class Error(val message: String) : ServerMsg
}
