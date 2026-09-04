import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { getViewport, getActiveTab, type Tab } from "../browser.ts";
import { triggerLazyLoad } from "../capture.ts";
import { clientTiles, rememberHash } from "../clientCache.ts";
import { mode, pageLoading, navGen, viewKey } from "../state.ts";
import { extractList, captureAssets, diffOps, extendsTables } from "../vector.ts";
import { send, client } from "../wire.ts";
import type { ServerMsg, DisplayList } from "../protocol.ts";

// vectorモード。ページを描画コマンドの列として送り、画像だけラスタにする

interface CurrentList {
  listId: string;
  viewKey: string;
  scrollY: number; // クライアントのローカルスクロール位置（ページ座標）
  // クライアントが持っている表示リスト。次の差分の土台
  list: DisplayList;
  // nodeIdから送信済み画像のhash
  assets: Map<number, string>;
  // バイト列を失ったとクライアントが言ってきたnodeId。assetRefで返しても絵は戻らない
  forceRaw: Set<number>;
  // 背景として撮るnodeId。撮影中は子孫を隠す
  background: Set<number>;
}

// 履歴エントリ単位の表示リスト。戻る・進む・タブ切替はここを土台に差分で済む。
// クライアントも同じ鍵・同じ上限・同じ捨て方で持つ（食い違えばrequestListで戻る）。
// 1つあたりサーバーで数百KB、クライアントで1〜2MB
const LIST_CACHE_LIMIT = 6;
export const lists = new Map<string, CurrentList>(); // 挿入順がLRU

export let currentList: CurrentList | undefined;
let extracting = false;
let extractPending = false;

// 表示中のエントリが変わったら、前のエントリ向けの画像要求は宛先を失う
function setCurrentList(next: CurrentList): void {
  if (currentList !== next) assetQueue.length = 0;
  currentList = next;
  lists.delete(next.viewKey); // 再挿入して最近使った順にする
  lists.set(next.viewKey, next);
  for (const [key, old] of lists) {
    if (lists.size <= LIST_CACHE_LIMIT) break;
    if (old !== currentList) lists.delete(key);
  }
}

export function clearCurrentList(): void {
  currentList = undefined;
}

export async function extractAndSend(): Promise<void> {
  if (extracting) {
    extractPending = true;
    return;
  }
  extracting = true;
  try {
    do {
      extractPending = false;
      await extractOnce();
    } while (extractPending);
  } catch (e) {
    console.error("extract failed:", e);
  } finally {
    extracting = false;
  }
}

// 丸ごと送るバイト数に対してこの割合を超えた差分は使わない
const DIFF_LIMIT = 0.7;

async function extractOnce(): Promise<void> {
  const gen = navGen;
  const tab = getActiveTab();
  const key = await viewKey(tab);
  // 送るのは撮り直したリストなので、nodeIdと実ページの対応は保たれる
  const base = lists.get(key);
  const snap = await extractList(base?.list);
  // 抽出中に遷移していたら、載っているのは次のページの中身
  if (gen !== navGen) return;
  const listId = randomUUID();
  const url = tab.page.url();
  const background = new Set(snap.rects.filter((r) => r.bg).map((r) => r.nodeId));
  const full: ServerMsg = {
    type: "vectorBegin",
    listId,
    viewKey: key,
    url,
    title: snap.title,
    list: snap.list,
  };
  const fullBytes = JSON.stringify(full).length;
  const diff =
    base && extendsTables(base.list, snap.list)
      ? ({
          type: "vectorDiff",
          listId,
          viewKey: key,
          baseId: base.listId,
          url,
          title: snap.title,
          pageWidth: snap.list.pageWidth,
          fullHeight: snap.list.fullHeight,
          bg: snap.list.bg,
          colors: snap.list.colors.slice(base.list.colors.length),
          fonts: snap.list.fonts.slice(base.list.fonts.length),
          ops: diffOps(base.list.ops, snap.list.ops),
        } satisfies ServerMsg)
      : undefined;
  const diffBytes = diff ? JSON.stringify(diff).length : Infinity;
  console.log(
    `vector ${key}: ${snap.list.ops.length} ops, ${snap.rects.length} images, ` +
      `${snap.list.colors.length} colors, ${snap.list.fonts.length} fonts, ` +
      `${fullBytes} bytes` +
      (diff ? ` (diff ${diffBytes})` : ""),
  );
  if (base && diff && diffBytes < fullBytes * DIFF_LIMIT) {
    // 差し込まれた画像は位置か大きさが変わっている。撮り直させる
    for (const chunk of diff.ops) {
      for (const op of chunk.o ?? []) {
        if (op.t === 2 && op.i !== undefined) base.assets.delete(op.i);
      }
    }
    base.listId = listId;
    base.list = snap.list;
    base.background = background;
    setCurrentList(base);
    send(diff);
    return;
  }
  // 表を置き直せず丸ごと送るときも、クライアントは同じ文書なら位置を保つ
  const scrollY = base?.scrollY ?? 0;
  setCurrentList({
    listId,
    viewKey: key,
    scrollY,
    list: snap.list,
    assets: new Map(),
    forceRaw: new Set(),
    background,
  });
  send(full);
}

/** 撮らずに前のリストを引き継がせる */
function restoreList(entry: CurrentList, tab: Tab): void {
  const listId = randomUUID();
  console.log(`restore ${entry.viewKey}: ${entry.list.ops.length} ops kept`);
  send({
    type: "vectorDiff",
    listId,
    viewKey: entry.viewKey,
    baseId: entry.listId,
    url: tab.page.url(),
    title: tab.title,
    pageWidth: entry.list.pageWidth,
    fullHeight: entry.list.fullHeight,
    bg: entry.list.bg,
    colors: [],
    fonts: [],
    ops: [{ a: 0, n: entry.list.ops.length }],
  });
  entry.listId = listId;
  setCurrentList(entry);
}

// loadの時点ではまだ載っていない枝があり、版面も0.5pxほど揺れる
const SETTLE_REFRESH_MS = 600;

// 前に見た場所ならそのリストをそのまま出しておく。
// つなぎのあいだnodeIdは実ページと対応していないので、タップと画像要求は当たらない
export async function extractLoaded(): Promise<void> {
  const tab = getActiveTab();
  const cached = lists.get(await viewKey(tab));
  if (cached) restoreList(cached, tab);
  else await extractAndSend();
  setTimeout(() => {
    if (!pageLoading && mode === "vector") void extractAndSend();
  }, SETTLE_REFRESH_MS);
}

// captureAssetsは帯ごとに1枚撮るので、まとめて渡すほどスクリーンショットが減る
const ASSET_BATCH = 8;
export const assetQueue: number[] = [];
let pumpingAssets = false;

// 読んでいる位置から近い順に並べ替える。上へ戻る分は後回しでよいので距離を倍に見る
// （pickNextTileと同じ測り方）。近いものが固まるので撮影の枚数も減る
function sortAssetQueue(list: CurrentList): void {
  const top = list.scrollY;
  const tops = new Map<number, number>();
  for (const op of list.list.ops) {
    if (op.t === 2 && op.i !== undefined) tops.set(op.i, op.b[1] ?? 0);
  }
  const distance = (nodeId: number): number => {
    const y = tops.get(nodeId);
    if (y === undefined) return Number.MAX_SAFE_INTEGER; // 差分で表示リストから消えた画像
    return y >= top ? y - top : (top - y) * 2;
  };
  assetQueue.sort((a, b) => distance(a) - distance(b));
}

export async function pumpAssets(): Promise<void> {
  if (pumpingAssets) return;
  pumpingAssets = true;
  try {
    while (assetQueue.length > 0 && currentList && client?.readyState === WebSocket.OPEN) {
      const list = currentList;
      const ws = client;
      // 撮っているあいだにも位置は動く。1回分ごとに選び直す
      sortAssetQueue(list);
      const assets = await captureAssets(assetQueue.splice(0, ASSET_BATCH), list.background);
      // 切り出しを待つ間にページが差し替わっていたら送らない
      if (currentList !== list) break;
      for (const asset of assets) {
        const held = !list.forceRaw.delete(asset.nodeId) && clientTiles.has(asset.hash);
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

// 無限スクロールと遅延読み込みの継ぎ足し。表示リストは文書全体を写すので、
// 伸びるかどうかは実ページ次第

// 伸びないページで実ページのスクロールを繰り返さないための間隔
const VECTOR_PROBE_MS = 1500;

let extendingVector = false;
let lastVectorProbe = 0;

// 表示リストのfullHeightと同じ測り方。Page.getLayoutMetricsとは端数が合わない
const documentHeight = (): Promise<number> =>
  getActiveTab().page.evaluate(() => Math.ceil(document.documentElement.scrollHeight));

export async function maybeExtendVector(): Promise<void> {
  const list = currentList;
  if (!list || extendingVector || extracting || pageLoading || mode !== "vector") return;
  const view = getViewport();
  if (list.scrollY + view.height * 1.5 < list.list.fullHeight) return;
  const now = Date.now();
  if (now - lastVectorProbe < VECTOR_PROBE_MS) return;
  lastVectorProbe = now;
  extendingVector = true;
  const gen = navGen;
  try {
    const tab = getActiveTab();
    if (list.viewKey !== (await viewKey(tab))) return;
    const before = list.list.fullHeight;
    await tab.page.evaluate((y) => window.scrollTo(0, y), list.scrollY).catch(() => {});
    await tab.page.waitForTimeout(300);
    const height = await documentHeight();
    if (currentList !== list || pageLoading || gen !== navGen) return;
    if (height <= before) return;
    // 一巡させるのは2画面ぶんまで。青天井にすると、無限スクロールのサイトでは
    // 一巡しているあいだにさらに伸びて止まらなくなる
    await triggerLazyLoad(before, Math.min(height, before + view.height * 2));
    if (currentList !== list || pageLoading || gen !== navGen) return;
    console.log(`vector extend ${list.viewKey}: ${before} -> ${height}`);
    await extractAndSend();
  } catch (e) {
    console.error("vector extend failed:", e);
  } finally {
    extendingVector = false;
  }
}
