package com.njm2360.strawser.net

import android.util.Log
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
    private val onMessage: (ServerMsg) -> Unit,
    private val onTile: (header: ServerMsg.TileHeader, bytes: ByteArray) -> Unit,
    private val onLiveFrame: (header: ServerMsg.LiveFrameHeader, bytes: ByteArray) -> Unit,
    private val onConnectionChange: (connected: Boolean) -> Unit,
    private val onAuthError: () -> Unit,
) {
    companion object {
        private const val TAG = "WsClient"
        private const val CLOSE_UNAUTHORIZED = 4001
    }

    private val httpClient = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .build()
    private val reconnectExecutor = Executors.newSingleThreadScheduledExecutor()

    @Volatile private var ws: WebSocket? = null
    @Volatile private var closed = false
    @Volatile private var pendingHeader: ServerMsg? = null // TileHeader or LiveFrameHeader
    @Volatile private var retryCount = 0

    fun connect() {
        if (closed) return
        val request = Request.Builder().url(serverUrl).build()
        ws = httpClient.newWebSocket(request, listener)
    }

    fun close() {
        closed = true
        ws?.close(1000, "bye")
        reconnectExecutor.shutdownNow()
        httpClient.dispatcher.executorService.shutdown()
    }

    fun send(msg: ClientMsg) {
        ws?.send(protocolJson.encodeToString(ClientMsg.serializer(), msg))
    }

    private fun scheduleReconnect() {
        if (closed) return
        onConnectionChange(false)
        val delayMs = min(30_000L, 1_000L shl min(retryCount, 5))
        retryCount++
        Log.i(TAG, "reconnecting in ${delayMs}ms")
        reconnectExecutor.schedule({ connect() }, delayMs, TimeUnit.MILLISECONDS)
    }

    private val listener = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            // TCP が開いただけでは「接続済み」にしない。
            // 認証拒否でも onOpen は来るため、helloAck 受信で初めて緑にする
            send(ClientMsg.Hello(token = "", viewportW = 720, viewportH = 1280))
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
                    onTile(header, bytes.toByteArray())
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
            if (code == CLOSE_UNAUTHORIZED) {
                // 認証エラーは再接続しても直らないので打ち切って通知する
                closed = true
                onConnectionChange(false)
                onAuthError()
                return
            }
            scheduleReconnect()
        }
    }
}
