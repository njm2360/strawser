// 抽出結果をSVGへ描き戻し、実ページの画面とピクセル比較する。
// npx tsx tools/fidelity.ts [サイト名...]。描き戻した画像はtools/fid-*.pngに残る

import { chromium, type CDPSession, type Page } from "playwright";
import sharp from "sharp";
import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { walkPage } from "../src/page-script.ts";
import type { DisplayList } from "../../protocol/messages.ts";

const WIDTH = 412;
const HEIGHT = 900;
const SCALE = 2;
const CMP_HEIGHT = 3600;
const TILE_PAGE_HEIGHT = 128;

const dir = import.meta.dirname;
const kb = (n: number) => (n / 1024).toFixed(1);
const deflate = (s: string) => zlib.deflateSync(Buffer.from(s), { level: 6 }).byteLength;
const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const FAMILY = ["sans-serif", "serif", "monospace"];
const NAME_SHIM = "window.__name = window.__name || function (f) { return f; }";

function toSvg(dl: DisplayList, height: number, assets: Map<number, string>): string {
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${dl.pageWidth}" height="${height}">`,
    `<rect width="100%" height="100%" fill="${dl.bg >= 0 ? dl.colors[dl.bg] : "#fff"}"/>`,
  ];
  for (const op of dl.ops) {
    const [x, y, w, h] = op.b as [number, number, number, number];
    if (y > height) continue;
    const clip = op.cl
      ? ` clip-path="polygon(${op.cl[0]}px ${op.cl[1]}px, ${op.cl[0]! + op.cl[2]!}px ${op.cl[1]}px, ${op.cl[0]! + op.cl[2]!}px ${op.cl[1]! + op.cl[3]!}px, ${op.cl[0]}px ${op.cl[1]! + op.cl[3]!}px)"`
      : "";
    if (op.t === 0) {
      const fill = op.f !== undefined ? dl.colors[op.f] : "none";
      const stroke =
        op.k !== undefined ? ` stroke="${dl.colors[op.k]}" stroke-width="${op.kw}"` : "";
      const rx = op.r ? ` rx="${op.r[0]}"` : "";
      if (op.sh) {
        const [dx, dy, blur, col] = op.sh as [number, number, number, number];
        out.push(
          `<filter id="s${x}_${y}"><feDropShadow dx="${dx}" dy="${dy}" stdDeviation="${blur / 2}" flood-color="${dl.colors[col]}"/></filter>` +
            `<rect x="${x}" y="${y}" width="${w}" height="${h}"${rx} fill="${fill === "none" ? "#fff" : fill}" filter="url(#s${x}_${y})"/>`,
        );
      }
      out.push(
        `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"${stroke}${rx}${clip}/>`,
      );
    } else if (op.t === 1) {
      const f = dl.fonts[op.fo!]!;
      const [size, weight, italic, fam, ls, ascent] = f as number[];
      out.push(
        `<text x="${x}" y="${y + (ascent ?? size! * 0.8)}" font-size="${size}" font-weight="${weight}"` +
          (italic ? ` font-style="italic"` : "") +
          ` font-family="${FAMILY[fam!]}" fill="${dl.colors[op.co!]}"` +
          (ls ? ` letter-spacing="${ls}"` : "") +
          (op.u ? ` text-decoration="underline"` : "") +
          ` textLength="${w}" lengthAdjust="spacingAndGlyphs"${clip} xml:space="preserve">${esc(op.s!)}</text>`,
      );
    } else if (op.t === 2) {
      const data = assets.get(op.i!);
      out.push(
        data
          ? `<image x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="none" href="data:image/webp;base64,${data}"${clip}/>`
          : `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#d9d9d9"/>`,
      );
    }
  }
  out.push("</svg>");
  return out.join("");
}

async function shot(cdp: CDPSession, y: number, h: number, scale: number): Promise<Buffer> {
  const r = await cdp.send("Page.captureScreenshot", {
    format: "png",
    clip: { x: 0, y, width: WIDTH, height: h, scale },
    captureBeyondViewport: true,
  });
  return Buffer.from(r.data, "base64");
}

async function tileBytes(cdp: CDPSession, height: number): Promise<number> {
  let total = 0;
  for (let base = 0; base < height; base += TILE_PAGE_HEIGHT * 32) {
    const h = Math.min(TILE_PAGE_HEIGHT * 32, height - base);
    const img = sharp(await shot(cdp, base, h, SCALE));
    const meta = await img.metadata();
    for (let off = 0; off < h; off += TILE_PAGE_HEIGHT) {
      const top = Math.min(Math.round(off * SCALE), meta.height);
      const bottom = Math.min(Math.round((off + TILE_PAGE_HEIGHT) * SCALE), meta.height);
      if (bottom <= top) break;
      total += (
        await img
          .clone()
          .extract({ left: 0, top, width: meta.width, height: bottom - top })
          .webp({ quality: 30, effort: 6 })
          .toBuffer()
      ).byteLength;
    }
  }
  return total;
}

async function grabAssets(
  cdp: CDPSession,
  page: Page,
  rects: { nodeId: number; x: number; y: number; w: number; h: number }[],
  height: number,
): Promise<{ assets: Map<number, string>; bytes: number }> {
  const assets = new Map<number, string>();
  let bytes = 0;
  const BAND = 4096;
  const bands = new Map<number, typeof rects>();
  for (const im of rects) {
    if (im.y >= height || im.w < 8 || im.h < 8) continue;
    const b = Math.floor(im.y / BAND);
    if (!bands.has(b)) bands.set(b, []);
    bands.get(b)!.push(im);
  }
  for (const [b, list] of bands) {
    await page.evaluate((y) => window.scrollTo(0, y), b * BAND);
    await page.waitForTimeout(120);
    const img = sharp(await shot(cdp, b * BAND, BAND, SCALE));
    const meta = await img.metadata();
    for (const im of list) {
      const left = Math.max(0, Math.round(im.x * SCALE));
      const top = Math.max(0, Math.round((im.y - b * BAND) * SCALE));
      const w = Math.min(Math.round(im.w * SCALE), meta.width - left);
      const h = Math.min(Math.round(im.h * SCALE), meta.height - top);
      if (w < 8 || h < 8) continue;
      const buf = await img
        .clone()
        .extract({ left, top, width: w, height: h })
        .resize({ width: Math.max(8, im.w), withoutEnlargement: true })
        .webp({ quality: 35, effort: 6 })
        .toBuffer()
        .catch(() => undefined);
      if (!buf) continue;
      bytes += buf.byteLength;
      assets.set(im.nodeId, buf.toString("base64"));
    }
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  return { assets, bytes };
}

// 文字のアンチエイリアスの差でピクセル比較が飽和するので、
// 縮小してから比べた値も出す。こちらは配置と色の食い違いを見る
async function diff(a: Buffer, b: Buffer, shrink = 1): Promise<number> {
  const base = sharp(a).greyscale();
  const x = await (shrink > 1 ? base.resize({ width: Math.round(412 / shrink) }) : base)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const y = await sharp(b)
    .greyscale()
    .resize(x.info.width, x.info.height, { fit: "fill" })
    .raw()
    .toBuffer();
  let n = 0;
  for (let i = 0; i < x.data.length; i++) if (Math.abs(x.data[i]! - y[i]!) > 32) n++;
  return n / x.data.length;
}

const TARGETS: Record<string, string> = {
  wikipedia:
    "https://ja.wikipedia.org/wiki/%E3%82%A6%E3%82%A3%E3%82%AD%E3%83%9A%E3%83%87%E3%82%A3%E3%82%A2",
  hn: "https://news.ycombinator.com/",
  nhk: "https://www3.nhk.or.jp/news/",
  yahoo: "https://www.yahoo.co.jp/",
  github: "https://github.com/microsoft/playwright",
};

const picked = process.argv.slice(2).filter((a) => a in TARGETS);
const names = picked.length ? picked : Object.keys(TARGETS);

const browser = await chromium.launch({ channel: "chromium" });
for (const name of names) {
  try {
    const context = await browser.newContext({
      viewport: { width: WIDTH, height: HEIGHT },
      deviceScaleFactor: SCALE,
      isMobile: true,
      hasTouch: true,
      userAgent:
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
      locale: "ja-JP",
    });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await page.goto(TARGETS[name]!, { waitUntil: "load", timeout: 45000 });
    await page.waitForTimeout(1500);
    const full: number = await page.evaluate(() => document.documentElement.scrollHeight);
    for (let y = 0; y < Math.min(full, CMP_HEIGHT); y += HEIGHT) {
      await page.evaluate((v) => window.scrollTo(0, v), y);
      await page.waitForTimeout(80);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);

    const t0 = Date.now();
    await page.evaluate(NAME_SHIM);
    const snap = await page.evaluate(walkPage);
    const ms = Date.now() - t0;
    const height = Math.min(snap.list.fullHeight, CMP_HEIGHT);
    snap.list.ops = snap.list.ops.filter((o) => o.b[1]! < height);
    const json = JSON.stringify(snap.list);

    const orig = await shot(cdp, 0, height, 1);
    const { assets, bytes } = await grabAssets(cdp, page, snap.rects, height);
    const tiles = await tileBytes(cdp, height);

    const svg = toSvg(snap.list, height, assets);
    await page.evaluate(async (src: string) => {
      // innerHTMLに流すとSVGの一部が取りこぼされる。XMLとして解釈させる
      const doc = new DOMParser().parseFromString(src, "image/svg+xml");
      document.body.style.margin = "0";
      document.body.replaceChildren(document.importNode(doc.documentElement, true));
      await new Promise((r) => setTimeout(r, 600));
    }, svg);
    fs.writeFileSync(path.join(dir, `fid-${name}.svg`), svg);
    const rebuilt = await shot(cdp, 0, height, 1);
    fs.writeFileSync(path.join(dir, `fid-${name}-orig.png`), orig);
    fs.writeFileSync(path.join(dir, `fid-${name}-new.png`), rebuilt);
    const d = await diff(orig, rebuilt);
    const ds = await diff(orig, rebuilt, 4);
    const ops = snap.list.ops;
    const kinds = `sh${ops.filter((o) => o.sh).length} cl${ops.filter((o) => o.cl).length}`;

    console.log(
      `${name.padEnd(10)} 構造差 ${(ds * 100).toFixed(1)}% 画素差 ${(d * 100).toFixed(1)}% | ${kinds} | ops ${String(snap.list.ops.length).padStart(5)} ` +
        `| vec ${kb(deflate(json)).padStart(6)}KB + img ${kb(bytes).padStart(6)}KB vs tile ${kb(tiles).padStart(7)}KB | ${ms}ms`,
    );
    await context.close();
  } catch (e) {
    console.error(`${name}: ${String(e).slice(0, 160)}`);
  }
}
await browser.close();
