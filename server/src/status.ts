import { getActivePage, getTabs, getActiveTabId } from "./browser.ts";
import { send } from "./wire.ts";

export function sendTabs(): void {
  send({
    type: "tabs",
    tabs: getTabs().map((t) => ({ id: t.id, title: t.title, url: t.url })),
    activeId: getActiveTabId(),
  });
}

// ---- フォーカス検知（IME 表示制御） ----

export async function sendFocusState(): Promise<void> {
  const { page } = getActivePage();
  try {
    const kind = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return "none";
      const tag = el.tagName.toLowerCase();
      if (tag === "textarea" || el.isContentEditable) return "text";
      if (tag === "input") {
        const type = (el as HTMLInputElement).type;
        const nonText = [
          "button",
          "submit",
          "checkbox",
          "radio",
          "file",
          "image",
          "range",
          "color",
          "reset",
          "hidden",
        ];
        return nonText.includes(type) ? "none" : "text";
      }
      return "none";
    });
    send({ type: "focus", kind: kind as "text" | "none" });
  } catch {
    // ナビゲーション中などの評価失敗は無視（次のタップで再評価される）
  }
}

export async function sendNavState(loading: boolean): Promise<void> {
  const { page, cdp } = getActivePage();
  try {
    const hist = await cdp.send("Page.getNavigationHistory");
    send({
      type: "navState",
      canGoBack: hist.currentIndex > 0,
      canGoForward: hist.currentIndex < hist.entries.length - 1,
      url: page.url(),
      loading,
    });
  } catch (e) {
    console.error("navState failed:", e);
  }
}
