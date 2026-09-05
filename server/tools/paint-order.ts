// 塗り順の検証。paint-order.htmlを実ページとして撮り、同じページから起こした表示リストと
// probeの点の色を突き合わせる。npx tsx tools/paint-order.ts

import { chromium } from "playwright";
import sharp from "sharp";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { walkPage } from "../src/page-script.ts";
import type { DrawOp } from "../src/protocol.ts";

const WIDTH = 412;
const HEIGHT = 900;
const NAME_SHIM = "window.__name = window.__name || function (f) { return f; }";

const browser = await chromium.launch({ channel: "chromium" });
const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
await page.goto(pathToFileURL(path.join(import.meta.dirname, "paint-order.html")).href);
await page.evaluate(NAME_SHIM);

const probes = await page.evaluate(() =>
  Array.from(document.querySelectorAll("[data-probe]")).map((el) => {
    const r = el.getBoundingClientRect();
    return {
      name: el.getAttribute("data-probe") ?? "",
      x: Math.round(r.left + window.scrollX),
      y: Math.round(r.top + window.scrollY),
    };
  }),
);
const snap = await page.evaluate(walkPage);
const shot = await page.screenshot({ fullPage: true });
await browser.close();

const img = await sharp(shot).raw().toBuffer({ resolveWithObject: true });
const hex = (n: number): string => n.toString(16).padStart(2, "0");
const pixel = (x: number, y: number): string => {
  const i = (y * img.info.width + x) * img.info.channels;
  return `#${hex(img.data[i]!)}${hex(img.data[i + 1]!)}${hex(img.data[i + 2]!)}`;
};

const covers = (op: DrawOp, x: number, y: number): boolean => {
  const b = op.b;
  if (x < b[0]! || y < b[1]! || x >= b[0]! + b[2]! || y >= b[1]! + b[3]!) return false;
  const c = op.cl;
  return !c || (x >= c[0]! && y >= c[1]! && x < c[0]! + c[2]! && y < c[1]! + c[3]!);
};

// 点を最後に覆った塗りが見えている色
const painted = (x: number, y: number): string => {
  const list = snap.list;
  let color = list.bg >= 0 ? list.colors[list.bg]! : "#ffffff";
  for (const op of list.ops) {
    if (!covers(op, x, y)) continue;
    if (op.t === 0 && op.f !== undefined) color = list.colors[op.f]!;
    else if (op.t === 2) color = "画像";
  }
  return color;
};

let hit = 0;
for (const p of probes) {
  const real = pixel(p.x, p.y);
  const got = painted(p.x, p.y);
  if (real === got) hit++;
  console.log(`${real === got ? "○" : "×"} ${p.name}  実ページ ${real} 表示リスト ${got}`);
}
console.log(`${hit}/${probes.length} 一致`);
process.exit(hit === probes.length ? 0 : 1);
