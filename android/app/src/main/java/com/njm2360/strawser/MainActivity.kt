package com.njm2360.strawser

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Scaffold
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import com.njm2360.strawser.ui.AppRoot
import com.njm2360.strawser.ui.theme.StrawserTheme

// 共有されるテキストはURLの前にタイトルが付いていることがある
private val URL_IN_TEXT = Regex("https?://\\S+")

class MainActivity : ComponentActivity() {
    private var openInput by mutableStateOf<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // 再生成でも同じIntentが渡ってくる
        if (savedInstanceState == null) openInput = openInputOf(intent)
        enableEdgeToEdge()
        setContent {
            StrawserTheme {
                Scaffold(modifier = Modifier.fillMaxSize()) { innerPadding ->
                    AppRoot(
                        openInput = openInput,
                        onOpened = { openInput = null },
                        modifier = Modifier.padding(innerPadding),
                    )
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        openInput = openInputOf(intent)
    }
}

/** URLとは限らない。ただの文字列ならresolveInputが検索語にする */
private fun openInputOf(intent: Intent): String? {
    val text = when (intent.action) {
        Intent.ACTION_VIEW -> intent.dataString
        // 装飾付きの文字列で渡すアプリがあり、getStringExtraでは取れない
        Intent.ACTION_SEND -> intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()
            ?.let { URL_IN_TEXT.find(it)?.value ?: it }
        else -> null
    }
    return text?.takeIf { it.isNotBlank() }
}
