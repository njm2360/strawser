import { getViewport, getActiveTab, getActiveTabId, type Tab } from "./browser.ts";
import { showDialog } from "./dialogs.ts";
import { startScreencast, pushLiveFrame } from "./modes/live.ts";
import { setCurrent, captureAndSend, current, pages } from "./modes/page.ts";
import {
  lists,
  currentList,
  clearCurrentList,
  extractAndSend,
  extractLoaded,
} from "./modes/vector.ts";
import { mode, setPageLoading, bumpNavGen } from "./state.ts";
import { sendTabs, sendNavState } from "./status.ts";
import { send } from "./wire.ts";

// ---- タブ ----

// キャプチャ状態もライブのscreencastも表示中タブの分しか持たないので、
// 背景タブのイベントはidで弾く
export let shownTabId = "";

export function setShownTab(id: string): void {
  shownTabId = id;
}

export async function activateTab(previous: Tab | undefined): Promise<void> {
  if (previous && mode === "live") {
    await previous.cdp.send("Page.stopScreencast").catch(() => {});
  }
  shownTabId = getActiveTabId();
  setCurrent(undefined);
  setPageLoading(false);
  bumpNavGen();
  const view = getViewport();
  await getActiveTab()
    .page.setViewportSize({ width: view.width, height: view.height })
    .catch(() => {});
  sendTabs();
  await sendNavState(false);
  if (mode === "live") await startScreencast();
  else if (mode === "vector") await extractAndSend();
  else await captureAndSend();
}

export function attachTab(tab: Tab): void {
  // ライブモード: Chromeへは即Ackして生成を止めず、常に最新フレームだけを保持。
  // クライアントへはliveAckが返ってくるまで次を送らない（1枚ずつ、古いフレームは捨てる）
  tab.cdp.on("Page.screencastFrame", (params) => {
    void tab.cdp.send("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => {});
    if (tab.id !== getActiveTabId()) return;
    pushLiveFrame(Buffer.from(params.data, "base64"), Math.round(params.metadata.scrollOffsetY));
  });

  tab.page.on("dialog", showDialog);

  // 同一ドキュメント遷移（pushState等）ではloadが来ないため、framenavigatedが張る安全弁
  let loadingTimeout: NodeJS.Timeout | undefined;

  tab.page.on("load", () => {
    clearTimeout(loadingTimeout);
    tab.url = tab.page.url();
    void tab.page
      .title()
      .then((title) => {
        tab.title = title;
        sendTabs();
      })
      .catch(() => {});
    if (tab.id !== getActiveTabId()) return;
    setPageLoading(false);
    void sendNavState(false);
    send({ type: "focus", kind: "none" }); // 新しいページにフォーカスは残らない
    if (mode === "page") void captureAndSend();
    else if (mode === "vector") void extractLoaded();
  });

  tab.page.on("framenavigated", (frame) => {
    if (frame !== tab.page.mainFrame()) return;
    tab.url = frame.url();
    sendTabs();
    if (tab.id !== getActiveTabId()) return;
    setPageLoading(true);
    bumpNavGen();
    // リンクタップ等での遷移でも旧ページの未送信タイルを破棄する
    current?.pending.clear();
    // loadが来なければ誰も撮り直さないので、ここで撮り直す
    clearTimeout(loadingTimeout);
    loadingTimeout = setTimeout(() => {
      setPageLoading(false);
      if (mode === "page") void captureAndSend();
      else if (mode === "vector") void extractLoaded();
    }, 5000);
    void sendNavState(true);
  });

  // 一覧からの除去はbrowser.ts側で済んでいる
  tab.page.on("close", () => {
    for (const [key, cached] of pages) {
      if (cached.viewKey.startsWith(`${tab.id}:`)) pages.delete(key);
    }
    for (const key of lists.keys()) {
      if (key.startsWith(`${tab.id}:`)) lists.delete(key);
    }
    if (currentList?.viewKey.startsWith(`${tab.id}:`)) clearCurrentList();
    sendTabs();
    if (getActiveTabId() !== shownTabId) void activateTab(undefined);
  });
}
