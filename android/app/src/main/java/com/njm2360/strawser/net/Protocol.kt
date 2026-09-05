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
    // viewportW/Hはdp。サーバーはこの幅でエミュレートするので1 CSS px = 1 dpになる。
    // cacheIdとcacheBytesはタイルキャッシュの世代と容量。再接続で同じidを名乗れば
    // サーバーは送信済みの記憶を持ち越す
    @Serializable
    @SerialName("hello")
    data class Hello(
        val ver: Int = 1,
        val token: String,
        val viewportW: Int,
        val viewportH: Int,
        val dpr: Float,
        val cacheId: String,
        val cacheBytes: Int,
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

    // ローカルスクロール位置通知（300msスロットル、ページ座標）。
    // idは宛先で、pageモードはpageId、vectorモードはlistId。
    // ライブモード中は「実ページをこの位置へスクロールせよ」の意味になり、idは空になる
    @Serializable
    @SerialName("scrollPos")
    data class ScrollPos(val id: String, val y: Int) : ClientMsg

    // IME で確定した文字列をまとめて送る
    @Serializable
    @SerialName("insertText")
    data class InsertText(val text: String) : ClientMsg

    @Serializable
    @SerialName("key")
    data class Key(val key: String) : ClientMsg // "Enter" | "Backspace"

    @Serializable
    @SerialName("setMode")
    data class SetMode(val mode: String) : ClientMsg // "page" | "live" | "vector"

    // ライブフレーム受信確認（これを返すまでサーバーは次フレームを送らない）
    @Serializable
    @SerialName("liveAck")
    data object LiveAck : ClientMsg

    // tileRefで指されたタイルが手元に無かったときの再要求
    @Serializable
    @SerialName("requestTiles")
    data class RequestTiles(val indices: List<Int>) : ClientMsg

    // x/yは押された位置（ページ座標）。サーバーはこれを要素の矩形へ丸め込んで叩く。
    // nodeIdは同じ文書のあいだ変わらないが、遷移をまたぐとlistIdで弾かれる
    @Serializable
    @SerialName("activate")
    data class Activate(
        val listId: String,
        val nodeId: Int,
        val x: Double,
        val y: Double,
    ) : ClientMsg

    // 画面に入った画像の実体要求。要求するまで届かない。
    // rawは手元でバイト列を失ったとき。assetRefで返されても絵は戻らないので実体が届く
    @Serializable
    @SerialName("requestAssets")
    data class RequestAssets(
        val listId: String,
        val nodeIds: List<Int>,
        val raw: Boolean = false,
    ) : ClientMsg

    // vectorDiffの土台が手元に無かったとき。表示リストが丸ごと届く
    @Serializable
    @SerialName("requestList")
    data object RequestList : ClientMsg

    // textはpromptの入力
    @Serializable
    @SerialName("dialogResult")
    data class DialogResult(
        val id: String,
        val accept: Boolean,
        val text: String = "",
    ) : ClientMsg
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

    // 以後このページのタイルが届く。pageWidthが以降の座標の基準。
    // scrollYは表示を始める位置で、戻る・進む・タブ切替では離れたときの位置が返る。
    // hashesは手元にあるはずのタイル（index順、届いていないものはnull）
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
        val scrollY: Int,
        val hashes: List<String?>,
    ) : ServerMsg

    // 直後のバイナリフレームがタイル本体。offsetYはページ座標。
    // hashはバイト列の識別子で、tileRefから参照される
    @Serializable
    @SerialName("tileHeader")
    data class TileHeader(
        val pageId: String,
        val tileIndex: Int,
        val offsetY: Int,
        val format: String,
        val byteLength: Int,
        val hash: String,
    ) : ServerMsg

    // 受信済みのタイルと同じ絵。実体は届かないのでhashで引く。
    // 持っていなければrequestTilesで実体を要求する
    @Serializable
    @SerialName("tileRef")
    data class TileRef(
        val pageId: String,
        val tileIndex: Int,
        val offsetY: Int,
        val hash: String,
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

    // ページ全体の描画コマンド。文字と箱はここで出し切る。
    // 画像は矩形だけ載っていて、実体はrequestAssetsで要求する
    @Serializable
    @SerialName("vectorBegin")
    data class VectorBegin(
        val listId: String,
        val viewKey: String, // 履歴エントリの識別子。これを鍵に表示リストを取っておく
        val url: String,
        val title: String,
        val list: DisplayList,
    ) : ServerMsg

    // viewKeyの表示リストとの差分。colorsとfontsは表の続きだけ届く
    @Serializable
    @SerialName("vectorDiff")
    data class VectorDiff(
        val listId: String,
        val viewKey: String,
        val baseId: String,
        val url: String,
        val title: String,
        val pageWidth: Int,
        val fullHeight: Int,
        val bg: Int = -1,
        val colors: List<String> = emptyList(),
        val fonts: List<List<Float>> = emptyList(),
        val ops: List<OpChunk> = emptyList(),
    ) : ServerMsg

    // 直後のバイナリフレームが画像本体
    @Serializable
    @SerialName("assetHeader")
    data class AssetHeader(
        val listId: String,
        val nodeId: Int,
        val format: String,
        val byteLength: Int,
        val hash: String,
    ) : ServerMsg

    // 受信済みの画像と同じバイト列。tileRefと同じくhashで引く
    @Serializable
    @SerialName("assetRef")
    data class AssetRef(val listId: String, val nodeId: Int, val hash: String) : ServerMsg

    // 答えを返すまでそのタブのJSは止まったまま
    @Serializable
    @SerialName("dialog")
    data class Dialog(
        val id: String,
        val kind: String, // "alert" | "confirm" | "prompt" | "beforeunload"
        val message: String = "",
        val defaultValue: String = "",
    ) : ServerMsg

    @Serializable
    @SerialName("error")
    data class Error(val message: String) : ServerMsg
}

/**
 * 座標はページ座標（CSS px = dp）。文字は折り返し後の1行ずつが実測位置つきで届くので、
 * 端末側で折り返しをやり直さない。
 *
 * colorsは"#rrggbb"または"#rrggbbaa"、fontsは[px, weight, italic, family, letterSpacing, ascent]
 */
@Serializable
data class DisplayList(
    val pageWidth: Int,
    val fullHeight: Int,
    val bg: Int = -1,
    val colors: List<String> = emptyList(),
    val fonts: List<List<Float>> = emptyList(),
    val ops: List<DrawOp> = emptyList(),
)

/**
 * nが正なら土台のopsをa番目からn個、yをdyだけずらして使う。そうでなければoを差し込む。
 * 同じページでも訪れ直すと版面の高さが0.5px以下動くことがあり、その下は全部ずれる
 */
@Serializable
data class OpChunk(
    val a: Int = 0,
    val n: Int = 0,
    val dy: Float = 0f,
    val o: List<DrawOp> = emptyList(),
)

/** tは 0=矩形 1=テキスト行 2=画像 3=当たり判定（描くものは無い。押せる要素と入力欄に置く） */
@Serializable
data class DrawOp(
    val t: Int,
    val b: List<Float>, // x, y, w, h
    val f: Int = -1, // 塗り色
    val k: Int = -1, // 枠線色
    val kw: Float = 0f, // 枠線幅
    val r: List<Float> = emptyList(), // 角丸4隅
    val g: List<Float> = emptyList(), // グラデーション。角度に続いて塗り色と勾配線上の位置の組
    val fo: Int = -1, // フォント
    val co: Int = -1, // 文字色
    val s: String = "", // 文字
    val u: Int = 0, // 装飾のビット。1=下線、2=取り消し線
    val i: Int = -1, // 画像のnodeId
    val a: Int = -1, // 押せる要素のnodeId
    val sh: List<Float> = emptyList(), // 影。dx/dy/ぼかし/色
    val cl: List<Float> = emptyList(), // 切り取り枠。x/y/w/h
    val pn: Float = -1f, // 画面に貼り付くopを下へ運べる距離
)
