import { WebSocket } from "ws";
import { getActivePage, getViewport } from "../browser.ts";
import { mode } from "../state.ts";
import { client, send } from "../wire.ts";

// ---- ライブモード（Page.startScreencast） ----
//
// フレームはアプリレベルの liveAck で 1 枚ずつ送る。
// TCP ソケットバッファに任せると 300kbps では数十秒分のフレームが滞留し、
// WS の ping/pong まで埋もれてクライアントがタイムアウト切断するため。

let liveFrameInFlight = false; // クライアントの liveAck 待ち
let latestLiveFrame: { data: Buffer; scrollY: number } | undefined;
export let liveMetaScrollY = 0; // 最後のフレーム時点の実ページ scrollY（ライブ中のスクロール差分計算用）

export function setLiveFrameInFlight(next: boolean): void {
  liveFrameInFlight = next;
}

export function clearLiveFrame(): void {
  latestLiveFrame = undefined;
}

export function pushLiveFrame(data: Buffer, scrollY: number): void {
  liveMetaScrollY = scrollY;
  latestLiveFrame = { data, scrollY: liveMetaScrollY };
  trySendLiveFrame();
}

export function trySendLiveFrame(): void {
  if (mode !== "live" || liveFrameInFlight) return;
  const frame = latestLiveFrame;
  if (!frame || client?.readyState !== WebSocket.OPEN) return;
  latestLiveFrame = undefined;
  liveFrameInFlight = true;
  send({
    type: "liveFrameHeader",
    format: "jpeg",
    byteLength: frame.data.byteLength,
    scrollY: frame.scrollY,
    pageWidth: getViewport().width,
  });
  client.send(frame.data);
}

export async function startScreencast(): Promise<void> {
  const { page, cdp } = getActivePage();
  const view = getViewport();
  liveFrameInFlight = false;
  latestLiveFrame = undefined;
  await cdp.send("Page.startScreencast", {
    format: "jpeg",
    quality: 40,
    maxWidth: Math.round(view.width * view.scale),
    maxHeight: Math.round(view.height * view.scale),
    everyNthFrame: 2,
  });
  // 静止ページでは最初のフレームが来ないことがあるため、強制的に再描画させる
  // （即時往復だとコンポジタに拾われる前に相殺されるので1フレーム分待つ）
  await page
    .evaluate(async () => {
      window.scrollBy(0, 1);
      await new Promise((r) => setTimeout(r, 60));
      window.scrollBy(0, -1);
    })
    .catch(() => {});
}
