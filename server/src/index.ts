import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import {
  startBrowser,
  stopBrowser,
  getActivePage,
  getViewport,
  setViewport,
  clampViewport,
  getTabs,
  getActiveTab,
  getActiveTabId,
  selectTab,
  openTab,
  closeTab,
  type Tab,
  type Viewport,
} from "./browser.ts";
import {
  captureFullPage,
  captureRegion,
  measureContentHeight,
  triggerLazyLoad,
  tilesDiffer,
  getTileHeight,
  getExtendChunk,
  type FullPageCapture,
  type Tile,
} from "./capture.ts";
import { extractList, captureAssets, nodeCenter } from "./vector.ts";
import { tap, longPress, insertText, pressKey } from "./input.ts";
import { loadConfig } from "./config.ts";
import type { ClientMsg, ServerMsg, Mode } from "./protocol.ts";

const PORT = 8080;
const config = loadConfig();

const CLOSE_UNAUTHORIZED = 4001;
// 受け取った側は再接続してはならない。し合うと互いを蹴り続ける
const CLOSE_SUPERSEDED = 4002;

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
  // 履歴エントリ単位の識別子（tabId:entryId）。戻る・進む・タブ切替で同じ状態へ戻す鍵
  viewKey: string;
  // 撮影時のビューポート幅とタイル高さ。途中で変わるとタイルindexの意味が壊れるので、
  // 合わなくなったページは作り直す
  pageWidth: number;
  tileHeight: number;
  fullHeight: number; // クライアントに通知済みのキャプチャ高さ
  contentHeight: number; // 実ページ全体の高さ（fullHeightより大きければ未取得部分あり）
  tiles: Tile[];
  // 送信済みタイルのhash。undefinedはまだクライアントへ届いていない
  hashes: (string | undefined)[];
  scrollY: number; // クライアントのローカルスクロール位置（ページ座標）
  pending: Set<number>; // まだ送っていない、または更新されたタイルのindex
  // tileRefが外れてクライアントから要求し直されたindex。実体を送る
  forceRaw: Set<number>;
}

// クライアントのタイルキャッシュの写し。hashからバイト数で、挿入順がLRU。
// helloで渡された容量に合わせて同じ順に捨てる。復号のためのアクセスまでは追えないので
// 完全一致はしないが、食い違ってもrequestTilesで実体を要求され直すだけで済む
const clientTiles = new Map<string, number>();
let clientCacheId = "";
let clientCacheLimit = 16 * 1024 * 1024;
let clientCacheUsed = 0;

function rememberHash(hash: string, byteLength: number): void {
  const prev = clientTiles.get(hash);
  if (prev !== undefined) {
    clientTiles.delete(hash); // 再挿入して最近使った順にする
    clientCacheUsed -= prev;
  }
  clientTiles.set(hash, byteLength);
  clientCacheUsed += byteLength;
  for (const [old, size] of clientTiles) {
    if (clientCacheUsed <= clientCacheLimit) break;
    clientTiles.delete(old);
    clientCacheUsed -= size;
  }
}

// 履歴エントリ単位のページ状態。戻る・進む・タブ切替を撮り直しにしないために持つ。
// 1ページあたりタイルの署名とWebPバイト列で数百KB
const PAGE_CACHE_LIMIT = 30;
const pages = new Map<string, CurrentPage>(); // 挿入順がLRU

let current: CurrentPage | undefined;
let pumping = false;
let pageLoading = false; // メインフレームのナビゲーション進行中か
let navGen = 0; // ナビゲーション世代。framenavigated ごとに増える（非同期処理の失効判定用）
let mode: Mode = "page";

// 操作の後に画面を作り直す。遷移が始まっていたらload側のやり直しに任せる
// （レイアウト未完了ページを送って帯域を無駄にしない）。ライブ中はscreencastが映す
function scheduleRefresh(): void {
  setTimeout(() => {
    if (pageLoading) return;
    if (mode === "page") void captureAndSend();
    else if (mode === "vector") void extractAndSend();
  }, 600);
}

// 表示から外れたページは未符号化タイルが元PNGを掴んだままなので手放させる。
// 戻ってきたときは差分キャプチャで撮り直して埋める
function setCurrent(next: CurrentPage | undefined): void {
  if (current && current !== next) {
    current.pending.clear();
    for (const tile of current.tiles) tile.drop();
  }
  current = next;
}

function cachePage(page: CurrentPage): void {
  pages.delete(page.viewKey); // 再挿入して最近使った順にする
  pages.set(page.viewKey, page);
  for (const [key, old] of pages) {
    if (pages.size <= PAGE_CACHE_LIMIT) break;
    if (old !== current) pages.delete(key);
  }
}

// 画面の上端から下へ順に埋める。上へ戻る分は後回しでよいので距離を倍に見る
function pickNextTile(page: CurrentPage): number {
  const top = page.scrollY;
  let best = -1;
  let bestDist = Infinity;
  for (const i of page.pending) {
    const tileTop = i * page.tileHeight;
    const dist = tileTop >= top ? tileTop - top : (top - tileTop) * 2;
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
      // pendingから外した後なので、失敗したタイルはrequestTilesで拾い直してもらう
      const encoded = await tile.encode().catch((e) => {
        console.error(`tile ${index} encode failed:`, e);
        return undefined;
      });
      // 符号化を待つ間にページが差し替わっていたら送らない
      if (!encoded || current !== page) continue;
      const { data, hash } = encoded;
      const offsetY = index * page.tileHeight;
      const raw = page.forceRaw.delete(index) || !clientTiles.has(hash);
      rememberHash(hash, data.byteLength);
      page.hashes[index] = hash;
      if (!raw) {
        send({
          type: "tileRef",
          pageId: page.pageId,
          tileIndex: index,
          offsetY,
          hash,
        });
        continue;
      }
      send({
        type: "tileHeader",
        pageId: page.pageId,
        tileIndex: index,
        offsetY,
        format: "webp",
        byteLength: data.byteLength,
        hash,
      });
      console.log(`-> binary tile ${index} (${data.byteLength} bytes)`);
      // 送信完了（ソケットへのフラッシュ）を待ってから次のタイルを選ぶ
      await new Promise<void>((resolve) => ws.send(data, () => resolve()));
    }
  } finally {
    pumping = false;
  }
}

// ---- キャプチャ（直列化 + 要求の集約） ----

let capturing = false;
let capturePending = false;

async function captureAndSend(): Promise<void> {
  if (capturing) {
    capturePending = true;
    return;
  }
  capturing = true;
  try {
    do {
      capturePending = false;
      await captureOnce();
    } while (capturePending);
  } catch (e) {
    console.error("capture failed:", e);
  } finally {
    capturing = false;
  }
  // 新規ページは1画面ぶんしか撮っていないので、続きの先読みへ進める
  void maybeExtend();
}

// 履歴エントリごとに1つ。戻る・進むでは同じ鍵に戻ってくる
async function viewKey(tab: Tab): Promise<string> {
  const hist = await tab.cdp.send("Page.getNavigationHistory").catch(() => undefined);
  return `${tab.id}:${hist?.entries[hist.currentIndex]?.id ?? 0}`;
}

// 差分キャプチャの基準にできるページか。タイルの刻みが合わなければindexの意味が変わる
function reusable(page: CurrentPage | undefined, key: string): CurrentPage | undefined {
  const view = getViewport();
  return page &&
    page.viewKey === key &&
    page.pageWidth === view.width &&
    page.tileHeight === getTileHeight()
    ? page
    : undefined;
}

async function captureOnce(): Promise<void> {
  const gen = navGen;
  const tab = getActiveTab();
  const key = await viewKey(tab);
  // 戻る・進む・タブ切替。前に撮った状態が残っていればキャプチャを待たせずに出す
  if (current?.viewKey !== key) restore(pages.get(key), tab);
  // pageExtend進行中はfullHeightが動くので終わるまで待つ
  while (extending) await new Promise((r) => setTimeout(r, 50));

  const base = reusable(current, key);
  // 差分は既にクライアントへ送った高さぶん、新規ページは1画面ぶん
  const cap = await captureFullPage(base?.fullHeight);
  // 撮っている間に遷移していたら写っているのは次のページで、取り込むと前のページの
  // 状態が潰れる。撮り直しは遷移先のloadに任せ、currentも外して継ぎ足しを止める
  if (gen !== navGen) {
    console.log(`capture dropped: navigated away from ${key}`);
    setCurrent(undefined);
    return;
  }
  const view = getViewport();
  if (
    base &&
    current === base &&
    reusable(base, key) &&
    base.fullHeight === cap.fullHeight &&
    base.tiles.length === cap.tiles.length
  ) {
    applyDiff(base, cap);
    return;
  }
  await beginPage(tab, key, cap, view);
}

// 前に撮ったページをそのまま出す。クライアントが持っているはずのタイルはhashだけ渡し、
// 届いていない分はpendingへ積む（直後の差分キャプチャで撮り直されて送られる）
function restore(page: CurrentPage | undefined, tab: Tab): void {
  const cached = page && reusable(page, page.viewKey);
  if (!cached) return;
  setCurrent(cached);
  cachePage(cached);
  cached.pageId = randomUUID();
  cached.pending.clear();
  cached.forceRaw.clear();
  const hashes = cached.tiles.map((_, i) => {
    const hash = cached.hashes[i];
    const size = hash !== undefined ? clientTiles.get(hash) : undefined;
    if (hash !== undefined && size !== undefined) {
      rememberHash(hash, size); // クライアント側でも参照されるので同じ順に並べ直す
      return hash;
    }
    cached.pending.add(i);
    return null;
  });
  console.log(
    `restore ${cached.viewKey}: ${cached.tiles.length - cached.pending.size}/` +
      `${cached.tiles.length} tiles kept, scrollY=${cached.scrollY}`,
  );
  send({
    type: "pageBegin",
    pageId: cached.pageId,
    url: tab.page.url(),
    title: tab.title,
    pageWidth: cached.pageWidth,
    fullHeight: cached.fullHeight,
    tileHeight: cached.tileHeight,
    tileCount: cached.tiles.length,
    scrollY: cached.scrollY,
    hashes,
  });
}

// 同じ形のまま撮り直したとき。変わったタイルと、まだ届いていないタイルだけ送る
function applyDiff(page: CurrentPage, cap: FullPageCapture): void {
  page.contentHeight = cap.contentHeight;
  let changed = 0;
  for (let i = 0; i < cap.tiles.length; i++) {
    const next = cap.tiles[i];
    if (!next) continue;
    const before = page.tiles[i];
    // 未送信のタイルは中身を見ずに差し替える。復帰したページは元PNGを手放していて
    // 符号化できないので、ここで撮り直したものに入れ替わる必要がある
    if (before && !page.pending.has(i) && !tilesDiffer(next, before)) continue;
    page.tiles[i] = next;
    page.hashes[i] = undefined;
    page.pending.add(i);
    changed++;
  }
  console.log(`recapture: ${changed}/${cap.tiles.length} tiles changed`);
  if (changed > 0) void pumpTiles();
}

async function beginPage(
  tab: Tab,
  key: string,
  cap: FullPageCapture,
  view: Viewport,
): Promise<void> {
  const title = await tab.page.title().catch(() => "");
  const page: CurrentPage = {
    pageId: randomUUID(),
    viewKey: key,
    pageWidth: view.width,
    tileHeight: getTileHeight(),
    fullHeight: cap.fullHeight,
    contentHeight: cap.contentHeight,
    tiles: cap.tiles,
    hashes: [],
    // 同じ履歴エントリを撮り直したのなら表示位置は動かさない。
    // 新しいページは先頭から（tile 0を最優先にする）
    scrollY: pages.get(key)?.scrollY ?? 0,
    pending: new Set(cap.tiles.map((_, i) => i)),
    forceRaw: new Set(),
  };
  setCurrent(page);
  cachePage(page);
  console.log(`begin ${key}: ${cap.tiles.length} tiles, scrollY=${page.scrollY}`);
  send({
    type: "pageBegin",
    pageId: page.pageId,
    url: tab.page.url(),
    title,
    pageWidth: page.pageWidth,
    fullHeight: page.fullHeight,
    tileHeight: page.tileHeight,
    tileCount: cap.tiles.length,
    scrollY: page.scrollY,
    hashes: cap.tiles.map(() => null),
  });
  void pumpTiles();
}

// vectorモード。ページを描画コマンドの列として送り、画像だけラスタにする

interface CurrentList {
  listId: string;
  // nodeIdから送信済み画像のhash
  assets: Map<number, string>;
  // 背景として撮るnodeId。撮影中は子孫を隠す
  background: Set<number>;
}

let currentList: CurrentList | undefined;
let extracting = false;

async function extractAndSend(): Promise<void> {
  if (extracting) return;
  extracting = true;
  try {
    const gen = navGen;
    const tab = getActiveTab();
    const snap = await extractList();
    // 抽出中に遷移していたら、載っているのは次のページの中身
    if (gen !== navGen) return;
    const list: CurrentList = {
      listId: randomUUID(),
      assets: new Map(),
      background: new Set(snap.rects.filter((r) => r.bg).map((r) => r.nodeId)),
    };
    currentList = list;
    assetQueue.length = 0;
    const bytes = JSON.stringify(snap.list).length;
    console.log(
      `vector: ${snap.list.ops.length} ops, ${snap.rects.length} images, ` +
        `${snap.list.colors.length} colors, ${snap.list.fonts.length} fonts, ${bytes} bytes`,
    );
    send({
      type: "vectorBegin",
      listId: list.listId,
      url: tab.page.url(),
      title: snap.title,
      list: snap.list,
    });
  } catch (e) {
    console.error("extract failed:", e);
  } finally {
    extracting = false;
  }
}

// captureAssetsは帯ごとに1枚撮るので、まとめて渡すほどスクリーンショットが減る
const ASSET_BATCH = 8;
const assetQueue: number[] = [];
let pumpingAssets = false;

async function pumpAssets(): Promise<void> {
  if (pumpingAssets) return;
  pumpingAssets = true;
  try {
    while (assetQueue.length > 0 && currentList && client?.readyState === WebSocket.OPEN) {
      const list = currentList;
      const ws = client;
      const assets = await captureAssets(assetQueue.splice(0, ASSET_BATCH), list.background);
      // 切り出しを待つ間にページが差し替わっていたら送らない
      if (currentList !== list) break;
      for (const asset of assets) {
        const held = clientTiles.has(asset.hash);
        rememberHash(asset.hash, asset.data.byteLength);
        list.assets.set(asset.nodeId, asset.hash);
        if (held) {
          send({ type: "assetRef", listId: list.listId, nodeId: asset.nodeId, hash: asset.hash });
          continue;
        }
        send({
          type: "assetHeader",
          listId: list.listId,
          nodeId: asset.nodeId,
          format: "webp",
          byteLength: asset.data.byteLength,
          hash: asset.hash,
        });
        console.log(`-> binary asset ${asset.nodeId} (${asset.data.byteLength} bytes)`);
        await new Promise<void>((resolve) => ws.send(asset.data, () => resolve()));
      }
    }
  } catch (e) {
    console.error("asset capture failed:", e);
  } finally {
    pumpingAssets = false;
  }
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
  // ビューポートが変わっていたらタイルの刻みが合わない
  if (page.pageWidth !== getViewport().width || page.tileHeight !== getTileHeight()) return;
  // 画像末尾から 1.5 画面分以上手前なら何もしない
  if (page.scrollY + getViewport().height * 1.5 < page.fullHeight) return;
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
    const tab = getActiveTab();
    // ブラウザが既に別のページへ移っていることがある（loadが来ないまま
    // pageLoadingの安全弁が外れた後など）。継ぎ足す先が違えば次のページの絵が付く
    if (page.viewKey !== (await viewKey(tab))) return;
    const pw = tab.page;
    // 実ページを該当位置までスクロールして遅延読み込み・無限スクロールを発火させる
    await pw.evaluate((y) => window.scrollTo(0, y), page.scrollY).catch(() => {});
    await pw.waitForTimeout(300);
    const contentHeight = Math.max(await measureContentHeight(), page.fullHeight);
    // 待機中にナビゲーションが起きていたら旧ページへの継ぎ足しになるため中止
    if (current !== page || pageLoading || gen !== navGen) return;
    page.contentHeight = contentHeight;
    if (contentHeight <= page.fullHeight) return;

    // 末尾が部分タイルの場合（無限スクロールでページが後から伸びた場合）は
    // そのタイルごと取り直して境界を TILE_HEIGHT に揃える
    const baseIndex = Math.floor(page.fullHeight / page.tileHeight);
    const baseY = baseIndex * page.tileHeight;
    const newFullHeight = Math.min(contentHeight, baseY + getExtendChunk());
    await triggerLazyLoad(page.fullHeight, newFullHeight);
    const newTiles = await captureRegion(baseY, newFullHeight);
    if (current !== page || pageLoading || gen !== navGen) return;
    if (page.viewKey !== (await viewKey(tab))) return;

    const oldCount = page.tiles.length;
    page.tiles.splice(baseIndex, oldCount - baseIndex, ...newTiles);
    page.hashes.length = baseIndex; // 撮り直した末尾のhashは無効
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
    pageWidth: getViewport().width,
  });
  client.send(frame.data);
}

async function startScreencast(): Promise<void> {
  const { page, cdp } = getActivePage();
  const view = getViewport();
  liveFrameInFlight = false;
  latestLiveFrame = undefined;
  await cdp.send("Page.startScreencast", {
    format: "jpeg",
    quality: 40,
    maxWidth: Math.round(view.width * view.scale),
    maxHeight: Math.round(view.height * view.scale),
    everyNthFrame: 2,
  });
  // 静止ページでは最初のフレームが来ないことがあるため、強制的に再描画させる
  // （即時往復だとコンポジタに拾われる前に相殺されるので1フレーム分待つ）
  await page
    .evaluate(async () => {
      window.scrollBy(0, 1);
      await new Promise((r) => setTimeout(r, 60));
      window.scrollBy(0, -1);
    })
    .catch(() => {});
}

async function switchMode(next: Mode): Promise<void> {
  if (next === mode) return;
  const { cdp } = getActivePage();
  const prev = mode;
  mode = next;
  if (prev === "live") {
    await cdp.send("Page.stopScreencast").catch(() => {});
    latestLiveFrame = undefined;
  }
  if (prev === "vector") {
    currentList = undefined;
    assetQueue.length = 0;
  }
  if (next === "live") await startScreencast();
  // vectorモードはタイルを持たない。抱えたままだと元PNGを掴み続ける
  else if (next === "vector") {
    setCurrent(undefined);
    await extractAndSend();
  } else void captureAndSend();
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
          "button",
          "submit",
          "checkbox",
          "radio",
          "file",
          "image",
          "range",
          "color",
          "reset",
          "hidden",
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

// ---- タブ ----

// キャプチャ状態もライブのscreencastも表示中タブの分しか持たないので、
// 背景タブのイベントはidで弾く
let shownTabId = "";

function sendTabs(): void {
  send({
    type: "tabs",
    tabs: getTabs().map((t) => ({ id: t.id, title: t.title, url: t.url })),
    activeId: getActiveTabId(),
  });
}

async function activateTab(previous: Tab | undefined): Promise<void> {
  if (previous && mode === "live") {
    await previous.cdp.send("Page.stopScreencast").catch(() => {});
  }
  shownTabId = getActiveTabId();
  setCurrent(undefined);
  pageLoading = false;
  navGen++;
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

function attachTab(tab: Tab): void {
  // ライブモード: Chromeへは即Ackして生成を止めず、常に最新フレームだけを保持。
  // クライアントへはliveAckが返ってくるまで次を送らない（1枚ずつ、古いフレームは捨てる）
  tab.cdp.on("Page.screencastFrame", (params) => {
    void tab.cdp.send("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => {});
    if (tab.id !== getActiveTabId()) return;
    liveMetaScrollY = Math.round(params.metadata.scrollOffsetY);
    latestLiveFrame = {
      data: Buffer.from(params.data, "base64"),
      scrollY: liveMetaScrollY,
    };
    trySendLiveFrame();
  });

  tab.page.on("load", () => {
    tab.url = tab.page.url();
    void tab.page
      .title()
      .then((title) => {
        tab.title = title;
        sendTabs();
      })
      .catch(() => {});
    if (tab.id !== getActiveTabId()) return;
    pageLoading = false;
    void sendNavState(false);
    send({ type: "focus", kind: "none" }); // 新しいページにフォーカスは残らない
    if (mode === "page") void captureAndSend();
    else if (mode === "vector") void extractAndSend();
  });

  let loadingTimeout: NodeJS.Timeout | undefined;
  tab.page.on("framenavigated", (frame) => {
    if (frame !== tab.page.mainFrame()) return;
    tab.url = frame.url();
    sendTabs();
    if (tab.id !== getActiveTabId()) return;
    pageLoading = true;
    navGen++;
    // リンクタップ等での遷移でも旧ページの未送信タイルを破棄する
    current?.pending.clear();
    // 同一ドキュメント遷移（pushState等）ではloadが来ないため安全弁で解除する。
    // このままでは誰も撮り直さないので、ここで撮り直す
    clearTimeout(loadingTimeout);
    loadingTimeout = setTimeout(() => {
      pageLoading = false;
      if (mode === "page") void captureAndSend();
      else if (mode === "vector") void extractAndSend();
    }, 5000);
    void sendNavState(true);
  });

  // 一覧からの除去はbrowser.ts側で済んでいる
  tab.page.on("close", () => {
    for (const [key, cached] of pages) {
      if (cached.viewKey.startsWith(`${tab.id}:`)) pages.delete(key);
    }
    sendTabs();
    if (getActiveTabId() !== shownTabId) void activateTab(undefined);
  });
}

async function handleMsg(msg: ClientMsg): Promise<void> {
  const { page } = getActivePage();
  switch (msg.type) {
    case "hello": {
      send({ type: "helloAck", ver: 1, sessionId: randomUUID() });
      // 別のキャッシュを持つクライアントに変わったら、送信済みの記憶は当てにならない
      if (msg.cacheId !== clientCacheId) {
        clientCacheId = msg.cacheId;
        clientTiles.clear();
        clientCacheUsed = 0;
      }
      clientCacheLimit = Number.isFinite(msg.cacheBytes)
        ? Math.min(Math.max(msg.cacheBytes, 1 << 20), 1 << 28)
        : clientCacheLimit;
      // 画面には何も出ていないので、復帰であってもpageBeginから送り直す
      setCurrent(undefined);
      await setViewport(clampViewport(msg.viewportW, msg.viewportH, msg.dpr));
      shownTabId = getActiveTabId();
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
      liveFrameInFlight = false;
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
      // 遷移直後は前のページ向けの通知が遅れて届く
      if (!current || msg.pageId !== current.pageId) break;
      current.scrollY = msg.y; // 送信キューの優先順位とpageExtendの判定に使う
      void maybeExtend();
      break;
    }
    case "activate": {
      if (mode !== "vector" || msg.listId !== currentList?.listId) break;
      const at = await nodeCenter(msg.nodeId);
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
        if (hash !== undefined && clientTiles.has(hash)) {
          send({ type: "assetRef", listId: list.listId, nodeId, hash });
          continue;
        }
        if (!assetQueue.includes(nodeId)) assetQueue.push(nodeId);
      }
      void pumpAssets();
      break;
    }
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

async function main(): Promise<void> {
  await startBrowser(attachTab);

  // 表示リストのJSONは圧縮で3分の1以下になる。閾値より小さいフレームは素通しする
  const wss = new WebSocketServer({
    port: PORT,
    perMessageDeflate: { threshold: 2048 },
  });
  wss.on("connection", (ws, req) => {
    const token = new URL(req.url ?? "/", "ws://localhost").searchParams.get("token");
    if (token !== config.token) {
      console.log("client rejected: bad token");
      ws.close(CLOSE_UNAUTHORIZED, "unauthorized");
      return;
    }
    console.log("client connected");
    client?.close(CLOSE_SUPERSEDED, "superseded");
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
