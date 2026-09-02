import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { startBrowser, stopBrowser, getActivePage, PAGE_HEIGHT } from "./browser.ts";
import {
  captureFullPage,
  captureRegion,
  measureContentHeight,
  triggerLazyLoad,
  tilesDiffer,
  TILE_HEIGHT,
  EXTEND_CHUNK,
  type Tile,
} from "./capture.ts";
import { tap, longPress, insertText, pressKey } from "./input.ts";
import { loadConfig } from "./config.ts";
import type { ClientMsg, ServerMsg } from "./protocol.ts";

const PORT = 8080;
const config = loadConfig();

// セッションは 1 つ、後勝ち
let client: WebSocket | undefined;

// Playwright のエラー文字列には ANSI エスケープが混ざるため除去してから送る
const stripAnsi = (s: string): string => s.replace(/\u001b?\[[0-9;]*m/g, "");

function send(msg: ServerMsg): void {
  if (client?.readyState === WebSocket.OPEN) {
    console.log(`-> ${msg.type}`);
    client.send(JSON.stringify(msg));
  } else {
    console.log(`-> ${msg.type} (dropped: no client)`);
  }
}

// ---- 現在ページのタイル状態と送信キュー ----

interface CurrentPage {
  pageId: string;
  fullHeight: number;    // クライアントに通知済みのキャプチャ高さ
  contentHeight: number; // 実ページ全体の高さ（fullHeight より大きければ未取得部分あり）
  tiles: Tile[];
  pending: Set<number>; // 未送信 or 更新されたタイル index
}

let current: CurrentPage | undefined;
let clientScrollY = 0; // クライアントのローカルスクロール位置（ページ座標）
let pumping = false;
let pageLoading = false; // メインフレームのナビゲーション進行中か
let navGen = 0; // ナビゲーション世代。framenavigated ごとに増える（非同期処理の失効判定用）
let mode: "page" | "live" = "page";

function pickNextTile(page: CurrentPage): number {
  const center = clientScrollY + PAGE_HEIGHT / 2;
  let best = -1;
  let bestDist = Infinity;
  for (const i of page.pending) {
    const dist = Math.abs(i * TILE_HEIGHT + TILE_HEIGHT / 2 - center);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

// pending タイルを 1 枚ずつ送る。送信中にページが差し替わったら新しいページの分を続けて送る
async function pumpTiles(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    while (current && current.pending.size > 0 && client?.readyState === WebSocket.OPEN) {
      const page = current;
      const ws = client;
      const index = pickNextTile(page);
      if (index < 0) break;
      page.pending.delete(index);
      const tile = page.tiles[index];
      if (!tile) continue;
      send({
        type: "tileHeader",
        pageId: page.pageId,
        tileIndex: index,
        offsetY: index * TILE_HEIGHT,
        format: "webp",
        byteLength: tile.data.byteLength,
      });
      console.log(`-> binary tile ${index} (${tile.data.byteLength} bytes)`);
      // 送信完了（ソケットへのフラッシュ）を待ってから次のタイルを選ぶ
      await new Promise<void>((resolve) => ws.send(tile.data, () => resolve()));
    }
  } finally {
    pumping = false;
  }
}

// ---- キャプチャ（直列化 + 要求の集約） ----

let capturing = false;
let capturePending = false;
let capturePendingForceNew = false;

async function captureAndSend(forceNew: boolean): Promise<void> {
  if (capturing) {
    capturePending = true;
    capturePendingForceNew ||= forceNew;
    return;
  }
  capturing = true;
  try {
    let force = forceNew;
    do {
      capturePending = false;
      capturePendingForceNew = false;
      await captureOnce(force);
      force = capturePendingForceNew;
    } while (capturePending);
  } catch (e) {
    console.error("capture failed:", e);
  } finally {
    capturing = false;
  }
}

async function captureOnce(forceNew: boolean): Promise<void> {
  // pageExtend 進行中は fullHeight が動くので終わるまで待つ
  while (extending) await new Promise((r) => setTimeout(r, 50));
  const { page } = getActivePage();
  const prev = current;
  // 同一ページの差分再キャプチャは既にクライアントへ送った高さの範囲で行う
  const cap = await captureFullPage(!forceNew && prev ? prev.fullHeight : undefined);

  // 同一ページの再キャプチャ（高さもタイル数も不変）なら差分タイルだけ送る
  const isSamePage =
    !forceNew &&
    prev !== undefined &&
    prev.fullHeight === cap.fullHeight &&
    prev.tiles.length === cap.tiles.length;

  if (isSamePage) {
    prev.contentHeight = cap.contentHeight;
    let changed = 0;
    for (let i = 0; i < cap.tiles.length; i++) {
      const next = cap.tiles[i];
      const before = prev.tiles[i];
      if (next && before && tilesDiffer(next, before)) {
        prev.tiles[i] = next;
        prev.pending.add(i);
        changed++;
      }
    }
    console.log(`recapture: ${changed}/${cap.tiles.length} tiles changed`);
    if (changed > 0) void pumpTiles();
    return;
  }

  const title = await page.title().catch(() => "");
  // 新しいページはクライアント側で先頭表示になるため、
  // 前ページの古いスクロール位置で送信順を決めない（tile 0 を最優先にする）
  clientScrollY = 0;
  current = {
    pageId: randomUUID(),
    fullHeight: cap.fullHeight,
    contentHeight: cap.contentHeight,
    tiles: cap.tiles,
    pending: new Set(cap.tiles.map((_, i) => i)),
  };
  send({
    type: "pageBegin",
    pageId: current.pageId,
    url: page.url(),
    title,
    fullHeight: cap.fullHeight,
    tileHeight: TILE_HEIGHT,
    tileCount: cap.tiles.length,
  });
  void pumpTiles();
}

// ---- pageExtend: スクロールが画像末尾に近づいたら追加分を継ぎ足す ----

let extending = false;
let lastExtendProbe = 0;

async function maybeExtend(): Promise<void> {
  const page = current;
  if (!page || extending || capturing) return;
  // ナビゲーション中は旧ページに新ページの内容を継ぎ足してしまうため何もしない
  if (pageLoading) return;
  // ライブモード中はタイル更新を止める
  if (mode !== "page") return;
  // 画像末尾から 1.5 画面分以上手前なら何もしない
  if (clientScrollY + PAGE_HEIGHT * 1.5 < page.fullHeight) return;
  // 末尾まで取得済みのページ（静的ページ or 無限スクロールが伸びる前）では
  // 実ページスクロール + 再測定が空振りし続けるので、確認頻度を 1.5 秒に 1 回へ抑える
  if (page.fullHeight >= page.contentHeight) {
    const now = Date.now();
    if (now - lastExtendProbe < 1500) return;
    lastExtendProbe = now;
  }
  extending = true;
  const gen = navGen;
  try {
    const { page: pw } = getActivePage();
    // 実ページを該当位置までスクロールして遅延読み込み・無限スクロールを発火させる
    await pw.evaluate((y) => window.scrollTo(0, y), clientScrollY).catch(() => {});
    await pw.waitForTimeout(300);
    const contentHeight = Math.max(await measureContentHeight(), page.fullHeight);
    // 待機中にナビゲーションが起きていたら旧ページへの継ぎ足しになるため中止
    if (current !== page || pageLoading || gen !== navGen) return;
    page.contentHeight = contentHeight;
    if (contentHeight <= page.fullHeight) return;

    // 末尾が部分タイルの場合（無限スクロールでページが後から伸びた場合）は
    // そのタイルごと取り直して境界を TILE_HEIGHT に揃える
    const baseIndex = Math.floor(page.fullHeight / TILE_HEIGHT);
    const baseY = baseIndex * TILE_HEIGHT;
    const newFullHeight = Math.min(contentHeight, baseY + EXTEND_CHUNK);
    await triggerLazyLoad(page.fullHeight, newFullHeight);
    const newTiles = await captureRegion(baseY, newFullHeight);
    if (current !== page || pageLoading || gen !== navGen) return;

    const oldCount = page.tiles.length;
    page.tiles.splice(baseIndex, oldCount - baseIndex, ...newTiles);
    for (let i = baseIndex; i < page.tiles.length; i++) page.pending.add(i);
    page.fullHeight = newFullHeight;
    send({
      type: "pageExtend",
      pageId: page.pageId,
      newFullHeight,
      addedTiles: page.tiles.length - oldCount,
    });
    void pumpTiles();
  } catch (e) {
    console.error("extend failed:", e);
  } finally {
    extending = false;
  }
}

// ---- ライブモード（Page.startScreencast） ----
//
// フレームはアプリレベルの liveAck で 1 枚ずつ送る。
// TCP ソケットバッファに任せると 300kbps では数十秒分のフレームが滞留し、
// WS の ping/pong まで埋もれてクライアントがタイムアウト切断するため。

let liveFrameInFlight = false; // クライアントの liveAck 待ち
let latestLiveFrame: { data: Buffer; scrollY: number } | undefined;
let liveMetaScrollY = 0; // 最後のフレーム時点の実ページ scrollY（ライブ中のスクロール差分計算用）

function trySendLiveFrame(): void {
  if (mode !== "live" || liveFrameInFlight) return;
  const frame = latestLiveFrame;
  if (!frame || client?.readyState !== WebSocket.OPEN) return;
  latestLiveFrame = undefined;
  liveFrameInFlight = true;
  send({
    type: "liveFrameHeader",
    format: "jpeg",
    byteLength: frame.data.byteLength,
    scrollY: frame.scrollY,
  });
  client.send(frame.data);
}

async function switchMode(next: "page" | "live"): Promise<void> {
  if (next === mode) return;
  const { page, cdp } = getActivePage();
  mode = next;
  if (next === "live") {
    liveFrameInFlight = false;
    latestLiveFrame = undefined;
    await cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: 40,
      maxWidth: 720,
      maxHeight: 1280,
      everyNthFrame: 2,
    });
    // 静止ページでは最初のフレームが来ないことがあるため、強制的に再描画させる
    // （即時往復だとコンポジタに拾われる前に相殺されるので 1 フレーム分待つ）
    await page
      .evaluate(async () => {
        window.scrollBy(0, 1);
        await new Promise((r) => setTimeout(r, 60));
        window.scrollBy(0, -1);
      })
      .catch(() => {});
  } else {
    await cdp.send("Page.stopScreencast").catch(() => {});
    latestLiveFrame = undefined;
    // ページモード復帰時は最新状態をフルで送り直す
    void captureAndSend(true);
  }
}

// ---- フォーカス検知（IME 表示制御） ----

async function sendFocusState(): Promise<void> {
  const { page } = getActivePage();
  try {
    const kind = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return "none";
      const tag = el.tagName.toLowerCase();
      if (tag === "textarea" || el.isContentEditable) return "text";
      if (tag === "input") {
        const type = (el as HTMLInputElement).type;
        const nonText = [
          "button", "submit", "checkbox", "radio", "file",
          "image", "range", "color", "reset", "hidden",
        ];
        return nonText.includes(type) ? "none" : "text";
      }
      return "none";
    });
    send({ type: "focus", kind: kind as "text" | "none" });
  } catch {
    // ナビゲーション中などの評価失敗は無視（次のタップで再評価される）
  }
}

async function sendNavState(loading: boolean): Promise<void> {
  const { page, cdp } = getActivePage();
  try {
    const hist = await cdp.send("Page.getNavigationHistory");
    send({
      type: "navState",
      canGoBack: hist.currentIndex > 0,
      canGoForward: hist.currentIndex < hist.entries.length - 1,
      url: page.url(),
      loading,
    });
  } catch (e) {
    console.error("navState failed:", e);
  }
}

async function handleMsg(msg: ClientMsg): Promise<void> {
  const { page } = getActivePage();
  switch (msg.type) {
    case "hello": {
      send({ type: "helloAck", ver: 1, sessionId: randomUUID() });
      const wasLive = mode === "live";
      await switchMode("page"); // クライアント UI はページモードで始まるため揃える
      await sendNavState(false);
      // ライブから戻した場合は switchMode 内でフル再送済み（二重 pageBegin を避ける）
      if (!wasLive) await captureAndSend(true);
      break;
    }
    case "navigate": {
      const url = /^[a-z]+:\/\//i.test(msg.url) ? msg.url : `https://${msg.url}`;
      // 旧ページの未送信タイルは即座に破棄して帯域を新ページに譲る
      current?.pending.clear();
      await sendNavState(true);
      await page.goto(url, { waitUntil: "load", timeout: 30_000 }).catch((e) => {
        send({ type: "error", message: stripAnsi(`navigate failed: ${String(e)}`) });
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
    case "tap":
      await tap(msg.x, msg.y);
      // タップで入力欄にフォーカスしたか調べて IME 表示を制御する
      setTimeout(() => void sendFocusState(), 300);
      // 遷移しない操作（メニュー開閉等）向けの差分再キャプチャ。
      // 遷移が始まっていたら load イベント側のフル再送に任せる
      // （レイアウト未完了ページを送って帯域を無駄にしない）。ライブ中は screencast が映す
      setTimeout(() => {
        if (!pageLoading && mode === "page") void captureAndSend(false);
      }, 600);
      break;
    case "longPress":
      await longPress(msg.x, msg.y);
      setTimeout(() => {
        if (!pageLoading && mode === "page") void captureAndSend(false);
      }, 600);
      break;
    case "insertText":
      await insertText(msg.text);
      setTimeout(() => {
        if (!pageLoading && mode === "page") void captureAndSend(false);
      }, 600);
      break;
    case "key":
      await pressKey(msg.key);
      // Enter はフォーム送信でフォーカスが外れることが多いので再評価する
      setTimeout(() => void sendFocusState(), 500);
      setTimeout(() => {
        if (!pageLoading && mode === "page") void captureAndSend(false);
      }, 600);
      break;
    case "setMode":
      await switchMode(msg.mode);
      break;
    case "liveAck":
      liveFrameInFlight = false;
      trySendLiveFrame();
      break;
    case "scrollPos":
      clientScrollY = msg.y; // 送信キューの優先順位と pageExtend の判定に使う
      if (mode === "live") {
        // ライブ中はローカルスクロールできない。window.scrollTo では
        // 内部スクロールコンテナのサイト（YouTube 等）が動かないため、
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
      } else {
        void maybeExtend();
      }
      break;
    case "requestTiles":
      if (current) {
        for (const i of msg.indices) {
          if (i >= 0 && i < current.tiles.length) current.pending.add(i);
        }
        void pumpTiles();
      }
      break;
  }
}

async function main(): Promise<void> {
  await startBrowser();
  const { page, cdp } = getActivePage();

  // ライブモード: Chrome へは即 Ack して生成を止めず、常に最新フレームだけを保持。
  // クライアントへは liveAck が返ってくるまで次を送らない（1 枚ずつ、古いフレームは捨てる）
  cdp.on("Page.screencastFrame", (params) => {
    liveMetaScrollY = Math.round(params.metadata.scrollOffsetY);
    latestLiveFrame = {
      data: Buffer.from(params.data, "base64"),
      scrollY: liveMetaScrollY,
    };
    void cdp.send("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => {});
    trySendLiveFrame();
  });

  page.on("load", () => {
    pageLoading = false;
    void sendNavState(false);
    send({ type: "focus", kind: "none" }); // 新しいページにフォーカスは残らない
    if (mode === "page") void captureAndSend(true);
  });
  let loadingTimeout: NodeJS.Timeout | undefined;
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) {
      pageLoading = true;
      navGen++;
      // リンクタップ等での遷移でも旧ページの未送信タイルを破棄する
      current?.pending.clear();
      // 同一ドキュメント遷移（pushState 等）では load が来ないため安全弁で解除する
      clearTimeout(loadingTimeout);
      loadingTimeout = setTimeout(() => {
        pageLoading = false;
      }, 5000);
      void sendNavState(true);
    }
  });

  const wss = new WebSocketServer({ port: PORT });
  wss.on("connection", (ws, req) => {
    const token = new URL(req.url ?? "/", "ws://localhost").searchParams.get("token");
    if (token !== config.token) {
      console.log("client rejected: bad token");
      ws.close(4001, "unauthorized");
      return;
    }
    console.log("client connected");
    client?.close(1000, "superseded");
    client = ws;
    liveFrameInFlight = false; // 旧接続の liveAck は二度と来ない

    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      let msg: ClientMsg;
      try {
        msg = JSON.parse(data.toString()) as ClientMsg;
      } catch {
        send({ type: "error", message: "invalid JSON" });
        return;
      }
      console.log(msg.type === "scrollPos" ? `<- scrollPos y=${msg.y}` : `<- ${msg.type}`);
      handleMsg(msg).catch((e) => {
        console.error("handleMsg failed:", e);
        send({ type: "error", message: stripAnsi(String(e)) });
      });
    });

    ws.on("close", () => {
      if (client === ws) client = undefined;
      console.log("client disconnected");
    });
    ws.on("error", (e) => console.error("ws error:", e));
  });

  console.log(`listening on ws://0.0.0.0:${PORT}`);
  console.log(`auth token: ${config.token}`);

  const shutdown = async () => {
    wss.close();
    await stopBrowser();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
