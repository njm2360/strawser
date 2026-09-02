import path from "node:path";
import { chromium, type BrowserContext, type CDPSession, type Page } from "playwright";

export const PAGE_WIDTH = 720;
export const PAGE_HEIGHT = 1280;
export const DEVICE_SCALE = 2;

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
    viewport: { width: PAGE_WIDTH, height: PAGE_HEIGHT },
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
