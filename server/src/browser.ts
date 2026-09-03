import path from "node:path";
import { chromium, type BrowserContext, type CDPSession, type Page } from "playwright";

// ブラウザ側のDPR。これを超えて撮っても引き伸ばしなので転送解像度の上限でもある
export const DEVICE_SCALE = 2;

export interface Viewport {
  width: number;  // エミュレーション幅（CSS px）。クライアントの表示幅dpをそのまま使う
  height: number;
  scale: number;  // 送信画像のCSS pxあたりのピクセル数
}

// クライアントのhelloが来るまでの暫定値
let viewport: Viewport = { width: 412, height: 900, scale: DEVICE_SCALE };

export function getViewport(): Viewport {
  return viewport;
}

// 値が欠けた・壊れたクライアントでもNaNをcaptureScreenshotまで通さない
const clamp = (v: number, lo: number, hi: number, fallback: number): number =>
  Number.isFinite(v) ? Math.min(Math.max(v, lo), hi) : fallback;

export function clampViewport(width: number, height: number, dpr: number): Viewport {
  return {
    width: Math.round(clamp(width, 240, 2048, viewport.width)),
    height: Math.round(clamp(height, 320, 2048, viewport.height)),
    scale: clamp(dpr, 1, DEVICE_SCALE, DEVICE_SCALE),
  };
}

export async function setViewport(next: Viewport): Promise<void> {
  viewport = next;
  await active?.page.setViewportSize({ width: next.width, height: next.height });
}

// ログインセッション等を永続化するユーザーデータディレクトリ
const USER_DATA_DIR = path.resolve(import.meta.dirname, "..", "user-data");

export interface ActivePage {
  page: Page;
  cdp: CDPSession;
}

let context: BrowserContext | undefined;
let active: ActivePage | undefined;

export async function startBrowser(): Promise<void> {
  context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: DEVICE_SCALE,
    isMobile: true,
    hasTouch: true,
    userAgent:
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
    locale: "ja-JP",
  });
  const page = context.pages()[0] ?? (await context.newPage());
  const cdp = await context.newCDPSession(page);
  active = { page, cdp };
}

export function getActivePage(): ActivePage {
  if (!active) throw new Error("browser not started");
  return active;
}

export async function stopBrowser(): Promise<void> {
  active = undefined;
  await context?.close().catch(() => {});
  context = undefined;
}
