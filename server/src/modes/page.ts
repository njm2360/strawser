import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { getViewport, getActiveTab, type Tab, type Viewport } from "../browser.ts";
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
} from "../capture.ts";
import { clientTiles, rememberHash } from "../clientCache.ts";
import { mode, pageLoading, navGen, viewKey } from "../state.ts";
import { client, send } from "../wire.ts";

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

// 履歴エントリ単位のページ状態。戻る・進む・タブ切替を撮り直しにしないために持つ。
// 1ページあたりタイルの署名とWebPバイト列で数百KB
const PAGE_CACHE_LIMIT = 30;
export const pages = new Map<string, CurrentPage>(); // 挿入順がLRU

export let current: CurrentPage | undefined;
let pumping = false;

// 表示から外れたページは未符号化タイルが元PNGを掴んだままなので手放させる。
// 戻ってきたときは差分キャプチャで撮り直して埋める
export function setCurrent(next: CurrentPage | undefined): void {
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
export async function pumpTiles(): Promise<void> {
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

export async function captureAndSend(): Promise<void> {
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

// ---- pageExtend: スクロールが画像末尾に近づいたら追加分を継ぎ足す ----

let extending = false;
let lastExtendProbe = 0;

export async function maybeExtend(): Promise<void> {
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
