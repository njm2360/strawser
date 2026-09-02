package com.njm2360.strawser

import android.content.Context
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.njm2360.strawser.ui.BrowserScreen
import com.njm2360.strawser.ui.theme.StrawserTheme
import java.net.URLEncoder

// 接続画面の初期値。実際の接続先は入力欄で上書きされ SharedPreferences に残る
private const val DEFAULT_SERVER_URL = "ws://192.168.1.100:8080"

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            StrawserTheme {
                Scaffold(modifier = Modifier.fillMaxSize()) { innerPadding ->
                    var connectedUrl by remember { mutableStateOf<String?>(null) }
                    var authError by remember { mutableStateOf(false) }
                    val url = connectedUrl
                    if (url == null) {
                        ConnectScreen(
                            errorText = if (authError) "認証エラー: トークンを確認してください" else null,
                            onConnect = {
                                authError = false
                                connectedUrl = it
                            },
                            modifier = Modifier.padding(innerPadding),
                        )
                    } else {
                        BrowserScreen(
                            serverUrl = url,
                            onAuthError = {
                                authError = true
                                connectedUrl = null
                            },
                            modifier = Modifier.padding(innerPadding),
                        )
                    }
                }
            }
        }
    }
}

@Composable
fun ConnectScreen(
    onConnect: (String) -> Unit,
    modifier: Modifier = Modifier,
    errorText: String? = null,
) {
    val context = LocalContext.current
    val prefs = remember { context.getSharedPreferences("settings", Context.MODE_PRIVATE) }
    var serverUrl by rememberSaveable {
        mutableStateOf(prefs.getString("serverUrl", DEFAULT_SERVER_URL) ?: DEFAULT_SERVER_URL)
    }
    var token by rememberSaveable { mutableStateOf(prefs.getString("token", "") ?: "") }

    Column(
        verticalArrangement = Arrangement.spacedBy(16.dp, alignment = Alignment.CenterVertically),
        modifier = modifier
            .fillMaxSize()
            .padding(24.dp),
    ) {
        Text("接続先サーバー")
        errorText?.let {
            Text(it, color = androidx.compose.material3.MaterialTheme.colorScheme.error)
        }
        OutlinedTextField(
            value = serverUrl,
            onValueChange = { serverUrl = it },
            singleLine = true,
            label = { Text("ws://host:port") },
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = token,
            onValueChange = { token = it },
            singleLine = true,
            label = { Text("トークン") },
            modifier = Modifier.fillMaxWidth(),
        )
        Button(
            onClick = {
                prefs.edit().putString("serverUrl", serverUrl.trim()).putString("token", token.trim()).apply()
                val base = serverUrl.trim().trimEnd('/')
                val query = "?token=" + URLEncoder.encode(token.trim(), "UTF-8")
                onConnect(base + "/" + query)
            },
            enabled = serverUrl.isNotBlank(),
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text("接続")
        }
    }
}
