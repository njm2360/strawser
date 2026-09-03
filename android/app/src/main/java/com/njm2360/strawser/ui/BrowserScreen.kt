package com.njm2360.strawser.ui

import android.graphics.BitmapFactory
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.unit.dp
import com.njm2360.strawser.SearchEngine
import com.njm2360.strawser.decodeUrlForDisplay
import com.njm2360.strawser.net.ClientMsg
import com.njm2360.strawser.net.ServerMsg
import com.njm2360.strawser.net.TileStore
import com.njm2360.strawser.net.WsClient
import com.njm2360.strawser.resolveInput
import kotlin.math.roundToInt

// URLバーの高さ。ビューポート高さをIMEで変えるとサーバーが毎回撮り直すので、
// 実測せず画面高さから引く
private const val URL_BAR_DP = 56

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

@Composable
fun BrowserScreen(
    serverUrl: String,
    searchEngine: SearchEngine,
    tileCacheBytes: Int,
    onOpenSettings: () -> Unit,
    onAuthError: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var page by remember { mutableStateOf<RemotePage?>(null) }
    var navState by remember { mutableStateOf<ServerMsg.NavState?>(null) }
    var connected by remember { mutableStateOf(false) }
    var errorText by remember { mutableStateOf<String?>(null) }
    var urlInput by remember { mutableStateOf("") }
    var liveMode by remember { mutableStateOf(false) }
    var liveFrame by remember { mutableStateOf<ImageBitmap?>(null) }
    var liveScrollY by remember { mutableStateOf(0) }
    var liveWidth by remember { mutableStateOf(0) }
    var showInput by remember { mutableStateOf(false) }
    var tabs by remember { mutableStateOf<List<ServerMsg.TabInfo>>(emptyList()) }
    var activeTabId by remember { mutableStateOf("") }
    var showTabs by remember { mutableStateOf(false) }

    val density = LocalDensity.current.density
    val configuration = LocalConfiguration.current
    var contentWidthPx by remember { mutableStateOf(0) }
    val viewportW = if (contentWidthPx > 0) {
        (contentWidthPx / density).roundToInt()
    } else {
        configuration.screenWidthDp
    }
    val viewportH = (configuration.screenHeightDp - URL_BAR_DP).coerceAtLeast(320)
    // helloは接続時に送られるので、そのときの最新値を読めるようにしておく
    val currentViewport by rememberUpdatedState(ClientMsg.Viewport(viewportW, viewportH, density))

    // 接続を張り直してもタイルは持ち越す
    val tiles = remember(tileCacheBytes) { TileStore(tileCacheBytes) }

    val client = remember(serverUrl, tiles) {
        WsClient(
            serverUrl = serverUrl,
            tiles = tiles,
            viewport = { currentViewport },
            onMessage = { msg ->
                when (msg) {
                    is ServerMsg.HelloAck -> {
                        // 再接続時はサーバーがページモードへ戻すのでUI状態も揃える
                        liveMode = false
                        showInput = false
                    }
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
            },
            onTile = { pageId, tileIndex, hash ->
                val target = page ?: return@WsClient
                if (target.pageId == pageId) target.hashes[tileIndex] = hash
            },
            onLiveFrame = { header, bytes ->
                val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                if (bmp != null) {
                    liveFrame = bmp.asImageBitmap()
                    liveScrollY = header.scrollY
                    liveWidth = header.pageWidth
                }
            },
            onConnectionChange = { connected = it },
            onAuthError = onAuthError,
            onSuperseded = { errorText = "別の接続に切り替わりました。メニューの接続設定から繋ぎ直してください" },
        )
    }
    DisposableEffect(client) {
        client.connect()
        onDispose { client.close() }
    }

    val keyboardController = LocalSoftwareKeyboardController.current
    BackHandler(
        enabled = showTabs || showInput || (connected && navState?.canGoBack == true),
    ) {
        if (showTabs) {
            showTabs = false
        } else if (showInput) {
            keyboardController?.hide()
            showInput = false
        } else {
            client.send(ClientMsg.Back)
        }
    }

    LaunchedEffect(connected, currentViewport) {
        if (connected) client.send(currentViewport)
    }

    Box(
        modifier = modifier
            .fillMaxSize()
            .imePadding()
            .onSizeChanged { contentWidthPx = it.width },
    ) {
        Column(modifier = Modifier.fillMaxSize()) {
            UrlBar(
                urlInput = urlInput,
                onUrlChange = { urlInput = it },
                navState = navState,
                connected = connected,
                liveMode = liveMode,
                tabCount = tabs.size,
                onOpenSettings = onOpenSettings,
                onNavigate = { client.send(ClientMsg.Navigate(resolveInput(it, searchEngine))) },
                onShowTabs = { showTabs = true },
                onNewTab = { client.send(ClientMsg.NewTab()) },
                onBack = { client.send(ClientMsg.Back) },
                onForward = { client.send(ClientMsg.Forward) },
                onReload = { client.send(ClientMsg.Reload) },
                onToggleLive = {
                    liveMode = !liveMode
                    if (liveMode) liveFrame = null
                    client.send(ClientMsg.SetMode(if (liveMode) "live" else "page"))
                },
            )
            if (navState?.loading == true) {
                LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
            }
            errorText?.let {
                Text(
                    text = it,
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.padding(horizontal = 8.dp),
                )
            }
            if (liveMode) {
                LiveView(
                    frame = liveFrame,
                    pageWidth = liveWidth,
                    serverScrollY = liveScrollY,
                    onTap = { x, y -> client.send(ClientMsg.Tap(x, y)) },
                    onScrollTo = { y -> client.send(ClientMsg.ScrollPos("", y)) },
                    modifier = Modifier
                        .fillMaxWidth()
                        .weight(1f),
                )
            } else {
                RemotePageView(
                    page = page,
                    tiles = tiles,
                    onTap = { x, y -> client.send(ClientMsg.Tap(x, y)) },
                    onLongPress = { x, y -> client.send(ClientMsg.LongPress(x, y)) },
                    onScrollPos = { pageId, y -> client.send(ClientMsg.ScrollPos(pageId, y)) },
                    onRequestTile = { index -> client.send(ClientMsg.RequestTiles(listOf(index))) },
                    modifier = Modifier
                        .fillMaxWidth()
                        .weight(1f),
                )
            }
            if (showInput) {
                InputOverlay(
                    onInsert = { client.send(ClientMsg.InsertText(it)) },
                    onEnter = { client.send(ClientMsg.Key("Enter")) },
                    onBackspace = { client.send(ClientMsg.Key("Backspace")) },
                    onClose = { showInput = false },
                )
            }
        }
        if (showTabs) {
            TabListOverlay(
                tabs = tabs,
                activeTabId = activeTabId,
                onSelect = {
                    client.send(ClientMsg.SelectTab(it))
                    showTabs = false
                },
                onCloseTab = { client.send(ClientMsg.CloseTab(it)) },
                onNewTab = {
                    client.send(ClientMsg.NewTab())
                    showTabs = false
                },
                onDismiss = { showTabs = false },
            )
        }
    }
}
