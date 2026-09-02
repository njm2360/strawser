package com.njm2360.strawser.ui

import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import com.njm2360.strawser.net.ClientMsg
import com.njm2360.strawser.net.ServerMsg
import com.njm2360.strawser.net.WsClient
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.conflate
import kotlin.math.min

// サーバー側エミュレーション幅（ページ座標の基準）
private const val PAGE_WIDTH = 720f

// URL バー表示用: %E6%97%A5... のパーセントエンコードを読める形に戻す
// （+ は URLDecoder が空白にしてしまうため一旦退避する）
private fun decodeUrlForDisplay(url: String): String = try {
    java.net.URLDecoder.decode(url.replace("+", "%2B"), "UTF-8")
} catch (_: Exception) {
    url
}

/** 1 ページ分のタイル群。tiles は届いた分だけ埋まる。pageExtend で末尾に伸びる */
private class RemotePage(
    val pageId: String,
    val tileHeight: Int,
    fullHeight: Int,
    tileCount: Int,
) {
    var fullHeight by mutableStateOf(fullHeight)
    var tileCount by mutableStateOf(tileCount)
    val tiles = mutableStateMapOf<Int, ImageBitmap>()
}

@Composable
fun BrowserScreen(
    serverUrl: String,
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
    var showInput by remember { mutableStateOf(false) }

    val client = remember(serverUrl) {
        WsClient(
            serverUrl = serverUrl,
            onMessage = { msg ->
                when (msg) {
                    is ServerMsg.HelloAck -> {
                        // 再接続時はサーバーがページモードへ戻すので UI 状態も揃える
                        liveMode = false
                        showInput = false
                    }
                    is ServerMsg.PageBegin -> {
                        page = RemotePage(msg.pageId, msg.tileHeight, msg.fullHeight, msg.tileCount)
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
                    is ServerMsg.Focus -> showInput = msg.kind == "text"
                    is ServerMsg.Error -> errorText = msg.message
                    else -> {}
                }
            },
            onTile = { header, bytes ->
                val target = page ?: return@WsClient
                if (target.pageId != header.pageId) return@WsClient
                val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                if (bmp != null) {
                    target.tiles[header.tileIndex] = bmp.asImageBitmap()
                } else {
                    android.util.Log.w("BrowserScreen", "tile decode failed (${bytes.size} bytes)")
                }
            },
            onLiveFrame = { header, bytes ->
                val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                if (bmp != null) {
                    liveFrame = bmp.asImageBitmap()
                    liveScrollY = header.scrollY
                }
            },
            onConnectionChange = { connected = it },
            onAuthError = onAuthError,
        )
    }
    DisposableEffect(client) {
        client.connect()
        onDispose { client.close() }
    }

    Column(modifier = modifier.fillMaxSize().imePadding()) {
        UrlBar(
            urlInput = urlInput,
            onUrlChange = { urlInput = it },
            navState = navState,
            connected = connected,
            liveMode = liveMode,
            onNavigate = { client.send(ClientMsg.Navigate(it)) },
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
                serverScrollY = liveScrollY,
                onTap = { x, y -> client.send(ClientMsg.Tap(x, y)) },
                onScrollTo = { y -> client.send(ClientMsg.ScrollPos(y)) },
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f),
            )
        } else {
            RemotePageView(
                page = page,
                onTap = { x, y -> client.send(ClientMsg.Tap(x, y)) },
                onLongPress = { x, y -> client.send(ClientMsg.LongPress(x, y)) },
                onScrollPos = { y -> client.send(ClientMsg.ScrollPos(y)) },
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
}

@Composable
private fun UrlBar(
    urlInput: String,
    onUrlChange: (String) -> Unit,
    navState: ServerMsg.NavState?,
    connected: Boolean,
    liveMode: Boolean,
    onNavigate: (String) -> Unit,
    onBack: () -> Unit,
    onForward: () -> Unit,
    onReload: () -> Unit,
    onToggleLive: () -> Unit,
) {
    val focusManager = LocalFocusManager.current
    val keyboardController = LocalSoftwareKeyboardController.current
    val urlFocusRequester = remember { FocusRequester() }
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 4.dp),
    ) {
        TextButton(onClick = onBack, enabled = navState?.canGoBack == true) { Text("←") }
        TextButton(onClick = onForward, enabled = navState?.canGoForward == true) { Text("→") }
        TextButton(onClick = onReload, enabled = connected) { Text("⟳") }
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
        // 動画やアニメーションはタイル配信では追えないのでスクリーンキャストへ切り替える
        TextButton(onClick = onToggleLive, enabled = connected) {
            Text(
                text = "LIVE",
                color = if (liveMode) Color(0xFFF44336) else MaterialTheme.colorScheme.outline,
                style = MaterialTheme.typography.labelSmall,
            )
        }
        Box(
            modifier = Modifier
                .padding(8.dp)
                .size(10.dp)
                .background(
                    color = if (connected) Color(0xFF4CAF50) else Color(0xFFF44336),
                    shape = MaterialTheme.shapes.small,
                ),
        )
    }
}

/**
 * ライブモード表示。ビューポートの JPEG ストリームを表示し、
 * スクロールはサーバー往復（縦ドラッグ量を 300ms ごとにまとめて scrollPos で送る）
 */
@Composable
private fun LiveView(
    frame: ImageBitmap?,
    serverScrollY: Int,
    onTap: (x: Double, y: Double) -> Unit,
    onScrollTo: (y: Int) -> Unit,
    modifier: Modifier = Modifier,
) {
    val curScrollY by rememberUpdatedState(serverScrollY)
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
                    val scale = PAGE_WIDTH / size.width
                    onTap(
                        (offset.x * scale).toDouble(),
                        (curScrollY + offset.y * scale).toDouble(),
                    )
                })
            }
            .pointerInput(Unit) {
                detectVerticalDragGestures { change, dragAmount ->
                    change.consume()
                    val scale = PAGE_WIDTH / size.width
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

@Composable
private fun RemotePageView(
    page: RemotePage?,
    onTap: (x: Double, y: Double) -> Unit,
    onLongPress: (x: Double, y: Double) -> Unit,
    onScrollPos: (y: Int) -> Unit,
    modifier: Modifier = Modifier,
) {
    if (page == null) {
        Box(modifier = modifier, contentAlignment = Alignment.Center) {
            CircularProgressIndicator()
        }
        return
    }
    BoxWithConstraints(modifier = modifier) {
        val widthPx = constraints.maxWidth.toFloat()
        val scale = widthPx / PAGE_WIDTH // 表示 px / ページ px
        val density = LocalDensity.current
        val listState = rememberLazyListState()

        // 新しいページが始まったら先頭へ戻す（scrollPos も 0 に通知され、tile 0 が最優先で届く）
        LaunchedEffect(page.pageId) {
            listState.scrollToItem(0)
        }

        // ローカルスクロール位置をページ座標でサーバーへ通知（300ms スロットル）
        LaunchedEffect(page.pageId, scale) {
            snapshotFlow {
                listState.firstVisibleItemIndex * page.tileHeight +
                    (listState.firstVisibleItemScrollOffset / scale).toInt()
            }
                .conflate()
                .collect { y ->
                    onScrollPos(y)
                    delay(300)
                }
        }

        LazyColumn(state = listState) {
            items(count = page.tileCount, key = { it }) { index ->
                val tilePageHeight = min(page.tileHeight, page.fullHeight - index * page.tileHeight)
                val tileHeightDp = with(density) { (tilePageHeight * scale).toDp() }
                val bitmap = page.tiles[index]
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(tileHeightDp)
                        .pointerInput(page.pageId, index) {
                            // 表示座標 → 720px 基準ページ座標（タイル offsetY を足す）
                            val toPage = { v: Float -> v * PAGE_WIDTH / size.width }
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
