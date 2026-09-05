package com.njm2360.strawser.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBars
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.unit.dp
import com.njm2360.strawser.SearchEngine
import com.njm2360.strawser.net.ClientMsg
import com.njm2360.strawser.resolveInput
import kotlinx.coroutines.delay
import kotlin.math.roundToInt

// 回転では画面幅の変更と実測幅の反映が別々に届く。先に送ると合わない幅で撮り直される
private const val VIEWPORT_SETTLE_MS = 150L

@Composable
fun BrowserScreen(
    serverUrl: String,
    searchEngine: SearchEngine,
    tileCacheBytes: Int,
    openInput: String?,
    onOpened: () -> Unit,
    onOpenSettings: () -> Unit,
    onAuthError: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val density = LocalDensity.current.density
    val configuration = LocalConfiguration.current
    var contentWidthPx by remember { mutableStateOf(0) }
    val viewportW = if (contentWidthPx > 0) {
        (contentWidthPx / density).roundToInt()
    } else {
        configuration.screenWidthDp
    }
    // ビューポート高さをIMEで変えるとサーバーが毎回撮り直すので、実測せず画面高さから引く。
    // systemBarsはIMEでは動かない。ここがずれると画面に貼り付くopが画面の外に置かれる
    val bars = WindowInsets.systemBars.asPaddingValues()
    val viewportH = (
        configuration.screenHeightDp - URL_BAR_HEIGHT.value.roundToInt() -
            bars.calculateTopPadding().value.roundToInt() -
            bars.calculateBottomPadding().value.roundToInt()
        ).coerceAtLeast(320)
    // helloは接続時に送られるので、そのときの最新値を読めるようにしておく
    val currentViewport by rememberUpdatedState(ClientMsg.Viewport(viewportW, viewportH, density))

    val state = rememberBrowserState(
        serverUrl = serverUrl,
        tileCacheBytes = tileCacheBytes,
        viewport = { currentViewport },
        onAuthError = onAuthError,
    )
    var showTabs by remember { mutableStateOf(false) }

    val keyboardController = LocalSoftwareKeyboardController.current
    BackHandler(
        enabled = showTabs || state.showInput ||
            (state.connected && state.navState?.canGoBack == true),
    ) {
        if (showTabs) {
            showTabs = false
        } else if (state.showInput) {
            keyboardController?.hide()
            state.closeInput()
        } else {
            state.back()
        }
    }

    LaunchedEffect(state.connected, currentViewport) {
        delay(VIEWPORT_SETTLE_MS)
        if (state.connected) state.sendViewport()
    }

    LaunchedEffect(openInput, state.connected) {
        if (openInput == null || !state.connected) return@LaunchedEffect
        state.newTab(resolveInput(openInput, searchEngine))
        onOpened()
    }

    Box(
        modifier = modifier
            .fillMaxSize()
            .imePadding()
            .onSizeChanged { contentWidthPx = it.width },
    ) {
        Column(modifier = Modifier.fillMaxSize()) {
            UrlBar(
                urlInput = state.urlInput,
                onUrlChange = { state.urlInput = it },
                navState = state.navState,
                connected = state.connected,
                mode = state.mode,
                tabCount = state.tabs.size,
                onOpenSettings = onOpenSettings,
                onNavigate = { state.navigate(resolveInput(it, searchEngine)) },
                onShowTabs = { showTabs = true },
                onNewTab = { state.newTab() },
                onBack = state::back,
                onForward = state::forward,
                onReload = state::reload,
                onSelectMode = state::selectMode,
            )
            // 読み込み中に切れるとloading falseが二度と来ない
            if (state.connected && state.navState?.loading == true) {
                LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
            }
            state.errorText?.let {
                Text(
                    text = it,
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.padding(horizontal = 8.dp),
                )
            }
            if (state.mode == "vector") {
                VectorPageView(
                    page = state.vector,
                    tiles = state.tiles,
                    onActivate = state::activate,
                    onRequestAssets = state::requestAssets,
                    onScrollPos = state::scrollTo,
                    modifier = Modifier
                        .fillMaxWidth()
                        .weight(1f),
                )
            } else if (state.mode == "live") {
                LiveView(
                    frame = state.liveFrame,
                    pageWidth = state.liveWidth,
                    serverScrollY = state.liveScrollY,
                    onTap = state::tap,
                    onScrollTo = state::liveScrollTo,
                    modifier = Modifier
                        .fillMaxWidth()
                        .weight(1f),
                )
            } else {
                RemotePageView(
                    page = state.page,
                    tiles = state.tiles,
                    onTap = state::tap,
                    onLongPress = state::longPress,
                    onScrollPos = state::scrollTo,
                    onRequestTile = state::requestTile,
                    modifier = Modifier
                        .fillMaxWidth()
                        .weight(1f),
                )
            }
            if (state.showInput) {
                InputOverlay(
                    onInsert = state::insertText,
                    onEnter = state::pressEnter,
                    onBackspace = state::pressBackspace,
                    onClose = state::closeInput,
                )
            }
        }
        if (showTabs) {
            TabListOverlay(
                tabs = state.tabs,
                activeTabId = state.activeTabId,
                connected = state.connected,
                onSelect = {
                    state.selectTab(it)
                    showTabs = false
                },
                onCloseTab = state::closeTab,
                onNewTab = {
                    state.newTab()
                    showTabs = false
                },
                onDismiss = { showTabs = false },
            )
        }
        state.dialog?.let { dialog ->
            PageDialog(dialog = dialog, onAnswer = state::answerDialog)
        }
    }
}
