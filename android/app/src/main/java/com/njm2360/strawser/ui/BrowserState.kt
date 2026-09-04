package com.njm2360.strawser.ui

import android.graphics.BitmapFactory
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import com.njm2360.strawser.decodeUrlForDisplay
import com.njm2360.strawser.net.ClientMsg
import com.njm2360.strawser.net.ServerMsg
import com.njm2360.strawser.net.TileStore
import com.njm2360.strawser.net.WsClient

/**
 * 1ページ分のタイル群。hashesは届いた分だけ埋まる。pageExtendで末尾に伸びる。
 * 絵の実体はTileStoreがhashで持っているので、ここが抱えるのは索引だけ
 */
internal class RemotePage(
    val pageId: String,
    val pageWidth: Int,
    val tileHeight: Int,
    val scrollY: Int,
    fullHeight: Int,
    tileCount: Int,
) {
    var fullHeight by mutableStateOf(fullHeight)
    var tileCount by mutableStateOf(tileCount)
    val hashes = mutableStateMapOf<Int, String>()
}

// 1つあたり1〜2MB。サーバーも同じ鍵・同じ上限・同じ捨て方で持つ
private const val VECTOR_CACHE_LIMIT = 6

/** 各プロパティはWsClientの受信スレッドから書き換わる */
internal class BrowserState(
    serverUrl: String,
    tileCacheBytes: Int,
    private val viewport: () -> ClientMsg.Viewport,
    onAuthError: () -> Unit,
) {
    // 接続を張り直してもタイルは持ち越す
    val tiles = TileStore(tileCacheBytes)

    // 履歴エントリ単位の表示リスト。戻る・進む・タブ切替はこれを土台に差分で届く。挿入順がLRU
    private val vectors = LinkedHashMap<String, VectorPage>()

    var page by mutableStateOf<RemotePage?>(null)
        private set
    var navState by mutableStateOf<ServerMsg.NavState?>(null)
        private set
    var connected by mutableStateOf(false)
        private set
    var errorText by mutableStateOf<String?>(null)
        private set
    var tabs by mutableStateOf<List<ServerMsg.TabInfo>>(emptyList())
        private set
    var activeTabId by mutableStateOf("")
        private set
    // "page" | "live" | "vector"
    var mode by mutableStateOf("page")
        private set
    var vector by mutableStateOf<VectorPage?>(null)
        private set
    var liveFrame by mutableStateOf<ImageBitmap?>(null)
        private set
    var liveScrollY by mutableStateOf(0)
        private set
    var liveWidth by mutableStateOf(0)
        private set
    var showInput by mutableStateOf(false)
        private set

    // navStateが届くたびに上書きされる。編集中でも同じなので、入力とページ遷移が競ると打ち消される
    var urlInput by mutableStateOf("")

    private val client = WsClient(
        serverUrl = serverUrl,
        tiles = tiles,
        viewport = viewport,
        onMessage = ::receive,
        onTile = { pageId, tileIndex, hash ->
            val target = page ?: return@WsClient
            if (target.pageId == pageId) target.hashes[tileIndex] = hash
        },
        onAsset = { listId, nodeId, hash ->
            val target = vector ?: return@WsClient
            if (target.listId == listId) target.assets[nodeId] = hash
        },
        onLiveFrame = { header, bytes ->
            val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
            if (bmp != null) {
                liveFrame = bmp.asImageBitmap()
                liveScrollY = header.scrollY
                liveWidth = header.pageWidth
            }
        },
        onConnectionChange = { online ->
            connected = online
            // 切断でリモート側のモードと入力フォーカスは失われる
            if (!online) {
                mode = "page"
                showInput = false
            }
        },
        onAuthError = onAuthError,
        onSuperseded = { errorText = "別の接続に切り替わりました。メニューの接続設定から繋ぎ直してください" },
    )

    private fun receive(msg: ServerMsg) {
        when (msg) {
            is ServerMsg.PageBegin -> {
                page = RemotePage(
                    pageId = msg.pageId,
                    pageWidth = msg.pageWidth,
                    tileHeight = msg.tileHeight,
                    scrollY = msg.scrollY,
                    fullHeight = msg.fullHeight,
                    tileCount = msg.tileCount,
                ).also { restored ->
                    // 手元にあるタイルはそのまま出す（戻る・進む・タブ切替）
                    msg.hashes.forEachIndexed { index, hash ->
                        if (hash != null) restored.hashes[index] = hash
                    }
                }
            }
            is ServerMsg.VectorBegin -> {
                val prev = vectors[msg.viewKey] ?: vector
                val next = VectorPage(msg.listId, msg.viewKey, msg.url, msg.list)
                // 同じページの撮り直しでは読んでいた位置を保つ。
                // 折り返しが変わるので全体に対する割合で合わせる
                val height = prev?.list?.fullHeight ?: 0
                if (prev != null && height > 0 && prev.documentUrl == next.documentUrl) {
                    next.scrollY = prev.scrollY * msg.list.fullHeight / height
                }
                vector = next
                cacheVector(next)
            }
            is ServerMsg.VectorDiff -> {
                val patched = vectors[msg.viewKey]?.takeIf { it.listId == msg.baseId }?.patch(msg)
                if (patched == null) {
                    client.send(ClientMsg.RequestList)
                } else {
                    vector = patched
                    cacheVector(patched)
                }
            }
            is ServerMsg.PageExtend -> {
                page?.takeIf { it.pageId == msg.pageId }?.let {
                    it.fullHeight = msg.newFullHeight
                    it.tileCount += msg.addedTiles
                }
            }
            is ServerMsg.NavState -> {
                navState = msg
                urlInput = decodeUrlForDisplay(msg.url)
                // 新しい遷移が始まったら前回のエラー表示を消す
                if (msg.loading) errorText = null
            }
            is ServerMsg.Tabs -> {
                tabs = msg.tabs
                activeTabId = msg.activeId
            }
            is ServerMsg.Focus -> showInput = msg.kind == "text"
            is ServerMsg.Error -> errorText = msg.message
            else -> {}
        }
    }

    /** サーバーと同じ順で捨てる。表示中のものだけは残す */
    private fun cacheVector(page: VectorPage) {
        vectors.remove(page.viewKey)
        vectors[page.viewKey] = page
        val oldest = vectors.values.iterator()
        while (vectors.size > VECTOR_CACHE_LIMIT && oldest.hasNext()) {
            if (oldest.next() !== vector) oldest.remove()
        }
    }

    fun connect() = client.connect()

    fun close() = client.close()

    fun sendViewport() = client.send(viewport())

    fun navigate(url: String) = client.send(ClientMsg.Navigate(url))

    fun back() = client.send(ClientMsg.Back)

    fun forward() = client.send(ClientMsg.Forward)

    fun reload() = client.send(ClientMsg.Reload)

    fun newTab() = client.send(ClientMsg.NewTab())

    fun closeTab(tabId: String) = client.send(ClientMsg.CloseTab(tabId))

    fun selectTab(tabId: String) = client.send(ClientMsg.SelectTab(tabId))

    fun tap(x: Double, y: Double) = client.send(ClientMsg.Tap(x, y))

    fun longPress(x: Double, y: Double) = client.send(ClientMsg.LongPress(x, y))

    fun scrollTo(pageId: String, y: Int) = client.send(ClientMsg.ScrollPos(pageId, y))

    /** ライブモードは実ページを動かすのでpageIdを持たない */
    fun liveScrollTo(y: Int) = client.send(ClientMsg.ScrollPos("", y))

    fun requestTile(index: Int) = client.send(ClientMsg.RequestTiles(listOf(index)))

    fun insertText(text: String) = client.send(ClientMsg.InsertText(text))

    fun pressEnter() = client.send(ClientMsg.Key("Enter"))

    fun pressBackspace() = client.send(ClientMsg.Key("Backspace"))

    fun closeInput() {
        showInput = false
    }

    fun activate(nodeId: Int, x: Double, y: Double) {
        val target = vector ?: return
        client.send(ClientMsg.Activate(target.listId, nodeId, x, y))
    }

    /** 画面に入った画像だけ要求する。vectorモードの画像は要求しなければ届かない */
    fun requestAssets(nodeIds: List<Int>) {
        val target = vector ?: return
        if (nodeIds.isNotEmpty()) client.send(ClientMsg.RequestAssets(target.listId, nodeIds))
    }

    private fun switchMode(next: String) {
        mode = next
        if (next == "live") liveFrame = null
        if (next == "vector") vector = null
        client.send(ClientMsg.SetMode(next))
    }

    fun toggleLive() = switchMode(if (mode == "live") "page" else "live")

    fun toggleVector() = switchMode(if (mode == "vector") "page" else "vector")
}

@Composable
internal fun rememberBrowserState(
    serverUrl: String,
    tileCacheBytes: Int,
    viewport: () -> ClientMsg.Viewport,
    onAuthError: () -> Unit,
): BrowserState {
    val state = remember(serverUrl, tileCacheBytes) {
        BrowserState(serverUrl, tileCacheBytes, viewport, onAuthError)
    }
    DisposableEffect(state) {
        state.connect()
        onDispose { state.close() }
    }
    return state
}
