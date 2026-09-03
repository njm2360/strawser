import sharp from "sharp";
import { getActivePage, getViewport } from "./browser.ts";

// 1タイルの送信画像の高さ（px）。タイル1枚あたりのバイト数をここで一定に保つので、
// 解像度倍率が上がるとページ座標でのタイル高さはその分薄くなる
const TILE_IMAGE_HEIGHT = 2048;

export function getTileHeight(): number {
  return Math.round(TILE_IMAGE_HEIGHT / getViewport().scale);
}

// 初回キャプチャの高さ上限。300kbps で「全タイル 15 秒以内」を満たすため
// 2 タイル（≒300KB ≒ 11秒）に抑え、以降は scrollPos 連動の pageExtend で継ぎ足す
export function getInitialCaptureHeight(): number {
  return getTileHeight() * 2;
}
// 1 回の pageExtend で継ぎ足す高さ
export function getExtendChunk(): number {
  return getTileHeight() * 2;
}

const WEBP_QUALITY = 30;
const WEBP_EFFORT = 6;

export interface Tile {
  data: Buffer; // WebP
  sig: Buffer;  // 差分判定用の縮小グレースケール署名（raw ピクセル）
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
    const data = await img
      .clone()
      .extract(region)
      .webp({ quality: WEBP_QUALITY, effort: WEBP_EFFORT })
      .toBuffer();
    const sig = await img
      .clone()
      .extract(region)
      .resize({ width: 90 })
      .greyscale()
      .raw()
      .toBuffer();
    tiles.push({ data, sig });
  }
  return tiles;
}

export async function captureFullPage(
  maxHeight: number = getInitialCaptureHeight(),
): Promise<FullPageCapture> {
  const minHeight = getViewport().height;
  let contentHeight = Math.max(await measureContentHeight(), minHeight);
  await triggerLazyLoad(0, Math.min(contentHeight, maxHeight));
  // 遅延読み込みで高さが変わることがあるため測り直す
  contentHeight = Math.max(await measureContentHeight(), minHeight);
  const fullHeight = Math.min(contentHeight, maxHeight);
  const tiles = await captureRegion(0, fullHeight);
  return { fullHeight, contentHeight, tiles };
}
