package com.njm2360.strawser.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculateCentroid
import androidx.compose.foundation.gestures.calculatePan
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.requiredWidth
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.isSpecified
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.PointerInputScope
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import com.njm2360.strawser.net.TileStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.conflate
import kotlinx.coroutines.withContext
import kotlin.math.min
import kotlin.math.roundToInt

// ローカルズームの倍率。1.0でエミュレーション幅が表示幅にちょうど収まる。
// 上限より上はタイルを引き伸ばすだけになる
private const val MIN_ZOOM = 1f
private const val MAX_ZOOM = 4f

@Composable
internal fun RemotePageView(
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
        val scale = viewportPx * zoom / page.pageWidth // 表示px/ページpx
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
