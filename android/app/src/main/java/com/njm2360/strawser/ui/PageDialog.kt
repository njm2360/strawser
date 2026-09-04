package com.njm2360.strawser.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.njm2360.strawser.net.ServerMsg

// beforeunloadの文面はブラウザが決める。ページが渡した文字列は届かない
private const val LEAVE_MESSAGE = "このページを離れますか。入力した内容は失われます"

@Composable
internal fun PageDialog(
    dialog: ServerMsg.Dialog,
    onAnswer: (accept: Boolean, text: String) -> Unit,
) {
    var input by remember(dialog.id) { mutableStateOf(dialog.defaultValue) }
    AlertDialog(
        onDismissRequest = { onAnswer(false, "") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(if (dialog.kind == "beforeunload") LEAVE_MESSAGE else dialog.message)
                if (dialog.kind == "prompt") {
                    OutlinedTextField(
                        value = input,
                        onValueChange = { input = it },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
        },
        confirmButton = {
            TextButton(onClick = { onAnswer(true, input) }) { Text("OK") }
        },
        dismissButton = if (dialog.kind == "alert") {
            null
        } else {
            { TextButton(onClick = { onAnswer(false, "") }) { Text("キャンセル") } }
        },
    )
}
