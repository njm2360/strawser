package com.njm2360.strawser.ui

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import androidx.compose.foundation.Canvas as ComposeCanvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.rememberScrollableState
import androidx.compose.foundation.gestures.scrollable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.input.pointer.pointerInput
import com.njm2360.strawser.net.DisplayList
import com.njm2360.strawser.net.DrawOp
import com.njm2360.strawser.net.ServerMsg
import com.njm2360.strawser.net.TileStore
import kotlinx.coroutines.delay
import kotlin.math.max

// 描画コマンドをy座標で束ねる幅
private const val BAND = 512

// 画像要求をまとめる間隔
private const val ASSET_BATCH_MS = 150L

/**
 * 折り返しはサーバーが実測した位置で確定しているので、端末は行を置くだけでよい。
 * assetsは要求して届いた画像のhash（実体はTileStoreがhashで持つ）。
 * scrollYはページ座標で、世代をまたいで引き継ぐ
 */
internal class VectorPage(
    val listId: String,
    val viewKey: String,
    val url: String,
    val list: DisplayList,
) {
    var scrollY: Float = 0f

    /** ページ内リンクでは#より後ろだけが変わる。同じ文書かはこれで比べる */
    val documentUrl: String = url.substringBefore('#')
    val colors: IntArray = IntArray(list.colors.size) { parseColor(list.colors[it]) }
    val bgColor: Int = if (list.bg in colors.indices) colors[list.bg] else 0xFFFFFFFF.toInt()
    val assets = mutableStateMapOf<Int, String>()

    private val bands: Map<Int, List<DrawOp>> = list.ops.groupBy { (it.b[1] / BAND).toInt() }

    /** 高い矩形が上の帯から垂れてくるので、band4つぶん余分に見る */
    fun opsIn(top: Float, bottom: Float): Sequence<DrawOp> {
        val from = max(0, (top / BAND).toInt() - 4)
        val to = (bottom / BAND).toInt()
        return (from..to).asSequence()
            .flatMap { bands[it].orEmpty() }
            .filter { it.b[1] < bottom && it.b[1] + it.b[3] > top }
    }

    /** 押された位置の要素。手前に描かれたものが勝つ */
    fun hit(x: Float, y: Float): Int {
        var found = -1
        for (op in opsIn(y - 1f, y + 1f)) {
            if (op.a < 0) continue
            if (x >= op.b[0] && x <= op.b[0] + op.b[2] && y >= op.b[1] && y <= op.b[1] + op.b[3]) {
                found = op.a
            }
        }
        return found
    }

    /** 差分を当てた次の世代。土台の範囲が合わなければnull（丸ごと要求し直す） */
    fun patch(msg: ServerMsg.VectorDiff): VectorPage? {
        val ops = ArrayList<DrawOp>(list.ops.size)
        for (chunk in msg.ops) {
            if (chunk.n <= 0) {
                ops.addAll(chunk.o)
                continue
            }
            if (chunk.a < 0 || chunk.a + chunk.n > list.ops.size) return null
            val run = list.ops.subList(chunk.a, chunk.a + chunk.n)
            if (chunk.dy == 0f) ops.addAll(run) else run.mapTo(ops) { it.shiftY(chunk.dy) }
        }
        val next = VectorPage(
            listId = msg.listId,
            viewKey = msg.viewKey,
            url = msg.url,
            list = DisplayList(
                pageWidth = msg.pageWidth,
                fullHeight = msg.fullHeight,
                bg = msg.bg,
                colors = list.colors + msg.colors,
                fonts = list.fonts + msg.fonts,
                ops = ops,
            ),
        )
        next.scrollY = scrollY
        next.assets.putAll(assets)
        // 差し込まれた画像は位置か大きさが変わっている。撮り直しを要求させる
        for (chunk in msg.ops) {
            for (op in chunk.o) if (op.t == 2) next.assets.remove(op.i)
        }
        return next
    }

    private companion object {
        fun DrawOp.shiftY(dy: Float): DrawOp = copy(
            b = listOf(b[0], b[1] + dy, b[2], b[3]),
            cl = if (cl.size == 4) listOf(cl[0], cl[1] + dy, cl[2], cl[3]) else cl,
        )

        fun parseColor(s: String): Int {
            val hex = s.removePrefix("#")
            return when (hex.length) {
                6 -> (0xFF000000L or hex.toLong(16)).toInt()
                8 -> {
                    val rgb = hex.substring(0, 6).toLong(16)
                    val a = hex.substring(6, 8).toLong(16)
                    ((a shl 24) or rgb).toInt()
                }
                else -> 0xFF000000.toInt()
            }
        }
    }
}

@Composable
internal fun VectorPageView(
    page: VectorPage?,
    tiles: TileStore,
    onActivate: (nodeId: Int, x: Double, y: Double) -> Unit,
    onRequestAssets: (List<Int>) -> Unit,
    modifier: Modifier = Modifier,
) {
    if (page == null) {
        Box(modifier = modifier, contentAlignment = Alignment.Center) {
            CircularProgressIndicator()
        }
        return
    }
    BoxWithConstraints(modifier = modifier.clipToBounds()) {
        val viewportPx = constraints.maxWidth.toFloat()
        val viewportHeightPx = constraints.maxHeight.toFloat()
        // 1 CSS px = 1 dpなので、これは端末の表示密度そのものになる
        val scale = viewportPx / page.list.pageWidth
        val maxScroll = max(0f, page.list.fullHeight * scale - viewportHeightPx)
        var scrollY by remember(page) {
            mutableFloatStateOf((page.scrollY * scale).coerceIn(0f, maxScroll))
        }

        val wanted = remember(page) { mutableStateListOf<Int>() }
        val request by rememberUpdatedState(onRequestAssets)
        LaunchedEffect(page) {
            while (true) {
                delay(ASSET_BATCH_MS)
                if (wanted.isEmpty()) continue
                val batch = wanted.toList()
                wanted.clear()
                request(batch)
            }
        }

        val paint = remember { Paint(Paint.ANTI_ALIAS_FLAG) }
        ComposeCanvas(
            modifier = Modifier
                .fillMaxSize()
                .background(Color(page.bgColor))
                .scrollable(
                    orientation = Orientation.Vertical,
                    state = rememberScrollableState { delta ->
                        val next = (scrollY - delta).coerceIn(0f, maxScroll)
                        val consumed = scrollY - next
                        scrollY = next
                        page.scrollY = next / scale
                        consumed
                    },
                )
                .pointerInput(page) {
                    detectTapGestures { offset ->
                        val x = offset.x / scale
                        val y = (offset.y + scrollY) / scale
                        val nodeId = page.hit(x, y)
                        if (nodeId >= 0) onActivate(nodeId, x.toDouble(), y.toDouble())
                    }
                },
        ) {
            val canvas = drawContext.canvas.nativeCanvas
            val top = scrollY / scale
            val bottom = (scrollY + viewportHeightPx) / scale
            canvas.save()
            canvas.translate(0f, -scrollY)
            canvas.scale(scale, scale)
            for (op in page.opsIn(top, bottom)) {
                // overflowで切れる分はサーバーが枠を載せてくる
                val clipped = op.cl.size == 4
                if (clipped) {
                    canvas.save()
                    canvas.clipRect(op.cl[0], op.cl[1], op.cl[0] + op.cl[2], op.cl[1] + op.cl[3])
                }
                when (op.t) {
                    0 -> drawBox(canvas, paint, page, op)
                    1 -> drawText(canvas, paint, page, op)
                    2 -> {
                        val hash = page.assets[op.i]
                        val bitmap = hash?.let { tiles.raw(it) }
                        if (bitmap != null) {
                            canvas.drawBitmap(bitmap, null, rectOf(op), null)
                        } else {
                            if (hash == null && !wanted.contains(op.i)) wanted.add(op.i)
                            paint.reset()
                            paint.color = 0x14000000
                            canvas.drawRect(rectOf(op), paint)
                        }
                    }
                }
                if (clipped) canvas.restore()
            }
            canvas.restore()
        }
    }
}

private val scratch = RectF()

private fun rectOf(op: DrawOp): RectF {
    scratch.set(op.b[0], op.b[1], op.b[0] + op.b[2], op.b[1] + op.b[3])
    return scratch
}

private fun drawBox(canvas: Canvas, paint: Paint, page: VectorPage, op: DrawOp) {
    val radius = op.r.maxOrNull() ?: 0f
    // 影は落とす形の不透明度から作られるので、塗りが無ければ出しようがない
    if (op.sh.size == 4 && op.f in page.colors.indices && op.sh[3].toInt() in page.colors.indices) {
        paint.reset()
        paint.isAntiAlias = true
        paint.color = page.colors[op.f]
        // ぼかし0はsetShadowLayerが受け付けない
        paint.setShadowLayer(
            op.sh[2].coerceAtLeast(0.1f),
            op.sh[0],
            op.sh[1],
            page.colors[op.sh[3].toInt()],
        )
        val r = rectOf(op)
        if (radius > 0f) canvas.drawRoundRect(r, radius, radius, paint) else canvas.drawRect(r, paint)
        paint.clearShadowLayer()
    }
    if (op.f in page.colors.indices) {
        paint.reset()
        paint.isAntiAlias = true
        paint.color = page.colors[op.f]
        val r = rectOf(op)
        if (radius > 0f) canvas.drawRoundRect(r, radius, radius, paint) else canvas.drawRect(r, paint)
    }
    if (op.k in page.colors.indices && op.kw > 0f) {
        paint.reset()
        paint.isAntiAlias = true
        paint.style = Paint.Style.STROKE
        paint.strokeWidth = op.kw
        paint.color = page.colors[op.k]
        // 枠線は箱の内側に描かれるので半分だけ内へ寄せる
        val h = op.kw / 2f
        val r = rectOf(op)
        r.set(r.left + h, r.top + h, r.right - h, r.bottom - h)
        if (radius > 0f) canvas.drawRoundRect(r, radius, radius, paint) else canvas.drawRect(r, paint)
    }
}

private fun drawText(canvas: Canvas, paint: Paint, page: VectorPage, op: DrawOp) {
    val font = page.list.fonts.getOrNull(op.fo) ?: return
    if (op.co !in page.colors.indices) return
    val size = font[0]
    val weight = font.getOrElse(1) { 400f }.toInt()
    val italic = font.getOrElse(2) { 0f } > 0f
    val family = font.getOrElse(3) { 0f }.toInt()
    val letterSpacing = font.getOrElse(4) { 0f }
    val ascent = font.getOrElse(5) { size * 0.8f }

    paint.reset()
    paint.isAntiAlias = true
    paint.color = page.colors[op.co]
    paint.textSize = size
    paint.typeface = typefaceOf(family, weight, italic)
    paint.letterSpacing = if (size > 0f) letterSpacing / size else 0f
    paint.isUnderlineText = op.u == 1
    // 書体が違えば同じ文字列でも幅が違う。行幅へ詰めて右端を合わせる
    val target = op.b[2]
    if (target > 0f) {
        val measured = paint.measureText(op.s)
        if (measured > 0f) paint.textScaleX = (target / measured).coerceIn(0.5f, 1.6f)
    }
    canvas.drawText(op.s, op.b[0], op.b[1] + ascent, paint)
}

private val typefaces = HashMap<Int, Typeface>()

private fun typefaceOf(family: Int, weight: Int, italic: Boolean): Typeface =
    typefaces.getOrPut(family * 10000 + weight * 10 + if (italic) 1 else 0) {
        val base = when (family) {
            1 -> Typeface.SERIF
            2 -> Typeface.MONOSPACE
            else -> Typeface.SANS_SERIF
        }
        Typeface.create(base, weight.coerceIn(100, 900), italic)
    }
