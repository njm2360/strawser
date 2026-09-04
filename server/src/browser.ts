import { randomUUID } from "node:crypto";
import path from "node:path";
import { chromium, type BrowserContext, type CDPSession, type Page } from "playwright";

// ブラウザ側のDPR。これを超えて撮っても引き伸ばしなので転送解像度の上限でもある
export const DEVICE_SCALE = 2;

export interface Viewport {
  width: number; // エミュレーション幅（CSS px）。クライアントの表示幅dpをそのまま使う
  height: number;
  scale: number; // 送信画像のCSS pxあたりのピクセル数
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

// 背景タブは切り替え時に撮り直すので、表示中のタブだけ合わせればよい
export async function setViewport(next: Viewport): Promise<void> {
  viewport = next;
  await getActiveTab().page.setViewportSize({
    width: next.width,
    height: next.height,
  });
}

interface Clip {
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
}

async function setMetrics(cdp: CDPSession, height: number): Promise<void> {
  const landscape = viewport.width > viewport.height;
  await cdp
    .send("Emulation.setDeviceMetricsOverride", {
      mobile: true,
      width: viewport.width,
      height,
      screenWidth: viewport.width,
      screenHeight: viewport.height,
      deviceScaleFactor: DEVICE_SCALE,
      screenOrientation: landscape
        ? { angle: 90, type: "landscapePrimary" }
        : { angle: 0, type: "portraitPrimary" },
    })
    .catch(() => {});
}

// 版面を広げた直後は組み直しの途中を撮ることがある
const RELAYOUT_MS = 150;

/**
 * ページ座標の[clip.y, clip.y+clip.height)を1枚に撮る。clip.scaleは送信画像のCSS pxあたりのピクセル数。
 *
 * captureBeyondViewportはclipと併せるとページを別の版面で描き、撮り終えても
 * deviceScaleFactorを1のままにする
 */
export async function screenshotRegion(clip: Clip): Promise<Buffer | undefined> {
  const { page, cdp } = getActiveTab();
  const at: number = await page.evaluate(() => window.scrollY).catch(() => 0);
  await setMetrics(cdp, clip.height);
  await page.evaluate((y) => window.scrollTo(0, y), clip.y).catch(() => {});
  await page.waitForTimeout(RELAYOUT_MS);
  const shot = await cdp
    .send("Page.captureScreenshot", {
      format: "png",
      clip: { ...clip, scale: clip.scale / DEVICE_SCALE },
    })
    .catch(() => undefined);
  await setMetrics(cdp, viewport.height);
  await page.evaluate((y) => window.scrollTo(0, y), at).catch(() => {});
  return shot && Buffer.from(shot.data, "base64");
}

// ログインセッション等を永続化するユーザーデータディレクトリ
const USER_DATA_DIR = path.resolve(import.meta.dirname, "..", "user-data");

export const NEW_TAB_URL = "about:blank";

export interface ActivePage {
  page: Page;
  cdp: CDPSession;
}

export interface Tab extends ActivePage {
  id: string;
  // クライアントへ出すタブ一覧用。page.title()は非同期なので遷移のたびに書き戻す
  title: string;
  url: string;
}

let context: BrowserContext | undefined;
const tabs: Tab[] = [];
let activeId = "";
// 生成経路（初期タブ・クライアント要求・target=_blank）によらず同じハンドラを張らせる
let onTabOpened: (tab: Tab) => void = () => {};

// UAを書き換えてもsec-ch-uaのbrandsは実バイナリのものが出る。
// メジャーがずれると両者の矛盾がそのまま指紋になる
async function mobileUserAgent(): Promise<string> {
  const probe = await chromium.launch();
  const major = probe.version().split(".")[0];
  await probe.close();
  return (
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 " +
    `(KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`
  );
}

// TZが指定されていればIntlがそれを返す。日本語WindowsではICUがローカライズされた
// ゾーン名を引けずEtc/GMT-9のような固定オフセットに落ちるので、その値は使わない
function systemTimezone(): string | undefined {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!tz.startsWith("Etc/")) return tz;
  console.warn(`timezone resolved to ${tz}; set TZ to an IANA name such as Asia/Tokyo`);
  return undefined;
}

// NodeはWindowsでLANGを見ない
function systemLocale(): string {
  const lang = process.env.LANG?.split(".")[0]?.replace("_", "-");
  return lang || Intl.DateTimeFormat().resolvedOptions().locale;
}

// 条件が1つでも欠けるとGoogleはCAPTCHAを返す
export async function emulationOptions(
  size: { width: number; height: number } = viewport,
): Promise<Parameters<typeof chromium.launchPersistentContext>[1]> {
  const timezoneId = systemTimezone();
  return {
    // 既定のheadless shellはsec-ch-uaでHeadlessChromeを自己申告し、window.chromeも生えない
    channel: "chromium",
    args: ["--disable-blink-features=AutomationControlled"],
    viewport: { width: size.width, height: size.height },
    deviceScaleFactor: DEVICE_SCALE,
    isMobile: true,
    hasTouch: true,
    userAgent: await mobileUserAgent(),
    locale: systemLocale(),
    ...(timezoneId ? { timezoneId } : {}),
  };
}

export async function startBrowser(tabOpened: (tab: Tab) => void): Promise<void> {
  onTabOpened = tabOpened;
  context = await chromium.launchPersistentContext(USER_DATA_DIR, await emulationOptions());
  // target=_blankやwindow.openで開いたページもタブとして拾う
  context.on("page", (page) => void register(page));
  const first = context.pages()[0];
  if (first) await register(first);
  else await openTab();
}

// openTabとcontextのpageイベントが同じページに対して同時に走る。
// CDPセッション取得を待つ間に重複登録しないよう、進行中の登録を掴んでおく
const registering = new Map<Page, Promise<Tab>>();

function register(page: Page): Promise<Tab> {
  const existing = tabs.find((t) => t.page === page);
  if (existing) return Promise.resolve(existing);
  const inflight = registering.get(page);
  if (inflight) return inflight;
  const started = (async () => {
    const cdp = await context!.newCDPSession(page);
    const tab: Tab = {
      id: randomUUID(),
      page,
      cdp,
      title: "",
      url: page.url(),
    };
    tabs.push(tab);
    // ページ自身が閉じた場合（window.close等）も一覧から外す
    page.once("close", () => drop(tab.id));
    if (!activeId) activeId = tab.id;
    onTabOpened(tab);
    return tab;
  })().finally(() => registering.delete(page));
  registering.set(page, started);
  return started;
}

function drop(id: string): void {
  const index = tabs.findIndex((t) => t.id === id);
  if (index < 0) return;
  tabs.splice(index, 1);
  if (activeId !== id) return;
  // 閉じたタブの隣を選ぶ
  activeId = tabs[Math.min(index, tabs.length - 1)]?.id ?? "";
}

export function getTabs(): readonly Tab[] {
  return tabs;
}

export function getActiveTabId(): string {
  return activeId;
}

export function getActiveTab(): Tab {
  const tab = tabs.find((t) => t.id === activeId);
  if (!tab) throw new Error("browser not started");
  return tab;
}

export function getActivePage(): ActivePage {
  return getActiveTab();
}

export function selectTab(id: string): boolean {
  if (id === activeId || !tabs.some((t) => t.id === id)) return false;
  activeId = id;
  return true;
}

export async function openTab(url: string = NEW_TAB_URL): Promise<Tab> {
  const page = await context!.newPage();
  const tab = await register(page);
  activeId = tab.id;
  await page.setViewportSize({
    width: viewport.width,
    height: viewport.height,
  });
  if (url !== NEW_TAB_URL) await page.goto(url, { timeout: 30_000 }).catch(() => {});
  return tab;
}

// タブ0枚の状態を作らないので、最後の1枚は新規タブへ差し替える
export async function closeTab(id: string): Promise<void> {
  const tab = tabs.find((t) => t.id === id);
  if (!tab) return;
  if (tabs.length === 1) {
    await openTab();
  }
  await tab.page.close().catch(() => {});
  drop(id);
}

export async function stopBrowser(): Promise<void> {
  tabs.length = 0;
  activeId = "";
  await context?.close().catch(() => {});
  context = undefined;
}
