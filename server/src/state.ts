import { randomUUID } from "node:crypto";
import type { Tab } from "./browser.ts";
import type { Mode } from "./protocol.ts";

export let mode: Mode = "page";
export let pageLoading = false; // メインフレームのナビゲーション進行中か
export let navGen = 0; // ナビゲーション世代。framenavigated ごとに増える（非同期処理の失効判定用）

export function setMode(next: Mode): void {
  mode = next;
}

export function setPageLoading(next: boolean): void {
  pageLoading = next;
}

export function bumpNavGen(): void {
  navGen++;
}

// 履歴エントリごとに1つ。戻る・進むでは同じ鍵に戻ってくる。
// 履歴が引けないときは、別々のページが同じ鍵に収まらないよう毎回違う鍵にする
export async function viewKey(tab: Tab): Promise<string> {
  const hist = await tab.cdp.send("Page.getNavigationHistory").catch(() => undefined);
  const entry = hist?.entries[hist.currentIndex]?.id;
  return `${tab.id}:${entry ?? randomUUID()}`;
}
