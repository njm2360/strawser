package com.njm2360.strawser.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Shader
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
import androidx.compose.foundation.layout.offset
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import com.njm2360.strawser.net.DisplayList
import com.njm2360.strawser.net.DrawOp
import com.njm2360.strawser.net.ServerMsg
import com.njm2360.strawser.net.TileStore
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.conflate
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.roundToInt
import kotlin.math.sin

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

    private val bands: Map<Int, List<Int>> =
        list.ops.indices.filter { list.ops[it].pn < 0f }
            .groupBy { (list.ops[it].b[1] / BAND).toInt() }

    /** 画面に貼り付くop。スクロールで動くので帯に入れられない */
    private val pinned: List<Int> = list.ops.indices.filter { list.ops[it].pn >= 0f }

    /**
     * 高い矩形が上の帯から垂れてくるので、band4つぶん余分に見る。
     * 帯ごとに拾うと表示リストの並びから外れる。重ね順はこの並びなので戻してから返す
     */
    fun indicesIn(top: Float, bottom: Float): Sequence<Int> {
        val from = max(0, (top / BAND).toInt() - 4)
        val to = (bottom / BAND).toInt()
        val out = ArrayList<Int>()
        for (band in from..to) {
            for (i in bands[band].orEmpty()) {
                val op = list.ops[i]
                if (op.b[1] < bottom && op.b[1] + op.b[3] > top) out.add(i)
            }
        }
        out.addAll(pinned)
        out.sort()
        return out.asSequence()
    }

    fun opsIn(top: Float, bottom: Float): Sequence<DrawOp> =
        indicesIn(top, bottom).map { list.ops[it] }

    /** 貼り付いたopを下へ運ぶ距離。scrollYはページ座標 */
    fun pinShift(op: DrawOp, scrollY: Float): Float =
        if (op.pn < 0f) 0f else minOf(scrollY, op.pn)

    /** 押された位置の要素。手前に描かれたものが勝つ */
    fun hit(x: Float, y: Float, scrollY: Float): DrawOp? {
        var found: DrawOp? = null
        for (op in opsIn(y - 1f, y + 1f)) {
            if (op.a < 0) continue
            val dy = pinShift(op, scrollY)
            if (x >= op.b[0] && x <= op.b[0] + op.b[2] &&
                y >= op.b[1] + dy && y <= op.b[1] + op.b[3] + dy
            ) {
                found = op
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
    onRequestAssets: (nodeIds: List<Int>, raw: Boolean) -> Unit,
    onScrollPos: (listId: String, y: Int) -> Unit,
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
        // 差分で表示リストが差し替わっても倍率と横位置は保つ。
        // 横位置は表示px基準なので、回転で幅が変われば捨てる
        var zoom by remember(page.viewKey, viewportPx) { mutableFloatStateOf(MIN_ZOOM) }
        var panPx by remember(page.viewKey, viewportPx) { mutableFloatStateOf(0f) } // 常に0以下
        // 倍率1.0で1 CSS px = 1 dpになる
        val scale = viewportPx * zoom / page.list.pageWidth
        val maxScroll = max(0f, page.list.fullHeight * scale - viewportHeightPx)
        var scrollY by remember(page) {
            mutableFloatStateOf((page.scrollY * scale).coerceIn(0f, maxScroll))
        }
        // 当たり判定とscrollPosはこの倍率経由。ピンチのたびに貼り直さないpointerInputと
        // snapshotFlowからはこちらを読む
        val curScale by rememberUpdatedState(scale)

        // 差分が届くと行の番号が変わるので持ち越さない
        val measure = remember { Paint(Paint.ANTI_ALIAS_FLAG) }
        var anchor by remember(page) { mutableStateOf<TextPos?>(null) }
        var focus by remember(page) { mutableStateOf<TextPos?>(null) }
        // 長押しで選んだ一語。指がそこから出るまでは語のまま保つ
        var word by remember(page) { mutableStateOf<Pair<TextPos, TextPos>?>(null) }
        val selection = anchor?.let { a -> focus?.let { f -> if (a <= f) a to f else f to a } }
        val selRects = remember(page, selection) {
            selection?.let { page.selectionRects(it.first, it.second, measure) }.orEmpty()
        }
        val handles = selRects.firstOrNull()?.let { first ->
            val last = selRects.last()
            Offset(first.left * scale + panPx, first.bottom * scale - scrollY) to
                Offset(last.right * scale + panPx, last.bottom * scale - scrollY)
        }
        val liveHandles by rememberUpdatedState(handles)
        val handleRadius = with(LocalDensity.current) { 9.dp.toPx() }
        val grabRadius = with(LocalDensity.current) { 24.dp.toPx() }
        val gapPx = with(LocalDensity.current) { 8.dp.toPx() }
        val highlight = MaterialTheme.colorScheme.primary.copy(alpha = 0.3f).toArgb()
        val handleColor = MaterialTheme.colorScheme.primary
        val context = LocalContext.current
        fun pagePoint(at: Offset) = Offset((at.x - panPx) / curScale, (at.y + scrollY) / curScale)

        val wanted = remember(page) { mutableStateListOf<Int>() }
        // hashは持っているのにバイト列が落ちたもの。assetRefで返されると灰色のまま戻らない
        val lost = remember(page) { mutableStateListOf<Int>() }
        val request by rememberUpdatedState(onRequestAssets)
        LaunchedEffect(page) {
            while (true) {
                delay(ASSET_BATCH_MS)
                for (queue in listOf(wanted, lost)) {
                    if (queue.isEmpty()) continue
                    val batch = queue.toList()
                    queue.clear()
                    request(batch, queue === lost)
                }
            }
        }

        // 読んでいる位置をサーバーへ通知する。無限スクロールの継ぎ足しの判定に使う。
        // ズームだけでもページ座標は動くので、変換した後の値を見る
        val report by rememberUpdatedState(onScrollPos)
        LaunchedEffect(page) {
            snapshotFlow { (scrollY / curScale).toInt() }
                .conflate()
                .collect { y ->
                    report(page.listId, y)
                    delay(300)
                }
        }

        val paint = remember { Paint(Paint.ANTI_ALIAS_FLAG) }
        ComposeCanvas(
            modifier = Modifier
                .fillMaxSize()
                .background(Color(page.bgColor))
                // 二本目の指を縦スクロールとタップに取られないよう、両者より先に置く。
                // 倍率はこのなかで変わるので、外で計算したscaleは使えない
                .pointerInput(page) {
                    detectPinch { centroid, zoomChange, panChange ->
                        val next = (zoom * zoomChange).coerceIn(MIN_ZOOM, MAX_ZOOM)
                        val grow = next / zoom
                        val nextScale = viewportPx * next / page.list.pageWidth
                        // ピンチ中心の下にあるページ上の点を動かさない
                        panPx = (centroid.x - (centroid.x - panPx) * grow + panChange.x)
                            .coerceIn(-viewportPx * (next - 1f), 0f)
                        val limit = max(0f, page.list.fullHeight * nextScale - viewportHeightPx)
                        scrollY = ((centroid.y + scrollY) * grow - centroid.y - panChange.y)
                            .coerceIn(0f, limit)
                        zoom = next
                        page.scrollY = scrollY / nextScale
                    }
                }
                // 長押しを取り逃がすとスクロールに化けるので、スクロールより先に置く
                .pointerInput(page) {
                    detectTextSelect(
                        onHandle = { at ->
                            val ends = liveHandles
                            val a = anchor
                            val f = focus
                            if (ends == null || a == null || f == null) {
                                false
                            } else {
                                val toStart = (at - ends.first).getDistance()
                                val toEnd = (at - ends.second).getDistance()
                                val grabbed = minOf(toStart, toEnd) <= grabRadius
                                if (grabbed) {
                                    // 掴んだ側だけ動かす
                                    val head = if (a <= f) a else f
                                    val tail = if (a <= f) f else a
                                    anchor = if (toStart <= toEnd) tail else head
                                    focus = if (toStart <= toEnd) head else tail
                                    word = null
                                }
                                grabbed
                            }
                        },
                        onLongPress = { at ->
                            val point = pagePoint(at)
                            val hit = page.textAt(point.x, point.y, measure, inside = true)
                            if (hit != null) {
                                val picked = page.wordAt(hit)
                                word = picked
                                anchor = picked.first
                                focus = picked.second
                            }
                            hit != null
                        },
                        onDrag = { at ->
                            val point = pagePoint(at)
                            val to = page.textAt(point.x, point.y, measure) ?: return@detectTextSelect
                            val picked = word
                            when {
                                picked == null -> focus = to
                                to < picked.first -> {
                                    anchor = picked.second
                                    focus = to
                                }
                                to > picked.second -> {
                                    anchor = picked.first
                                    focus = to
                                }
                                else -> {
                                    anchor = picked.first
                                    focus = picked.second
                                }
                            }
                        },
                    )
                }
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
                        if (anchor != null) {
                            anchor = null
                            focus = null
                            return@detectTapGestures
                        }
                        val scroll = scrollY / curScale
                        val x = (offset.x - panPx) / curScale
                        val y = (offset.y + scrollY) / curScale
                        val op = page.hit(x, y, scroll) ?: return@detectTapGestures
                        // 実ページでの位置を送る。貼り付いたopはそこから運ばれている
                        onActivate(op.a, x.toDouble(), (y - page.pinShift(op, scroll)).toDouble())
                    }
                },
        ) {
            val canvas = drawContext.canvas.nativeCanvas
            val top = scrollY / scale
            val bottom = (scrollY + viewportHeightPx) / scale
            canvas.save()
            canvas.translate(panPx, -scrollY)
            canvas.scale(scale, scale)
            for (op in page.opsIn(top, bottom)) {
                val shift = page.pinShift(op, top)
                // overflowで切れる分はサーバーが枠を載せてくる
                val clipped = op.cl.size == 4
                if (shift != 0f || clipped) canvas.save()
                if (shift != 0f) canvas.translate(0f, shift)
                if (clipped) {
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
                            val queue = if (hash == null) wanted else lost
                            if (!queue.contains(op.i)) queue.add(op.i)
                            paint.reset()
                            paint.color = 0x14000000
                            canvas.drawRect(rectOf(op), paint)
                        }
                    }
                }
                if (shift != 0f || clipped) canvas.restore()
            }
            if (selRects.isNotEmpty()) {
                paint.reset()
                paint.color = highlight
                for (r in selRects) {
                    if (r.bottom >= top && r.top <= bottom) canvas.drawRect(r, paint)
                }
            }
            canvas.restore()
            handles?.let { (start, end) ->
                drawCircle(handleColor, handleRadius, start)
                drawCircle(handleColor, handleRadius, end)
            }
        }
        var barSize by remember(page) { mutableStateOf(IntSize.Zero) }
        val selTop = selRects.firstOrNull()?.let { it.top * scale - scrollY }
        val selBottom = selRects.lastOrNull()?.let { it.bottom * scale - scrollY }
        // 選択が画面から出たらバーも引っ込める
        if (selection != null && selTop != null && selBottom != null &&
            selBottom > 0f && selTop < viewportHeightPx
        ) {
            val center = (selRects.first().left + selRects.first().right) / 2f * scale + panPx
            val above = selTop - barSize.height - gapPx
            val below = selBottom + gapPx
            SelectionBar(
                onCopy = {
                    copyText(context, page.selectedText(selection.first, selection.second))
                    anchor = null
                    focus = null
                },
                modifier = Modifier
                    .onSizeChanged { barSize = it }
                    .offset {
                        IntOffset(
                            (center - barSize.width / 2f)
                                .coerceIn(0f, max(0f, viewportPx - barSize.width)).roundToInt(),
                            (if (above >= 0f) above else below)
                                .coerceIn(0f, max(0f, viewportHeightPx - barSize.height)).roundToInt(),
                        )
                    },
            )
        }
    }
}

@Composable
private fun SelectionBar(onCopy: () -> Unit, modifier: Modifier = Modifier) {
    Surface(
        modifier = modifier,
        shape = MaterialTheme.shapes.small,
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        shadowElevation = 3.dp,
    ) {
        TextButton(onClick = onCopy) { Text("コピー") }
    }
}

private fun copyText(context: Context, text: String) {
    val clipboard = context.getSystemService(ClipboardManager::class.java) ?: return
    clipboard.setPrimaryClip(ClipData.newPlainText("", text))
}

private val scratch = RectF()
private val scratchPath = Path()
private val scratchRadii = FloatArray(8)

private fun rectOf(op: DrawOp): RectF {
    scratch.set(op.b[0], op.b[1], op.b[0] + op.b[2], op.b[1] + op.b[3])
    return scratch
}

// op.rの4隅は上左・上右・下右・下左の順
private fun drawRounded(canvas: Canvas, paint: Paint, r: RectF, radii: List<Float>) {
    if (radii.size != 4 || radii.all { it == radii[0] }) {
        val radius = radii.firstOrNull() ?: 0f
        if (radius > 0f) canvas.drawRoundRect(r, radius, radius, paint) else canvas.drawRect(r, paint)
        return
    }
    for (i in 0..3) {
        scratchRadii[i * 2] = radii[i]
        scratchRadii[i * 2 + 1] = radii[i]
    }
    scratchPath.reset()
    scratchPath.addRoundRect(r, scratchRadii, Path.Direction.CW)
    canvas.drawPath(scratchPath, paint)
}

/** 勾配線は箱の中心を通り、両端は角を通る垂線との交点。角度は0が上向きで時計回り */
private fun drawGradient(canvas: Canvas, paint: Paint, page: VectorPage, op: DrawOp) {
    val count = (op.g.size - 1) / 2
    if (count < 2) return
    val colors = IntArray(count)
    val stops = FloatArray(count)
    for (i in 0 until count) {
        val c = op.g[1 + i * 2].toInt()
        if (c !in page.colors.indices) return
        colors[i] = page.colors[c]
        stops[i] = op.g[2 + i * 2]
    }
    val rad = Math.toRadians(op.g[0].toDouble())
    val dx = sin(rad).toFloat()
    val dy = -cos(rad).toFloat()
    val half = (abs(op.b[2] * dx) + abs(op.b[3] * dy)) / 2f
    val cx = op.b[0] + op.b[2] / 2f
    val cy = op.b[1] + op.b[3] / 2f
    paint.reset()
    paint.isAntiAlias = true
    paint.shader = LinearGradient(
        cx - dx * half,
        cy - dy * half,
        cx + dx * half,
        cy + dy * half,
        colors,
        stops,
        Shader.TileMode.CLAMP,
    )
    drawRounded(canvas, paint, rectOf(op), op.r)
    paint.shader = null
}

private fun drawBox(canvas: Canvas, paint: Paint, page: VectorPage, op: DrawOp) {
    if (op.g.isNotEmpty()) {
        drawGradient(canvas, paint, page, op)
        return
    }
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
        drawRounded(canvas, paint, rectOf(op), op.r)
        paint.clearShadowLayer()
    }
    if (op.f in page.colors.indices) {
        paint.reset()
        paint.isAntiAlias = true
        paint.color = page.colors[op.f]
        drawRounded(canvas, paint, rectOf(op), op.r)
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
        drawRounded(canvas, paint, r, op.r)
    }
}

/** 文字の位置を測るときも同じ設定を通す。falseなら描かない行 */
internal fun textPaint(paint: Paint, page: VectorPage, op: DrawOp): Boolean {
    val font = page.list.fonts.getOrNull(op.fo) ?: return false
    if (op.co !in page.colors.indices) return false
    val size = font[0]
    val letterSpacing = font.getOrElse(4) { 0f }

    paint.reset()
    paint.isAntiAlias = true
    paint.color = page.colors[op.co]
    paint.textSize = size
    paint.typeface = typefaceOf(
        family = font.getOrElse(3) { 0f }.toInt(),
        weight = font.getOrElse(1) { 400f }.toInt(),
        italic = font.getOrElse(2) { 0f } > 0f,
    )
    paint.letterSpacing = if (size > 0f) letterSpacing / size else 0f
    paint.isUnderlineText = (op.u and 1) != 0
    paint.isStrikeThruText = (op.u and 2) != 0
    // 書体が違えば同じ文字列でも幅が違う。行幅へ詰めて右端を合わせる
    val target = op.b[2]
    if (target > 0f) {
        val measured = paint.measureText(op.s)
        if (measured > 0f) paint.textScaleX = (target / measured).coerceIn(0.5f, 1.6f)
    }
    return true
}

private fun drawText(canvas: Canvas, paint: Paint, page: VectorPage, op: DrawOp) {
    if (!textPaint(paint, page, op)) return
    val font = page.list.fonts[op.fo]
    val ascent = font.getOrElse(5) { font[0] * 0.8f }
    val shadowed = op.sh.size == 4 && op.sh[3].toInt() in page.colors.indices
    // ぼかし0はsetShadowLayerが受け付けない
    if (shadowed) {
        paint.setShadowLayer(
            op.sh[2].coerceAtLeast(0.1f),
            op.sh[0],
            op.sh[1],
            page.colors[op.sh[3].toInt()],
        )
    }
    canvas.drawText(op.s, op.b[0], op.b[1] + ascent, paint)
    if (shadowed) paint.clearShadowLayer()
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
