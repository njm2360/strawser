import { WebSocket } from "ws";
import type { ServerMsg } from "./protocol.ts";

// セッションは 1 つ、後勝ち
export let client: WebSocket | undefined;

export function setClient(next: WebSocket | undefined): void {
  client = next;
}

// Playwright のエラー文字列には ANSI エスケープが混ざるため除去してから送る
export const stripAnsi = (s: string): string => s.replace(/\u001b?\[[0-9;]*m/g, "");

export function send(msg: ServerMsg): void {
  if (client?.readyState === WebSocket.OPEN) {
    console.log(`-> ${msg.type}`);
    client.send(JSON.stringify(msg));
  } else {
    console.log(`-> ${msg.type} (dropped: no client)`);
  }
}
