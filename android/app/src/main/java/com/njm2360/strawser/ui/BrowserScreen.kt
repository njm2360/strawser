package com.njm2360.strawser.ui

import android.graphics.BitmapFactory
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculateCentroid
import androidx.compose.foundation.gestures.calculatePan
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.requiredWidth
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.isSpecified
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.PointerInputScope
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.njm2360.strawser.SearchEngine
import com.njm2360.strawser.net.ClientMsg
import com.njm2360.strawser.net.ServerMsg
import com.njm2360.strawser.net.TileStore
import com.njm2360.strawser.net.WsClient
import com.njm2360.strawser.resolveInput
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.conflate
import kotlinx.coroutines.withContext
import kotlin.math.min
import kotlin.math.roundToInt

// URLバーの高さ。ビューポート高さをIMEで変えるとサーバーが毎回撮り直すので、
// 実測せず画面高さから引く
private const val URL_BAR_DP = 56

// URL バー表示用: %E6%97%A5... のパーセントエンコードを読める形に戻す
// （+ は URLDecoder が空白にしてしまうため一旦退避する）
private fun decodeUrlForDisplay(url: String): String = try {
    java.net.URLDecoder.decode(url.replace("+", "%2B"), "UTF-8")
} catch (_: Exception) {
    url
}

/**
 * 1ページ分のタイル群。hashesは届いた分だけ埋まる。pageExtendで末尾に伸びる。
 * 絵の実体はTileStoreがhashで持っているので、ここが抱えるのは索引だけ
 */
private class RemotePage(
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

@Composable
private fun BarButton(
    label: String,
    onClick: () -> Unit,
    enabled: Boolean = true,
    color: Color = MaterialTheme.colorScheme.primary,
    style: TextStyle? = null,
) {
    Box(
        contentAlignment = Alignment.Center,
        modifier = Modifier
            .size(40.dp)
            .clip(MaterialTheme.shapes.small)
            .clickable(enabled = enabled, onClick = onClick),
    ) {
        Text(
            text = label,
            color = if (enabled) color else MaterialTheme.colorScheme.outlineVariant,
            style = style ?: MaterialTheme.typography.bodyLarge,
        )
    }
}

@Composable
private fun TabCountButton(count: Int, onClick: () -> Unit) {
    Box(
        contentAlignment = Alignment.Center,
        modifier = Modifier
            .size(40.dp)
            .clip(MaterialTheme.shapes.small)
            .clickable(onClick = onClick),
    ) {
        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier
                .size(22.dp)
                .border(2.dp, MaterialTheme.colorScheme.outline, RoundedCornerShape(5.dp)),
        ) {
            Text(
                text = if (count > 99) "∞" else count.toString(),
                color = MaterialTheme.colorScheme.outline,
                style = MaterialTheme.typography.labelSmall,
            )
        }
    }
}

@Composable
private fun UrlBar(
    urlInput: String,
    onUrlChange: (String) -> Unit,
    navState: ServerMsg.NavState?,
    connected: Boolean,
    liveMode: Boolean,
    tabCount: Int,
    onOpenSettings: () -> Unit,
    onNavigate: (String) -> Unit,
    onShowTabs: () -> Unit,
    onNewTab: () -> Unit,
    onBack: () -> Unit,
    onForward: () -> Unit,
    onReload: () -> Unit,
    onToggleLive: () -> Unit,
) {
    val focusManager = LocalFocusManager.current
    val keyboardController = LocalSoftwareKeyboardController.current
    val urlFocusRequester = remember { FocusRequester() }
    var menuOpen by remember { mutableStateOf(false) }
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 4.dp),
    ) {
        OutlinedTextField(
            value = urlInput,
            onValueChange = onUrlChange,
            singleLine = true,
            placeholder = { Text("URL") },
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Go),
            keyboardActions = KeyboardActions(onGo = {
                if (urlInput.isNotBlank()) onNavigate(urlInput.trim())
                focusManager.clearFocus()
                keyboardController?.hide()
            }),
            leadingIcon = {
                Box(
                    modifier = Modifier
                        .size(8.dp)
                        .background(
                            color = if (connected) Color(0xFF4CAF50) else Color(0xFFF44336),
                            shape = CircleShape,
                        ),
                )
            },
            trailingIcon = {
                if (urlInput.isNotEmpty()) {
                    // クリア後そのまま打てるようにフォーカスも与える
                    TextButton(onClick = {
                        onUrlChange("")
                        urlFocusRequester.requestFocus()
                    }) { Text("✕") }
                }
            },
            textStyle = MaterialTheme.typography.bodySmall,
            modifier = Modifier
                .weight(1f)
                .focusRequester(urlFocusRequester),
        )
        TabCountButton(count = tabCount, onClick = onShowTabs)
        Box {
            BarButton("⋮", { menuOpen = true })
            DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                Row(horizontalArrangement = Arrangement.SpaceEvenly, modifier = Modifier.fillMaxWidth()) {
                    BarButton("←", { menuOpen = false; onBack() }, navState?.canGoBack == true)
                    BarButton("→", { menuOpen = false; onForward() }, navState?.canGoForward == true)
                    BarButton("⟳", { menuOpen = false; onReload() }, connected)
                }
                HorizontalDivider()
                DropdownMenuItem(
                    text = { Text("新しいタブ") },
                    onClick = { menuOpen = false; onNewTab() },
                )
                DropdownMenuItem(
                    text = { Text("タブ一覧（$tabCount）") },
                    onClick = { menuOpen = false; onShowTabs() },
                )
                // 動画やアニメーションはタイル配信では追えないのでスクリーンキャストへ切り替える
                DropdownMenuItem(
                    text = { Text(if (liveMode) "LIVE表示をやめる" else "LIVE表示") },
                    enabled = connected,
                    onClick = { menuOpen = false; onToggleLive() },
                )
                HorizontalDivider()
                DropdownMenuItem(
                    text = { Text("接続設定") },
                    onClick = { menuOpen = false; onOpenSettings() },
                )
            }
        }
    }
}

@Composable
private fun TabListOverlay(
    tabs: List<ServerMsg.TabInfo>,
    activeTabId: String,
    onSelect: (String) -> Unit,
    onCloseTab: (String) -> Unit,
    onNewTab: () -> Unit,
    onDismiss: () -> Unit,
) {
    Surface(modifier = Modifier.fillMaxSize()) {
        Column(modifier = Modifier.fillMaxSize()) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 4.dp),
            ) {
                Text(
                    text = "タブ",
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier
                        .weight(1f)
                        .padding(start = 12.dp),
                )
                BarButton("＋", onNewTab)
                BarButton("✕", onDismiss)
            }
            HorizontalDivider()
            LazyColumn(modifier = Modifier.weight(1f)) {
                items(tabs, key = { it.id }) { tab ->
                    TabListRow(
                        tab = tab,
                        active = tab.id == activeTabId,
                        onSelect = { onSelect(tab.id) },
                        onClose = { onCloseTab(tab.id) },
                    )
                }
            }
        }
    }
}

@Composable
private fun TabListRow(
    tab: ServerMsg.TabInfo,
    active: Boolean,
    onSelect: () -> Unit,
    onClose: () -> Unit,
) {
    val blank = tab.url.isBlank() || tab.url == "about:blank"
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .background(
                if (active) MaterialTheme.colorScheme.surfaceVariant else Color.Transparent,
            )
            .clickable(onClick = onSelect)
            .padding(start = 16.dp, top = 8.dp, bottom = 8.dp),
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = tab.title.ifBlank { "新しいタブ" },
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                style = MaterialTheme.typography.bodyMedium,
            )
            if (!blank) {
                Text(
                    text = decodeUrlForDisplay(tab.url),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    color = MaterialTheme.colorScheme.outline,
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        }
        BarButton("✕", onClose, color = MaterialTheme.colorScheme.outline)
    }
}

/**
 * ライブモード表示。ビューポートの JPEG ストリームを表示し、
 * スクロールはサーバー往復（縦ドラッグ量を 300ms ごとにまとめて scrollPos で送る）
 */
@Composable
private fun LiveView(
    frame: ImageBitmap?,
    pageWidth: Int,
    serverScrollY: Int,
    onTap: (x: Double, y: Double) -> Unit,
    onScrollTo: (y: Int) -> Unit,
    modifier: Modifier = Modifier,
) {
    val curScrollY by rememberUpdatedState(serverScrollY)
    val curPageWidth by rememberUpdatedState(pageWidth)
    var dragAccumPage by remember { mutableStateOf(0f) } // 未送信の縦ドラッグ量（ページ座標）

    LaunchedEffect(Unit) {
        while (true) {
            delay(300)
            if (kotlin.math.abs(dragAccumPage) >= 20f) {
                onScrollTo((curScrollY + dragAccumPage).toInt().coerceAtLeast(0))
                dragAccumPage = 0f
            }
        }
    }

    Box(
        modifier = modifier
            .pointerInput(Unit) {
                detectTapGestures(onTap = { offset ->
                    // ライブフレームはビューポートのみなので実ページの scrollY を足してページ座標へ
                    val scale = curPageWidth.toFloat() / size.width
                    onTap(
                        (offset.x * scale).toDouble(),
                        (curScrollY + offset.y * scale).toDouble(),
                    )
                })
            }
            .pointerInput(Unit) {
                detectVerticalDragGestures { change, dragAmount ->
                    change.consume()
                    val scale = curPageWidth.toFloat() / size.width
                    dragAccumPage -= dragAmount * scale // 指を上へ = ページを下へ
                }
            },
    ) {
        if (frame != null) {
            Image(
                bitmap = frame,
                contentDescription = null,
                contentScale = ContentScale.FillWidth,
                modifier = Modifier
                    .fillMaxWidth()
                    .align(Alignment.TopCenter),
            )
        } else {
            Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator()
            }
        }
    }
}

/**
 * リモート入力欄フォーカス時の IME オーバーレイ。
 * ローカルで文字を確定してから insertText でまとめて送る（リモート画面に入力途中は映らない）
 */
@Composable
private fun InputOverlay(
    onInsert: (String) -> Unit,
    onEnter: () -> Unit,
    onBackspace: () -> Unit,
    onClose: () -> Unit,
) {
    var text by remember { mutableStateOf("") }
    val focusRequester = remember { FocusRequester() }
    val keyboardController = LocalSoftwareKeyboardController.current
    LaunchedEffect(Unit) { focusRequester.requestFocus() }

    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 4.dp),
    ) {
        OutlinedTextField(
            value = text,
            onValueChange = { text = it },
            placeholder = { Text("リモート入力") },
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
            keyboardActions = KeyboardActions(onSend = {
                if (text.isNotEmpty()) {
                    onInsert(text)
                    text = ""
                }
            }),
            textStyle = MaterialTheme.typography.bodySmall,
            modifier = Modifier
                .weight(1f)
                .focusRequester(focusRequester),
        )
        // 未送信テキストを送ってから Enter（検索実行など）
        TextButton(onClick = {
            if (text.isNotEmpty()) {
                onInsert(text)
                text = ""
            }
            onEnter()
        }) { Text("⏎") }
        TextButton(onClick = onBackspace) { Text("⌫") }
        TextButton(onClick = {
            keyboardController?.hide()
            onClose()
        }) { Text("✕") }
    }
}

// ローカルズームの倍率。1.0でエミュレーション幅が表示幅にちょうど収まる。
// 上限より上はタイルを引き伸ばすだけになる
private const val MIN_ZOOM = 1f
private const val MAX_ZOOM = 4f

/**
 * 二本指のときだけピンチを拾う。一本指のイベントは消費せずLazyColumnの縦スクロールへ流す。
 * 二本目が触れた後は最後の指が離れるまで消費し続ける（途中でLazyColumnに奪われると飛ぶ）
 */
private suspend fun PointerInputScope.detectPinch(
    onPinch: (centroid: Offset, zoomChange: Float, panChange: Offset) -> Unit,
) {
    awaitEachGesture {
        awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
        var pinching = false
        do {
            // LazyColumnはMainパスで判定するので、その前に消費しないと縦に流れる
            val event = awaitPointerEvent(PointerEventPass.Initial)
            if (event.changes.count { it.pressed } >= 2) pinching = true
            if (pinching) {
                // 直前も接地していた指が1本も無いフレーム（同時タッチダウンなど）では
                // centroidがUnspecifiedになる。NaNを倍率と横位置に流すと以後戻せない
                val centroid = event.calculateCentroid()
                if (centroid.isSpecified) {
                    onPinch(centroid, event.calculateZoom(), event.calculatePan())
                }
                event.changes.forEach { it.consume() }
            }
        } while (event.changes.any { it.pressed })
    }
}

/** 一度掴んだImageBitmapは表示している間離さない。LruCacheから落ちても絵が消えないように */
@Composable
private fun rememberTileBitmap(
    tiles: TileStore,
    hash: String?,
    onMissing: () -> Unit,
): ImageBitmap? {
    var bitmap by remember(hash) { mutableStateOf(hash?.let { tiles.peek(it) }) }
    val missing by rememberUpdatedState(onMissing)
    LaunchedEffect(hash) {
        if (hash == null || bitmap != null) return@LaunchedEffect
        val decoded = withContext(Dispatchers.Default) { tiles.bitmap(hash) }
        // バイト列がキャッシュから落ちていたら要求し直す
        if (decoded == null) missing() else bitmap = decoded
    }
    return bitmap
}

@Composable
private fun RemotePageView(
    page: RemotePage?,
    tiles: TileStore,
    onTap: (x: Double, y: Double) -> Unit,
    onLongPress: (x: Double, y: Double) -> Unit,
    onScrollPos: (pageId: String, y: Int) -> Unit,
    onRequestTile: (index: Int) -> Unit,
    modifier: Modifier = Modifier,
) {
    if (page == null) {
        Box(modifier = modifier, contentAlignment = Alignment.Center) {
            CircularProgressIndicator()
        }
        return
    }
    BoxWithConstraints(modifier = modifier.clipToBounds()) {
        val density = LocalDensity.current
        val viewportPx = constraints.maxWidth.toFloat()
        var zoom by remember(page.pageId) { mutableFloatStateOf(MIN_ZOOM) }
        var panPx by remember(page.pageId) { mutableFloatStateOf(0f) } // 常に0以下
        val contentWidth = with(density) { (viewportPx * zoom).toDp() }
        val scale = viewportPx * zoom / page.pageWidth // 表示px / ページpx
        // タイル高さ・タップ座標・scrollPosはすべてこのscale経由。ピンチのたびに貼り直さず
        // 最新値を読めるよう、pointerInputとsnapshotFlowからはこちらを見る
        val curScale by rememberUpdatedState(scale)
        val listState = rememberLazyListState()

        // 表示位置を合わせてから通知を始める。新しいページは先頭、戻る・進む・タブ切替では
        // 離れたときの位置。通知が先に出るとサーバーが覚えている位置を0で潰してしまう
        LaunchedEffect(page) {
            listState.scrollToItem(
                index = page.scrollY / page.tileHeight,
                scrollOffset = ((page.scrollY % page.tileHeight) * scale).roundToInt(),
            )
            // ローカルスクロール位置をページ座標でサーバーへ通知（300msスロットル）
            snapshotFlow {
                listState.firstVisibleItemIndex * page.tileHeight +
                    (listState.firstVisibleItemScrollOffset / curScale).toInt()
            }
                .conflate()
                .collect { y ->
                    onScrollPos(page.pageId, y)
                    delay(300)
                }
        }

        Box(
            modifier = Modifier
                .fillMaxSize()
                .pointerInput(page.pageId, viewportPx) {
                    detectPinch { centroid, zoomChange, panChange ->
                        val newZoom = (zoom * zoomChange).coerceIn(MIN_ZOOM, MAX_ZOOM)
                        // ピンチ中心の下にあるページ上の点を動かさない
                        val anchor = (centroid.x - panPx) / zoom
                        zoom = newZoom
                        panPx = (centroid.x - anchor * newZoom + panChange.x)
                            .coerceIn(-viewportPx * (newZoom - 1f), 0f)
                    }
                },
        ) {
            // 列を実寸幅で置いてtranslationXでずらす。LazyColumnの横方向のクリップは
            // 自分の幅までなので、はみ出す幅を持たせないとタイルが切れる
            LazyColumn(
                state = listState,
                modifier = Modifier
                    .requiredWidth(contentWidth)
                    .graphicsLayer { translationX = panPx },
            ) {
                items(count = page.tileCount, key = { it }) { index ->
                    val tilePageHeight =
                        min(page.tileHeight, page.fullHeight - index * page.tileHeight)
                    val tileHeightDp = with(density) { (tilePageHeight * scale).toDp() }
                    val bitmap = rememberTileBitmap(tiles, page.hashes[index]) {
                        onRequestTile(index)
                    }
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(tileHeightDp)
                            .pointerInput(page.pageId, index) {
                                // 表示座標→pageWidth基準のページ座標（タイルoffsetYを足す）。
                                // 横位置はtranslationXの分がポインタ座標から引かれた後なので
                                // ここで掛けるのは倍率だけ
                                val toPage = { v: Float -> v / curScale }
                                detectTapGestures(
                                    onTap = { offset ->
                                        onTap(
                                            toPage(offset.x).toDouble(),
                                            (index * page.tileHeight + toPage(offset.y)).toDouble(),
                                        )
                                    },
                                    onLongPress = { offset ->
                                        onLongPress(
                                            toPage(offset.x).toDouble(),
                                            (index * page.tileHeight + toPage(offset.y)).toDouble(),
                                        )
                                    },
                                )
                            },
                    ) {
                        if (bitmap != null) {
                            Image(
                                bitmap = bitmap,
                                contentDescription = null,
                                contentScale = ContentScale.FillWidth,
                                modifier = Modifier.fillMaxWidth(),
                            )
                        } else {
                            Box(
                                modifier = Modifier
                                    .fillMaxSize()
                                    .background(Color(0xFFE0E0E0)),
                            )
                        }
                    }
                }
            }
        }
    }
}
