package com.njm2360.strawser.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import com.njm2360.strawser.net.ServerMsg

@Composable
internal fun UrlBar(
    urlInput: String,
    onUrlChange: (String) -> Unit,
    navState: ServerMsg.NavState?,
    connected: Boolean,
    liveMode: Boolean,
    tabCount: Int,
    onOpenSettings: () -> Unit,
    onNavigate: (String) -> Unit,
    onShowTabs: () -> Unit,
    onNewTab: () -> Unit,
    onBack: () -> Unit,
    onForward: () -> Unit,
    onReload: () -> Unit,
    onToggleLive: () -> Unit,
) {
    val focusManager = LocalFocusManager.current
    val keyboardController = LocalSoftwareKeyboardController.current
    val urlFocusRequester = remember { FocusRequester() }
    var menuOpen by remember { mutableStateOf(false) }
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 4.dp),
    ) {
        OutlinedTextField(
            value = urlInput,
            onValueChange = onUrlChange,
            singleLine = true,
            placeholder = { Text("URL") },
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Go),
            keyboardActions = KeyboardActions(onGo = {
                if (urlInput.isNotBlank()) onNavigate(urlInput.trim())
                focusManager.clearFocus()
                keyboardController?.hide()
            }),
            leadingIcon = {
                Box(
                    modifier = Modifier
                        .size(8.dp)
                        .background(
                            color = if (connected) Color(0xFF4CAF50) else Color(0xFFF44336),
                            shape = CircleShape,
                        ),
                )
            },
            trailingIcon = {
                if (urlInput.isNotEmpty()) {
                    // クリア後そのまま打てるようにフォーカスも与える
                    TextButton(onClick = {
                        onUrlChange("")
                        urlFocusRequester.requestFocus()
                    }) { Text("✕") }
                }
            },
            textStyle = MaterialTheme.typography.bodySmall,
            modifier = Modifier
                .weight(1f)
                .focusRequester(urlFocusRequester),
        )
        TabCountButton(count = tabCount, onClick = onShowTabs)
        Box {
            BarButton("⋮", { menuOpen = true })
            DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                Row(horizontalArrangement = Arrangement.SpaceEvenly, modifier = Modifier.fillMaxWidth()) {
                    BarButton("←", { menuOpen = false; onBack() }, navState?.canGoBack == true)
                    BarButton("→", { menuOpen = false; onForward() }, navState?.canGoForward == true)
                    BarButton("⟳", { menuOpen = false; onReload() }, connected)
                }
                HorizontalDivider()
                DropdownMenuItem(
                    text = { Text("新しいタブ") },
                    onClick = { menuOpen = false; onNewTab() },
                )
                DropdownMenuItem(
                    text = { Text("タブ一覧（$tabCount）") },
                    onClick = { menuOpen = false; onShowTabs() },
                )
                // 動画やアニメーションはタイル配信では追えないのでスクリーンキャストへ切り替える
                DropdownMenuItem(
                    text = { Text(if (liveMode) "LIVE表示をやめる" else "LIVE表示") },
                    enabled = connected,
                    onClick = { menuOpen = false; onToggleLive() },
                )
                HorizontalDivider()
                DropdownMenuItem(
                    text = { Text("接続設定") },
                    onClick = { menuOpen = false; onOpenSettings() },
                )
            }
        }
    }
}

@Composable
private fun TabCountButton(count: Int, onClick: () -> Unit) {
    Box(
        contentAlignment = Alignment.Center,
        modifier = Modifier
            .size(40.dp)
            .clip(MaterialTheme.shapes.small)
            .clickable(onClick = onClick),
    ) {
        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier
                .size(22.dp)
                .border(2.dp, MaterialTheme.colorScheme.outline, RoundedCornerShape(5.dp)),
        ) {
            Text(
                text = if (count > 99) "∞" else count.toString(),
                color = MaterialTheme.colorScheme.outline,
                style = MaterialTheme.typography.labelSmall,
            )
        }
    }
}
