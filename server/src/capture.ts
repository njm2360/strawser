import sharp from "sharp";
import { getActivePage, PAGE_WIDTH, PAGE_HEIGHT } from "./browser.ts";

// タイル高さ（720px 基準のページ座標）
export const TILE_HEIGHT = 2048;

// 初回キャプチャの高さ上限。300kbps で「全タイル 15 秒以内」を満たすため
// 2 タイル（≒300KB ≒ 11秒）に抑え、以降は scrollPos 連動の pageExtend で継ぎ足す
export const INITIAL_CAPTURE_HEIGHT = TILE_HEIGHT * 2;
// 1 回の pageExtend で継ぎ足す高さ
export const EXTEND_CHUNK = TILE_HEIGHT * 2;

// 転送画像の解像度倍率と品質。DPR=2 (1440px幅) は帯域的に無理があるため転送は 720px 幅
const CAPTURE_SCALE = 1;
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
  for (let y = fromY; y < toY; y += PAGE_HEIGHT) {
    await page.evaluate((v) => window.scrollTo(0, v), y).catch(() => {});
    await page.waitForTimeout(80);
  }
  await page.evaluate((v) => window.scrollTo(0, v), prevY).catch(() => {});
  await page.waitForTimeout(150);
}

// [fromY, toY) を縦 TILE_HEIGHT ごとのタイルに分割してキャプチャする。
// fromY は TILE_HEIGHT の倍数であること
export async function captureRegion(fromY: number, toY: number): Promise<Tile[]> {
  const { cdp } = getActivePage();
  const height = toY - fromY;
  const shot = await cdp.send("Page.captureScreenshot", {
    format: "png",
    clip: { x: 0, y: fromY, width: PAGE_WIDTH, height, scale: CAPTURE_SCALE },
    captureBeyondViewport: true,
  });
  const png = Buffer.from(shot.data, "base64");
  const img = sharp(png);

  const tiles: Tile[] = [];
  for (let offsetY = 0; offsetY < height; offsetY += TILE_HEIGHT) {
    const tileHeight = Math.min(TILE_HEIGHT, height - offsetY);
    const region = {
      left: 0,
      top: offsetY * CAPTURE_SCALE,
      width: PAGE_WIDTH * CAPTURE_SCALE,
      height: tileHeight * CAPTURE_SCALE,
    };
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
  maxHeight: number = INITIAL_CAPTURE_HEIGHT,
): Promise<FullPageCapture> {
  let contentHeight = Math.max(await measureContentHeight(), PAGE_HEIGHT);
  await triggerLazyLoad(0, Math.min(contentHeight, maxHeight));
  // 遅延読み込みで高さが変わることがあるため測り直す
  contentHeight = Math.max(await measureContentHeight(), PAGE_HEIGHT);
  const fullHeight = Math.min(contentHeight, maxHeight);
  const tiles = await captureRegion(0, fullHeight);
  return { fullHeight, contentHeight, tiles };
}
