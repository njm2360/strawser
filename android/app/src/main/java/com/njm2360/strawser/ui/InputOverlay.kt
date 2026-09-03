package com.njm2360.strawser.ui

import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp

/**
 * リモート入力欄フォーカス時のIMEオーバーレイ。
 * ローカルで文字を確定してからinsertTextでまとめて送る（リモート画面に入力途中は映らない）
 */
@Composable
internal fun InputOverlay(
    onInsert: (String) -> Unit,
    onEnter: () -> Unit,
    onBackspace: () -> Unit,
    onClose: () -> Unit,
) {
    var text by remember { mutableStateOf("") }
    val focusRequester = remember { FocusRequester() }
    val keyboardController = LocalSoftwareKeyboardController.current
    LaunchedEffect(Unit) { focusRequester.requestFocus() }

    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 4.dp),
    ) {
        OutlinedTextField(
            value = text,
            onValueChange = { text = it },
            placeholder = { Text("リモート入力") },
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
            keyboardActions = KeyboardActions(onSend = {
                if (text.isNotEmpty()) {
                    onInsert(text)
                    text = ""
                }
            }),
            textStyle = MaterialTheme.typography.bodySmall,
            modifier = Modifier
                .weight(1f)
                .focusRequester(focusRequester),
        )
        // 未送信テキストを送ってからEnter（検索実行など）
        TextButton(onClick = {
            if (text.isNotEmpty()) {
                onInsert(text)
                text = ""
            }
            onEnter()
        }) { Text("⏎") }
        TextButton(onClick = onBackspace) { Text("⌫") }
        TextButton(onClick = {
            keyboardController?.hide()
            onClose()
        }) { Text("✕") }
    }
}
