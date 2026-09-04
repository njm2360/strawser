package com.njm2360.strawser.ui

import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculateCentroid
import androidx.compose.foundation.gestures.calculatePan
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.isSpecified
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.PointerInputScope

// ローカルズームの倍率。1.0でエミュレーション幅が表示幅にちょうど収まる
internal const val MIN_ZOOM = 1f
internal const val MAX_ZOOM = 4f

/**
 * 二本指のときだけピンチを拾う。一本指のイベントは消費せず縦スクロールへ流す。
 * 二本目が触れた後は最後の指が離れるまで消費し続ける（途中でスクロールに奪われると飛ぶ）。
 *
 * 縦スクロールもタップもMainパスで判定するので、Initialパスで消費して先回りする。
 * 同じ理由でModifierチェーンではスクロールとタップより先に置くこと
 */
internal suspend fun PointerInputScope.detectPinch(
    onPinch: (centroid: Offset, zoomChange: Float, panChange: Offset) -> Unit,
) {
    awaitEachGesture {
        awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
        var pinching = false
        do {
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
