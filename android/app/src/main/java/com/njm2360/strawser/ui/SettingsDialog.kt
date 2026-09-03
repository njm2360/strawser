package com.njm2360.strawser.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.njm2360.strawser.SearchEngine
import com.njm2360.strawser.Settings

@Composable
fun SettingsDialog(
    initial: Settings,
    onSave: (Settings) -> Unit,
    onDismiss: () -> Unit,
    errorText: String? = null,
) {
    var serverUrl by rememberSaveable {
        mutableStateOf(initial.serverUrl.ifBlank { Settings.DEFAULT_SERVER_URL })
    }
    var token by rememberSaveable { mutableStateOf(initial.token) }
    // プロセス再生成をまたぐので、確実に保存できる名前で持つ
    var engineName by rememberSaveable { mutableStateOf(initial.searchEngine.name) }
    var engineMenuOpen by remember { mutableStateOf(false) }
    val searchEngine = SearchEngine.of(engineName)

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("接続設定") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                errorText?.let {
                    Text(
                        text = it,
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodySmall,
                    )
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
                Box {
                    OutlinedButton(
                        onClick = { engineMenuOpen = true },
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text("検索エンジン: ${searchEngine.label}")
                    }
                    DropdownMenu(
                        expanded = engineMenuOpen,
                        onDismissRequest = { engineMenuOpen = false },
                    ) {
                        SearchEngine.entries.forEach { engine ->
                            DropdownMenuItem(
                                text = { Text(engine.label) },
                                onClick = {
                                    engineName = engine.name
                                    engineMenuOpen = false
                                },
                            )
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(
                onClick = { onSave(Settings(serverUrl.trim(), token.trim(), searchEngine)) },
                enabled = serverUrl.isNotBlank() && token.isNotBlank(),
            ) { Text("保存して接続") }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("キャンセル") }
        },
    )
}
