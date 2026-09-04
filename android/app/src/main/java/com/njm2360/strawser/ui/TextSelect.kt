package com.njm2360.strawser.ui

import android.graphics.Paint
import android.graphics.RectF
// java.textは日本語を1文字ずつ切る
import android.icu.text.BreakIterator
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.PointerInputScope
import com.njm2360.strawser.net.DrawOp
import kotlinx.coroutines.withTimeoutOrNull

// 指から離れた行まで拾いに行く範囲（ページ座標）
private const val REACH = 200f

// 行を跨ぐぶんを、同じ行の左右より重く見る
private const val ROW_WEIGHT = 4f

/** 表示リストの中の一点。opは行、chはその行の何文字目か */
internal data class TextPos(val op: Int, val ch: Int) : Comparable<TextPos> {
    override fun compareTo(other: TextPos): Int =
        if (op != other.op) op - other.op else ch - other.ch
}

/** 行頭からの文字送り。i文字目の左端がadv[i]。描画と同じ設定で測る */
private fun advancesOf(page: VectorPage, op: DrawOp, paint: Paint): FloatArray? {
    if (!textPaint(paint, page, op)) return null
    val widths = FloatArray(op.s.length)
    paint.getTextWidths(op.s, widths)
    val adv = FloatArray(op.s.length + 1)
    for (i in widths.indices) adv[i + 1] = adv[i] + widths[i]
    return adv
}

// サロゲートペアの途中で切らない
private fun snap(text: String, index: Int): Int =
    if (index in 1 until text.length && Character.isLowSurrogate(text[index])) index + 1 else index

/**
 * 指に一番近い行の、指に一番近い文字の境目。
 * insideなら行に触れているときだけ返す（画像や余白の長押しで選択を始めない）
 */
internal fun VectorPage.textAt(
    x: Float,
    y: Float,
    paint: Paint,
    inside: Boolean = false,
): TextPos? {
    var best = -1
    var bestScore = Float.MAX_VALUE
    for (i in indicesIn(y - REACH, y + REACH)) {
        val op = list.ops[i]
        if (op.t != 1 || op.s.isEmpty()) continue
        val dy = maxOf(0f, op.b[1] - y, y - (op.b[1] + op.b[3]))
        val dx = maxOf(0f, op.b[0] - x, x - (op.b[0] + op.b[2]))
        if (inside && (dy > 0f || dx > 0f)) continue
        val score = dy * ROW_WEIGHT + dx
        if (score < bestScore) {
            bestScore = score
            best = i
        }
    }
    if (best < 0) return null
    val op = list.ops[best]
    val adv = advancesOf(this, op, paint) ?: return null
    val local = x - op.b[0]
    var ch = adv.size - 1
    for (i in 0 until adv.size - 1) {
        if (local < (adv[i] + adv[i + 1]) / 2f) {
            ch = i
            break
        }
    }
    return TextPos(best, snap(op.s, ch))
}

/** 長押しした一語 */
internal fun VectorPage.wordAt(pos: TextPos): Pair<TextPos, TextPos> {
    val text = list.ops[pos.op].s
    if (text.isEmpty()) return pos to pos
    val breaks = BreakIterator.getWordInstance()
    breaks.setText(text)
    val after = breaks.following(pos.ch.coerceIn(0, text.length - 1))
    val end = if (after == BreakIterator.DONE) text.length else after
    val before = breaks.previous()
    val start = if (before == BreakIterator.DONE) 0 else before
    return TextPos(pos.op, start) to TextPos(pos.op, end)
}

private inline fun VectorPage.forEachRun(
    from: TextPos,
    to: TextPos,
    body: (op: DrawOp, start: Int, end: Int) -> Unit,
) {
    for (i in from.op..minOf(to.op, list.ops.size - 1)) {
        val op = list.ops[i]
        if (op.t != 1) continue
        val start = if (i == from.op) from.ch else 0
        val end = if (i == to.op) to.ch else op.s.length
        if (start >= end || end > op.s.length) continue
        body(op, start, end)
    }
}

/** 選択されている範囲の矩形（ページ座標）。行ごとに1つ */
internal fun VectorPage.selectionRects(from: TextPos, to: TextPos, paint: Paint): List<RectF> {
    val out = ArrayList<RectF>()
    forEachRun(from, to) { op, start, end ->
        val adv = advancesOf(this, op, paint) ?: return@forEachRun
        out.add(RectF(op.b[0] + adv[start], op.b[1], op.b[0] + adv[end], op.b[1] + op.b[3]))
    }
    return out
}

internal fun VectorPage.selectedText(from: TextPos, to: TextPos): String {
    val out = StringBuilder()
    var prev: DrawOp? = null
    forEachRun(from, to) { op, start, end ->
        val last = prev
        val sameRow = last != null &&
            op.b[1] < last.b[1] + last.b[3] && last.b[1] < op.b[1] + op.b[3]
        if (last != null && !sameRow) out.append('\n')
        out.append(op.s, start, end)
        prev = op
    }
    return out.toString()
}

/**
 * 長押しで選択を始め、指を離すまで伸ばす。ハンドルを掴んだときは押した瞬間から伸ばす。
 *
 * 長押しと分かるまでは何も消費しないので、それまでのスクロールとピンチは通る。
 * Modifierチェーンではスクロールとタップより先に置くこと
 */
internal suspend fun PointerInputScope.detectTextSelect(
    onHandle: (Offset) -> Boolean,
    onLongPress: (Offset) -> Boolean,
    onDrag: (Offset) -> Unit,
) {
    awaitEachGesture {
        val down = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
        if (!onHandle(down.position)) {
            val longPressed = withTimeoutOrNull(viewConfiguration.longPressTimeoutMillis) {
                while (true) {
                    val event = awaitPointerEvent(PointerEventPass.Initial)
                    if (event.changes.count { it.pressed } >= 2) return@withTimeoutOrNull
                    val change = event.changes.firstOrNull { it.id == down.id }
                        ?: return@withTimeoutOrNull
                    if (!change.pressed) return@withTimeoutOrNull
                    if ((change.position - down.position).getDistance() > viewConfiguration.touchSlop) {
                        return@withTimeoutOrNull
                    }
                }
            } == null
            if (!longPressed || !onLongPress(down.position)) return@awaitEachGesture
        }
        down.consume()
        while (true) {
            val event = awaitPointerEvent(PointerEventPass.Initial)
            val change = event.changes.firstOrNull { it.id == down.id } ?: break
            onDrag(change.position)
            event.changes.forEach { it.consume() }
            if (!change.pressed) break
        }
    }
}
