import { randomUUID } from "node:crypto";
import type { Dialog } from "playwright";
import { send } from "./wire.ts";
import type { ServerMsg } from "./protocol.ts";

// 取りこぼした1つでそのタブが二度と動かなくなる
const pending = new Map<string, Dialog>();

type DialogKind = Extract<ServerMsg, { type: "dialog" }>["kind"];

export function showDialog(dialog: Dialog): void {
  const id = randomUUID();
  pending.set(id, dialog);
  const sent = send({
    type: "dialog",
    id,
    kind: dialog.type() as DialogKind,
    message: dialog.message(),
    defaultValue: dialog.defaultValue(),
  });
  if (!sent) answerDialog(id, false, "");
}

export function answerDialog(id: string, accept: boolean, text: string): void {
  const dialog = pending.get(id);
  if (!dialog) return;
  pending.delete(id);
  void (accept ? dialog.accept(text) : dialog.dismiss()).catch(() => {});
}

export function dismissDialogs(): void {
  for (const id of [...pending.keys()]) answerDialog(id, false, "");
}
