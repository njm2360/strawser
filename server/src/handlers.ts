import { randomUUID } from "node:crypto";
import {
  getActivePage,
  getViewport,
  setViewport,
  clampViewport,
  getActiveTab,
  getActiveTabId,
  selectTab,
  openTab,
  closeTab,
} from "./browser.ts";
import {
  clientTiles,
  clientCacheId,
  clientCacheLimit,
  resetClientTiles,
  setClientCacheLimit,
} from "./clientCache.ts";
import { tap, longPress, insertText, pressKey } from "./input.ts";
import {
  startScreencast,
  trySendLiveFrame,
  setLiveFrameInFlight,
  clearLiveFrame,
  liveMetaScrollY,
} from "./modes/live.ts";
import { current, setCurrent, captureAndSend, maybeExtend, pumpTiles } from "./modes/page.ts";
import {
  currentList,
  lists,
  clearCurrentList,
  assetQueue,
  extractAndSend,
  pumpAssets,
  maybeExtendVector,
} from "./modes/vector.ts";
import { mode, setMode, pageLoading } from "./state.ts";
import { sendTabs, sendNavState, sendFocusState } from "./status.ts";
import { activateTab, shownTabId, setShownTab } from "./tabs.ts";
import { nodePoint } from "./vector.ts";
import { send, stripAnsi } from "./wire.ts";
import type { ClientMsg, Mode } from "./protocol.ts";

// 操作の後に画面を作り直す。遷移が始まっていたらload側のやり直しに任せる
// （レイアウト未完了ページを送って帯域を無駄にしない）。ライブ中はscreencastが映す
function scheduleRefresh(): void {
  setTimeout(() => {
    if (pageLoading) return;
    if (mode === "page") void captureAndSend();
    else if (mode === "vector") void extractAndSend();
  }, 600);
}

async function switchMode(next: Mode): Promise<void> {
  if (next === mode) return;
  const { cdp } = getActivePage();
  const prev = mode;
  setMode(next);
  if (prev === "live") {
    await cdp.send("Page.stopScreencast").catch(() => {});
    clearLiveFrame();
  }
  if (prev === "vector") {
    clearCurrentList();
    assetQueue.length = 0;
  }
  if (next === "live") await startScreencast();
  // vectorモードはタイルを持たない。抱えたままだと元PNGを掴み続ける
  else if (next === "vector") {
    setCurrent(undefined);
    await extractAndSend();
  } else void captureAndSend();
}

export async function handleMsg(msg: ClientMsg): Promise<void> {
  const { page } = getActivePage();
  switch (msg.type) {
    case "hello": {
      send({ type: "helloAck", ver: 1, sessionId: randomUUID() });
      // 別のキャッシュを持つクライアントに変わったら、送信済みの記憶は当てにならない
      if (msg.cacheId !== clientCacheId) {
        resetClientTiles(msg.cacheId);
        lists.clear();
        clearCurrentList();
      }
      setClientCacheLimit(
        Number.isFinite(msg.cacheBytes)
          ? Math.min(Math.max(msg.cacheBytes, 1 << 20), 1 << 28)
          : clientCacheLimit,
      );
      // 画面には何も出ていないので、復帰であってもpageBeginから送り直す
      setCurrent(undefined);
      await setViewport(clampViewport(msg.viewportW, msg.viewportH, msg.dpr));
      setShownTab(getActiveTabId());
      const switched = mode !== "page";
      await switchMode("page"); // クライアントUIはページモードで始まるため揃える
      sendTabs();
      await sendNavState(false);
      // 他モードから戻した場合はswitchMode内で送信済み（二重のpageBeginを避ける）
      if (!switched) await captureAndSend();
      break;
    }
    case "viewport": {
      const next = clampViewport(msg.width, msg.height, msg.dpr);
      const cur = getViewport();
      if (next.width === cur.width && next.height === cur.height && next.scale === cur.scale) {
        break;
      }
      await setViewport(next);
      // 幅が変わればレイアウトごと変わるので差分にはできない
      if (mode === "live") {
        const { cdp } = getActivePage();
        await cdp.send("Page.stopScreencast").catch(() => {});
        await startScreencast();
      } else if (mode === "vector") {
        // 幅が変われば画像の表示寸法も変わる
        await extractAndSend();
      } else {
        await captureAndSend();
      }
      break;
    }
    case "navigate": {
      // 旧ページの未送信タイルは即座に破棄して帯域を新ページに譲る
      current?.pending.clear();
      await sendNavState(true);
      await page.goto(msg.url, { waitUntil: "load", timeout: 30_000 }).catch((e) => {
        send({
          type: "error",
          message: stripAnsi(`navigate failed: ${String(e)}`),
        });
      });
      break;
    }
    case "back":
      await page.goBack({ timeout: 15_000 }).catch(() => {});
      break;
    case "forward":
      await page.goForward({ timeout: 15_000 }).catch(() => {});
      break;
    case "reload":
      await page.reload({ timeout: 30_000 }).catch(() => {});
      break;
    case "newTab": {
      const previous = getActiveTab();
      await openTab(msg.url);
      await activateTab(previous);
      break;
    }
    case "closeTab": {
      await closeTab(msg.tabId);
      sendTabs();
      if (getActiveTabId() !== shownTabId) await activateTab(undefined);
      break;
    }
    case "selectTab": {
      const previous = getActiveTab();
      if (selectTab(msg.tabId)) await activateTab(previous);
      break;
    }
    case "tap":
      await tap(msg.x, msg.y);
      // タップで入力欄にフォーカスしたか調べて IME 表示を制御する
      setTimeout(() => void sendFocusState(), 300);
      // 遷移しない操作（メニュー開閉等）向けの差分再キャプチャ。
      // 遷移が始まっていたら load イベント側のフル再送に任せる
      // （レイアウト未完了ページを送って帯域を無駄にしない）。ライブ中は screencast が映す
      scheduleRefresh();
      break;
    case "longPress":
      await longPress(msg.x, msg.y);
      scheduleRefresh();
      break;
    case "insertText":
      await insertText(msg.text);
      scheduleRefresh();
      break;
    case "key":
      await pressKey(msg.key);
      // Enter はフォーム送信でフォーカスが外れることが多いので再評価する
      setTimeout(() => void sendFocusState(), 500);
      scheduleRefresh();
      break;
    case "setMode":
      await switchMode(msg.mode);
      break;
    case "liveAck":
      setLiveFrameInFlight(false);
      trySendLiveFrame();
      break;
    case "scrollPos": {
      if (mode === "live") {
        // ライブ中はローカルスクロールできない。window.scrollToでは
        // 内部スクロールコンテナのサイト（YouTube等）が動かないため、
        // タッチスクロールのジェスチャを合成して差分スクロールさせる
        const delta = msg.y - liveMetaScrollY;
        if (Math.abs(delta) > 5) {
          const { cdp } = getActivePage();
          await cdp
            .send("Input.synthesizeScrollGesture", {
              x: 360,
              y: 640,
              xDistance: 0,
              yDistance: -delta, // 正だと上方向スクロールのため反転
              speed: 4000,
            })
            .catch(() => {});
        }
        break;
      }
      if (mode === "vector") {
        if (msg.id !== currentList?.listId) break;
        currentList.scrollY = msg.y;
        void maybeExtendVector();
        break;
      }
      // 遷移直後は前のページ向けの通知が遅れて届く
      if (!current || msg.id !== current.pageId) break;
      current.scrollY = msg.y; // 送信キューの優先順位とpageExtendの判定に使う
      void maybeExtend();
      break;
    }
    case "activate": {
      if (mode !== "vector" || msg.listId !== currentList?.listId) break;
      const at = await nodePoint(msg.nodeId, msg.x, msg.y);
      if (!at) break;
      await tap(at.x, at.y);
      setTimeout(() => void sendFocusState(), 300);
      scheduleRefresh();
      break;
    }
    case "requestAssets": {
      const list = currentList;
      if (mode !== "vector" || msg.listId !== list?.listId) break;
      for (const nodeId of msg.nodeIds) {
        // 一度撮ったものは撮り直さない。ただし写しから落ちているなら実体が要る
        const hash = list.assets.get(nodeId);
        if (!msg.raw && hash !== undefined && clientTiles.has(hash)) {
          send({ type: "assetRef", listId: list.listId, nodeId, hash });
          continue;
        }
        if (msg.raw) list.forceRaw.add(nodeId);
        if (!assetQueue.includes(nodeId)) assetQueue.push(nodeId);
      }
      void pumpAssets();
      break;
    }
    case "requestList":
      if (mode !== "vector") break;
      // 手元と食い違っている土台。捨てて丸ごと送り直す
      if (currentList) lists.delete(currentList.viewKey);
      clearCurrentList();
      await extractAndSend();
      break;
    case "requestTiles":
      if (current) {
        for (const i of msg.indices) {
          if (i < 0 || i >= current.tiles.length) continue;
          current.pending.add(i);
          current.forceRaw.add(i);
        }
        void pumpTiles();
      }
      break;
  }
}
