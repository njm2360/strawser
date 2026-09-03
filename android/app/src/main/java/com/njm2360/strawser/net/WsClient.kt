package com.njm2360.strawser.net

import android.util.Log
import android.util.LruCache
import kotlinx.serialization.SerializationException
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.math.min

/**
 * サーバーとの WebSocket 接続。
 * テキストフレームは JSON、バイナリフレームは直前の screenshotHeader に対応する画像。
 * 切断時は指数バックオフで自動再接続し、hello からやり直す。
 */
class WsClient(
    private val serverUrl: String,
    private val viewport: () -> ClientMsg.Viewport,
    private val onMessage: (ServerMsg) -> Unit,
    private val onTile: (pageId: String, tileIndex: Int, bytes: ByteArray) -> Unit,
    private val onLiveFrame: (header: ServerMsg.LiveFrameHeader, bytes: ByteArray) -> Unit,
    private val onConnectionChange: (connected: Boolean) -> Unit,
    private val onAuthError: () -> Unit,
    private val onSuperseded: () -> Unit,
) {
    companion object {
        private const val TAG = "WsClient"
        private const val CLOSE_UNAUTHORIZED = 4001
        private const val CLOSE_SUPERSEDED = 4002

        // 受信済みタイルを持っておく量。サーバーがtileRefを出す判断に使う記憶数より
        // 十分大きく取り、取りこぼしをrequestTilesの往復にしない
        private const val TILE_CACHE_BYTES = 16 * 1024 * 1024
    }

    /** 戻る・進むや、開いたメニューを閉じた直後は同じバイト列のタイルが再び要る */
    private val tileCache = object : LruCache<String, ByteArray>(TILE_CACHE_BYTES) {
        override fun sizeOf(key: String, value: ByteArray) = value.size
    }

    private val httpClient = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .build()
    private val reconnectExecutor = Executors.newSingleThreadScheduledExecutor()

    @Volatile private var ws: WebSocket? = null
    @Volatile private var closed = false
    @Volatile private var pendingHeader: ServerMsg? = null // TileHeader or LiveFrameHeader
    @Volatile private var retryCount = 0

    // close()と切れ目なく行う。間に割り込むと閉じ先の無いソケットが残って再接続し続ける
    @Synchronized
    fun connect() {
        if (closed) return
        val request = Request.Builder().url(serverUrl).build()
        ws = httpClient.newWebSocket(request, listener)
    }

    @Synchronized
    fun close() {
        closed = true
        ws?.close(1000, "bye")
        ws = null
        reconnectExecutor.shutdownNow()
        httpClient.dispatcher.executorService.shutdown()
    }

    fun send(msg: ClientMsg) {
        ws?.send(protocolJson.encodeToString(ClientMsg.serializer(), msg))
    }

    @Synchronized
    private fun scheduleReconnect() {
        if (closed) return
        onConnectionChange(false)
        val delayMs = min(30_000L, 1_000L shl min(retryCount, 5))
        retryCount++
        Log.i(TAG, "reconnecting in ${delayMs}ms")
        reconnectExecutor.schedule({ connect() }, delayMs, TimeUnit.MILLISECONDS)
    }

    /** 以後connect()は無視される */
    @Synchronized
    private fun stopReconnecting() {
        closed = true
        onConnectionChange(false)
    }

    private val listener = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            // TCP が開いただけでは「接続済み」にしない。
            // 認証拒否でも onOpen は来るため、helloAck 受信で初めて緑にする
            val v = viewport()
            send(ClientMsg.Hello(token = "", viewportW = v.width, viewportH = v.height, dpr = v.dpr))
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            val msg = try {
                protocolJson.decodeFromString(ServerMsg.serializer(), text)
            } catch (e: SerializationException) {
                Log.w(TAG, "unknown message: $text", e)
                return
            }
            Log.d(TAG, "<- $text")
            if (msg is ServerMsg.HelloAck) {
                retryCount = 0
                onConnectionChange(true)
            }
            if (msg is ServerMsg.TileHeader || msg is ServerMsg.LiveFrameHeader) {
                pendingHeader = msg
            }
            if (msg is ServerMsg.TileRef) {
                val cached = tileCache.get(msg.hash)
                if (cached != null) {
                    onTile(msg.pageId, msg.tileIndex, cached)
                } else {
                    Log.i(TAG, "tile " + msg.tileIndex + " cache miss (" + msg.hash + ")")
                    send(ClientMsg.RequestTiles(listOf(msg.tileIndex)))
                }
                return
            }
            onMessage(msg)
        }

        override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
            val header = pendingHeader ?: run {
                Log.w(TAG, "binary frame without header (${bytes.size} bytes)")
                return
            }
            pendingHeader = null
            when (header) {
                is ServerMsg.TileHeader -> {
                    Log.d(TAG, "<- binary tile ${header.tileIndex} (${bytes.size} bytes)")
                    val data = bytes.toByteArray()
                    tileCache.put(header.hash, data)
                    onTile(header.pageId, header.tileIndex, data)
                }
                is ServerMsg.LiveFrameHeader -> {
                    Log.d(TAG, "<- binary live frame (${bytes.size} bytes, scrollY ${header.scrollY})")
                    onLiveFrame(header, bytes.toByteArray())
                    send(ClientMsg.LiveAck) // 次フレームの送信許可
                }
                else -> Log.w(TAG, "binary frame with unexpected header: $header")
            }
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            Log.w(TAG, "ws failure", t)
            scheduleReconnect()
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            // これを返さないと close ハンドシェイクが完了せず、
            // サーバーからの切断コード（4001 等）が onClosed に届かない
            webSocket.close(code, null)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            Log.i(TAG, "ws closed: $code $reason")
            when (code) {
                // 認証エラーは再接続しても直らない
                CLOSE_UNAUTHORIZED -> {
                    stopReconnecting()
                    onAuthError()
                }
                CLOSE_SUPERSEDED -> {
                    stopReconnecting()
                    onSuperseded()
                }
                else -> scheduleReconnect()
            }
        }
    }
}
