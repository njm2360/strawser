package com.njm2360.strawser

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.njm2360.strawser.ui.BrowserScreen
import com.njm2360.strawser.ui.SettingsDialog
import com.njm2360.strawser.ui.theme.StrawserTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            StrawserTheme {
                Scaffold(modifier = Modifier.fillMaxSize()) { innerPadding ->
                    AppRoot(modifier = Modifier.padding(innerPadding))
                }
            }
        }
    }
}

@Composable
private fun AppRoot(modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val prefs = remember { Settings.prefs(context) }
    var settings by remember { mutableStateOf(Settings.load(prefs)) }
    // 設定を保存し直したときは接続先が同じでも張り直す
    var connectGeneration by remember { mutableStateOf(0) }
    var showSettings by remember { mutableStateOf(!settings.isConfigured) }
    var settingsError by remember { mutableStateOf<String?>(null) }

    Box(modifier = modifier.fillMaxSize()) {
        if (settings.isConfigured) {
            key(connectGeneration, settings.connectUrl()) {
                BrowserScreen(
                    serverUrl = settings.connectUrl(),
                    searchEngine = settings.searchEngine,
                    tileCacheBytes = settings.tileCacheBytes,
                    onOpenSettings = {
                        settingsError = null
                        showSettings = true
                    },
                    onAuthError = {
                        settingsError = "認証エラー: トークンを確認してください"
                        showSettings = true
                    },
                    modifier = Modifier.fillMaxSize(),
                )
            }
        } else {
            UnconfiguredScreen(onOpenSettings = { showSettings = true })
        }
        if (showSettings) {
            SettingsDialog(
                initial = settings,
                errorText = settingsError,
                onDismiss = { showSettings = false },
                onSave = { saved ->
                    saved.save(prefs)
                    // 検索エンジンだけの変更なら張り直さない（キャッシュも保つ）
                    val searchEngineOnly = saved.copy(searchEngine = settings.searchEngine) ==
                        settings && saved.searchEngine != settings.searchEngine
                    settings = saved
                    if (!searchEngineOnly) connectGeneration++
                    settingsError = null
                    showSettings = false
                },
            )
        }
    }
}

@Composable
private fun UnconfiguredScreen(onOpenSettings: () -> Unit) {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(16.dp, alignment = Alignment.CenterVertically),
        modifier = Modifier
            .fillMaxSize()
            .padding(24.dp),
    ) {
        Text("接続先が設定されていません")
        Button(onClick = onOpenSettings) { Text("接続設定を開く") }
    }
}
