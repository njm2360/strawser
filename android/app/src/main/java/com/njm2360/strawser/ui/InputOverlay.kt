package com.njm2360.strawser.ui

import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
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

    fun flush() {
        if (text.isNotEmpty()) {
            onInsert(text)
            text = ""
        }
    }

    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 6.dp),
    ) {
        PillField(
            value = text,
            onValueChange = { text = it },
            placeholder = "リモート入力",
            imeAction = ImeAction.Send,
            onAction = ::flush,
            modifier = Modifier
                .weight(1f)
                .focusRequester(focusRequester),
        )
        // 未送信テキストを送ってからEnter（検索実行など）
        BarButton("⏎", { flush(); onEnter() })
        BarButton("⌫", onBackspace)
        BarButton("✕", {
            keyboardController?.hide()
            onClose()
        })
    }
}
