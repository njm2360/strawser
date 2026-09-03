package com.njm2360.strawser.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.njm2360.strawser.decodeUrlForDisplay
import com.njm2360.strawser.net.ServerMsg

@Composable
internal fun TabListOverlay(
    tabs: List<ServerMsg.TabInfo>,
    activeTabId: String,
    onSelect: (String) -> Unit,
    onCloseTab: (String) -> Unit,
    onNewTab: () -> Unit,
    onDismiss: () -> Unit,
) {
    Surface(modifier = Modifier.fillMaxSize()) {
        Column(modifier = Modifier.fillMaxSize()) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 12.dp, vertical = 6.dp),
            ) {
                Text(
                    text = "タブ",
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.weight(1f),
                )
                BarButton("＋", onNewTab)
                BarButton("✕", onDismiss)
            }
            HorizontalDivider()
            LazyColumn(modifier = Modifier.weight(1f)) {
                items(tabs, key = { it.id }) { tab ->
                    TabListRow(
                        tab = tab,
                        active = tab.id == activeTabId,
                        onSelect = { onSelect(tab.id) },
                        onClose = { onCloseTab(tab.id) },
                    )
                }
            }
        }
    }
}

@Composable
private fun TabListRow(
    tab: ServerMsg.TabInfo,
    active: Boolean,
    onSelect: () -> Unit,
    onClose: () -> Unit,
) {
    val blank = tab.url.isBlank() || tab.url == "about:blank"
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .background(
                if (active) MaterialTheme.colorScheme.surfaceVariant else Color.Transparent,
            )
            .clickable(onClick = onSelect)
            .padding(start = 16.dp, top = 8.dp, bottom = 8.dp),
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = tab.title.ifBlank { "新しいタブ" },
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                style = MaterialTheme.typography.bodyMedium,
            )
            if (!blank) {
                Text(
                    text = decodeUrlForDisplay(tab.url),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    color = MaterialTheme.colorScheme.outline,
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        }
        BarButton("✕", onClose, color = MaterialTheme.colorScheme.outline)
    }
}
