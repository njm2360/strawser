import { getActivePage, PAGE_HEIGHT } from "./browser.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// タッチ注入はビューポート座標で行うため、ページ座標から実ページの scrollY を差し引く。
// 対象がビューポート外なら実ページをスクロールして視界に入れる
// （pageExtend の遅延読み込みで実ページがスクロールしていることがある）
async function toViewportY(pageY: number): Promise<number> {
  const { page } = getActivePage();
  let scrollY: number = await page.evaluate(() => window.scrollY);
  if (pageY - scrollY < 0 || pageY - scrollY > PAGE_HEIGHT - 1) {
    const target = Math.max(0, pageY - PAGE_HEIGHT / 2);
    await page.evaluate((y) => window.scrollTo(0, y), target);
    await sleep(100);
    scrollY = await page.evaluate(() => window.scrollY);
  }
  return pageY - scrollY;
}

// マウスイベントではなくタッチにする（モバイルサイトの挙動を正しく引き出すため）
async function touch(x: number, pageY: number, holdMs: number): Promise<void> {
  const { cdp } = getActivePage();
  const y = await toViewportY(pageY);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y }],
  });
  await sleep(holdMs);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
}

export async function tap(x: number, y: number): Promise<void> {
  await touch(x, y, 50);
}

export async function longPress(x: number, y: number): Promise<void> {
  await touch(x, y, 600);
}

// クライアントの IME で確定した文字列をまとめて注入する（1 キーずつ送らない）
export async function insertText(text: string): Promise<void> {
  const { cdp } = getActivePage();
  await cdp.send("Input.insertText", { text });
}

const KEY_DEFS = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8, text: undefined },
} as const;

export async function pressKey(key: keyof typeof KEY_DEFS): Promise<void> {
  const { cdp } = getActivePage();
  const def = KEY_DEFS[key];
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: def.key,
    code: def.code,
    windowsVirtualKeyCode: def.keyCode,
    nativeVirtualKeyCode: def.keyCode,
    ...(def.text !== undefined ? { text: def.text, unmodifiedText: def.text } : {}),
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: def.key,
    code: def.code,
    windowsVirtualKeyCode: def.keyCode,
    nativeVirtualKeyCode: def.keyCode,
  });
}
