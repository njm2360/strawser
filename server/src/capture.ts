import sharp, { type Region, type Sharp } from "sharp";
import { getActivePage, getViewport } from "./browser.ts";

// 1タイルの送信画像の高さ（px）。タイル1枚あたりのバイト数をここで一定に保つので、
// 解像度倍率が上がるとページ座標でのタイル高さはその分薄くなる。
// 細かいほど再キャプチャの再送量が減り、画面も上から順に埋まる。
// 薄くしても総バイト数はほとんど増えない（4倍細かくして3%程度）
const TILE_IMAGE_HEIGHT = 256;

// 1回のpageExtendで足す高さ（送信画像のpx）。
// 300kbpsで先読みが操作の邪魔にならない量
const CHUNK_IMAGE_HEIGHT = 2048;

export function getTileHeight(): number {
  return Math.round(TILE_IMAGE_HEIGHT / getViewport().scale);
}

// タイル境界に揃える。半端な高さで切るとタイルindexの意味がずれる
function chunkHeight(): number {
  return getTileHeight() * Math.round(CHUNK_IMAGE_HEIGHT / TILE_IMAGE_HEIGHT);
}

// 先頭1画面は実ページが表示している位置そのものなので遅延読み込みの一巡（実測440ms）が
// 要らない。ここに絞れば最初のタイルをすぐ送り出せる。残りはpageExtendが一巡してから足す
export function getInitialCaptureHeight(): number {
  const tile = getTileHeight();
  return Math.ceil(getViewport().height / tile) * tile;
}
export function getExtendChunk(): number {
  return chunkHeight();
}

const WEBP_QUALITY = 30;
const WEBP_EFFORT = 6;

const SIG_WIDTH = 90;

export interface Tile {
  sig: Buffer; // 差分判定用の縮小グレースケール署名（rawピクセル）
  // WebPへのエンコードは送信直前まで遅らせる。再キャプチャでは大半のタイルが
  // 変化なしで捨てられるうえ、送る分も優先順の高いものから先に符号化したい
  encode: () => Promise<Buffer>;
}

// 符号化が済んだ時点で元PNGへの参照を切る。タイルは差し替わるまでCurrentPageに残るので、
// 掴んだままだとキャプチャ世代ぶんのPNGが積み上がる
function makeTile(source: Sharp, region: Region, sig: Buffer): Tile {
  let src: Sharp | undefined = source;
  let inflight: Promise<Buffer> | undefined;
  return {
    sig,
    encode: () =>
      (inflight ??= src!
        .clone()
        .extract(region)
        .webp({ quality: WEBP_QUALITY, effort: WEBP_EFFORT })
        .toBuffer()
        .then((data) => {
          src = undefined;
          return data;
        })),
  };
}

export interface FullPageCapture {
  fullHeight: number;    // 今回キャプチャ済みの高さ（ページ座標）
  contentHeight: number; // ページ全体の高さ（fullHeight より大きければ未取得部分がある）
  tiles: Tile[];         // tiles[i] は offsetY = i * TILE_HEIGHT
}

// WebP のバイト列はエンコード揺らぎで同一内容でも一致しないため、
// 縮小グレースケールのピクセル比較で「意味のある変化」だけを検出する。
// 大きく変わったピクセルが 0.5% を超えたら変化ありとみなす
export function tilesDiffer(a: Tile, b: Tile): boolean {
  if (a.sig.length !== b.sig.length) return true;
  let changed = 0;
  for (let i = 0; i < a.sig.length; i++) {
    if (Math.abs((a.sig[i] ?? 0) - (b.sig[i] ?? 0)) > 16) changed++;
  }
  return changed > a.sig.length * 0.005;
}

export async function measureContentHeight(): Promise<number> {
  const { cdp } = getActivePage();
  const metrics = await cdp.send("Page.getLayoutMetrics");
  return Math.ceil(metrics.cssContentSize.height);
}

// [fromY, toY) を実ページで一巡スクロールして遅延読み込み画像を発火させ、元の位置に戻す。
// これをしないとビューポート外の lazy-load 画像が空枠のままキャプチャされる
export async function triggerLazyLoad(fromY: number, toY: number): Promise<void> {
  const { page } = getActivePage();
  const prevY: number = await page.evaluate(() => window.scrollY);
  for (let y = fromY; y < toY; y += getViewport().height) {
    await page.evaluate((v) => window.scrollTo(0, v), y).catch(() => {});
    await page.waitForTimeout(80);
  }
  await page.evaluate((v) => window.scrollTo(0, v), prevY).catch(() => {});
  await page.waitForTimeout(150);
}

// [fromY, toY)を縦getTileHeight()ごとのタイルに分割してキャプチャする。
// fromYはタイル高さの倍数であること
export async function captureRegion(fromY: number, toY: number): Promise<Tile[]> {
  const { cdp } = getActivePage();
  const { width: pageWidth, scale } = getViewport();
  const step = getTileHeight();
  const height = toY - fromY;
  const shot = await cdp.send("Page.captureScreenshot", {
    format: "png",
    clip: { x: 0, y: fromY, width: pageWidth, height, scale },
    captureBeyondViewport: true,
  });
  const png = Buffer.from(shot.data, "base64");
  const img = sharp(png);
  // CDPの丸め方はこちらの計算と一致するとは限らないので、実寸に合わせて切り出す
  const meta = await img.metadata();
  const imgWidth = meta.width ?? Math.round(pageWidth * scale);
  const imgHeight = meta.height ?? Math.round(height * scale);

  const tiles: Tile[] = [];
  for (let offsetY = 0; offsetY < height; offsetY += step) {
    const tileHeight = Math.min(step, height - offsetY);
    const top = Math.min(Math.round(offsetY * scale), imgHeight);
    const bottom = Math.min(Math.round((offsetY + tileHeight) * scale), imgHeight);
    if (bottom <= top) break;
    const region = { left: 0, top, width: imgWidth, height: bottom - top };
    const sig = await img
      .clone()
      .extract(region)
      .resize({ width: SIG_WIDTH })
      .greyscale()
      .raw()
      .toBuffer();
    tiles.push(makeTile(img, region, sig));
  }
  return tiles;
}

// 遅延読み込みの一巡はしない。撮るのは実ページが表示している先頭1画面か、
// 既に一巡済みの範囲の撮り直しだけ
export async function captureFullPage(
  maxHeight: number = getInitialCaptureHeight(),
): Promise<FullPageCapture> {
  const minHeight = getViewport().height;
  const contentHeight = Math.max(await measureContentHeight(), minHeight);
  const fullHeight = Math.min(contentHeight, maxHeight);
  const tiles = await captureRegion(0, fullHeight);
  return { fullHeight, contentHeight, tiles };
}
