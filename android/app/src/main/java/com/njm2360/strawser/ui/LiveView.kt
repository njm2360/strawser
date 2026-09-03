package com.njm2360.strawser.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import kotlinx.coroutines.delay
import kotlin.math.abs

/**
 * ライブモード表示。ビューポートのJPEGストリームを表示し、
 * スクロールはサーバー往復（縦ドラッグ量を300msごとにまとめてscrollPosで送る）
 */
@Composable
internal fun LiveView(
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
            if (abs(dragAccumPage) >= 20f) {
                onScrollTo((curScrollY + dragAccumPage).toInt().coerceAtLeast(0))
                dragAccumPage = 0f
            }
        }
    }

    Box(
        modifier = modifier
            .pointerInput(Unit) {
                detectTapGestures(onTap = { offset ->
                    // ライブフレームはビューポートのみなので実ページのscrollYを足してページ座標へ
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
                    dragAccumPage -= dragAmount * scale // 指を上へ=ページを下へ
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
