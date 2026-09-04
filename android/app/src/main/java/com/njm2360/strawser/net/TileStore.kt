package com.njm2360.strawser.net

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.LruCache
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import java.util.UUID

/**
 * WebPのバイト列はページをまたいでhashで共有する。戻る・進むやタブ切替では
 * pageBeginが渡すhashだけで画面が埋まる。サーバーは同じ容量で同じ順に捨てて手元を推定する。
 *
 * 復号したImageBitmapはバイト列の20倍以上になるため別枠で持つ。長いページのタイルを
 * すべて抱えるとヒープが尽きるので、表示に要るぶんだけ復号して使い回す。
 */
class TileStore(val byteLimit: Int) {
    // 接続が切れてもキャッシュは残る。再接続で同じidを名乗れば送信済みの記憶が引き継がれる
    val cacheId: String = UUID.randomUUID().toString()

    private val bytes = object : LruCache<String, ByteArray>(byteLimit) {
        override fun sizeOf(key: String, value: ByteArray) = value.size
    }

    private val bitmaps = object : LruCache<String, ImageBitmap>(bitmapLimit()) {
        override fun sizeOf(key: String, value: ImageBitmap) = value.width * value.height * 4
    }

    // domモードはCanvasへ直に描くのでandroid.graphics.Bitmapが要る
    private val natives = object : LruCache<String, Bitmap>(bitmapLimit()) {
        override fun sizeOf(key: String, value: Bitmap) = value.byteCount
    }

    fun put(hash: String, data: ByteArray) {
        bytes.put(hash, data)
    }

    fun has(hash: String): Boolean = bytes.get(hash) != null

    /** 復号済みならすぐ返す。コンポジションから触れるのはこちらだけ */
    fun peek(hash: String): ImageBitmap? = bitmaps.get(hash)

    /** 復号は数ミリ秒かかるので、呼び出し側でメインスレッドから外すこと */
    fun bitmap(hash: String): ImageBitmap? {
        bitmaps.get(hash)?.let { return it }
        val data = bytes.get(hash) ?: return null
        val decoded = BitmapFactory.decodeByteArray(data, 0, data.size)?.asImageBitmap()
            ?: return null
        bitmaps.put(hash, decoded)
        return decoded
    }

    /** 復号済みのandroid Bitmap。描画スレッドから呼ばれる */
    fun raw(hash: String): Bitmap? {
        natives.get(hash)?.let { return it }
        val data = bytes.get(hash) ?: return null
        val decoded = BitmapFactory.decodeByteArray(data, 0, data.size) ?: return null
        natives.put(hash, decoded)
        return decoded
    }

    private companion object {
        // 復号済みタイルはヒープを直に食うので上限の1/4までに留める
        fun bitmapLimit(): Int =
            (Runtime.getRuntime().maxMemory() / 4).coerceIn(16L shl 20, 128L shl 20).toInt()
    }
}
