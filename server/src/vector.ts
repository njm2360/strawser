import { createHash } from "node:crypto";
import sharp from "sharp";
import { getActivePage, getViewport } from "./browser.ts";
import { walkPage, type AssetRect, type Extraction } from "./page-script.ts";
import type { DisplayList, DrawOp, OpChunk } from "./protocol.ts";

export type { AssetRect, Extraction };

// dpr2/q30の3分の1のバイト数になる。記事のサムネイルなら判別に支障はない
const ASSET_SCALE = 1;
const ASSET_QUALITY = 35;

// tsx(esbuild)は関数名を保つために__nameの呼び出しを差し込む。evaluateへ渡るのは
// 関数のソースだけなので、内側に関数を持つものはブラウザ側に受け皿が要る。
// ここは文字列で渡す（式そのものが__nameで包まれると自分を呼びに行って落ちる）
const NAME_SHIM = "window.__name = window.__name || function (f) { return f; }";

export async function extractList(): Promise<Extraction> {
  const { page } = getActivePage();
  await page.evaluate(NAME_SHIM);
  return page.evaluate(walkPage);
}

export interface EncodedAsset {
  nodeId: number;
  data: Buffer;
  hash: string;
}

// 抽出時の矩形は遅延読み込みで動くので、切り出す直前に引き直す
function freshRects(nodeIds: number[]): Promise<AssetRect[]> {
  const { page } = getActivePage();
  return page.evaluate((ids: number[]) => {
    const store = (window as unknown as { __strawserNodes?: Map<number, Element> }).__strawserNodes;
    if (!store) return [];
    const out: AssetRect[] = [];
    for (const nodeId of ids) {
      const el = store.get(nodeId);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      out.push({
        nodeId,
        x: Math.round(r.left + window.scrollX),
        y: Math.round(r.top + window.scrollY),
        w: Math.round(r.width),
        h: Math.round(r.height),
      });
    }
    return out;
  }, nodeIds);
}

const BAND_HEIGHT = 4096; // 1回のスクリーンショットで覆う高さ（ページ座標）

// 背景として撮るあいだ子孫を隠す。文字がラスタへ焼き付くと、上に描き直す文字と二重になる
async function maskDescendants(nodeIds: number[], on: boolean): Promise<void> {
  const { page } = getActivePage();
  await page
    .evaluate(
      ({ ids, on }: { ids: number[]; on: boolean }) => {
        const store = (window as unknown as { __strawserNodes?: Map<number, Element> })
          .__strawserNodes;
        for (const id of ids) {
          const el = store?.get(id);
          if (!el) continue;
          if (on) el.setAttribute("data-sw-bg", "");
          else el.removeAttribute("data-sw-bg");
        }
        let style = document.getElementById("__strawserMask");
        if (!on) {
          style?.remove();
          return;
        }
        if (!style) {
          style = document.createElement("style");
          style.id = "__strawserMask";
          document.head.appendChild(style);
        }
        style.textContent = "[data-sw-bg] * { visibility: hidden !important }";
      },
      { ids: nodeIds, on },
    )
    .catch(() => {});
}

/** 要求された画像を実ページのスクリーンショットから切り出す */
export async function captureAssets(
  nodeIds: number[],
  background: ReadonlySet<number>,
): Promise<EncodedAsset[]> {
  const { page, cdp } = getActivePage();
  const rects = await freshRects(nodeIds);
  if (rects.length === 0) return [];
  const { width: pageWidth, scale } = getViewport();
  const bands = new Map<number, AssetRect[]>();
  for (const r of rects) {
    const band = Math.floor(r.y / BAND_HEIGHT);
    const list = bands.get(band);
    if (list) list.push(r);
    else bands.set(band, [r]);
  }

  const out: EncodedAsset[] = [];
  for (const [band, list] of bands) {
    const baseY = band * BAND_HEIGHT;
    // 遅延読み込みは実ページがそこを通らないと発火しない
    await page.evaluate((y) => window.scrollTo(0, y), baseY).catch(() => {});
    await page.waitForTimeout(150);
    for (const asBackground of [false, true]) {
      const group = list.filter((r) => background.has(r.nodeId) === asBackground);
      if (group.length === 0) continue;
      if (asBackground)
        await maskDescendants(
          group.map((r) => r.nodeId),
          true,
        );
      await encodeBand(out, cdp, baseY, pageWidth, scale, group);
      if (asBackground)
        await maskDescendants(
          group.map((r) => r.nodeId),
          false,
        );
    }
  }
  return out;
}

async function encodeBand(
  out: EncodedAsset[],
  cdp: ReturnType<typeof getActivePage>["cdp"],
  baseY: number,
  pageWidth: number,
  scale: number,
  list: AssetRect[],
): Promise<void> {
  const shot = await cdp
    .send("Page.captureScreenshot", {
      format: "png",
      clip: { x: 0, y: baseY, width: pageWidth, height: BAND_HEIGHT, scale },
      captureBeyondViewport: true,
    })
    .catch(() => undefined);
  if (!shot) return;
  const img = sharp(Buffer.from(shot.data, "base64"));
  const meta = await img.metadata();
  for (const r of list) {
    const left = Math.max(0, Math.round(r.x * scale));
    const top = Math.max(0, Math.round((r.y - baseY) * scale));
    const width = Math.min(Math.round(r.w * scale), (meta.width ?? 0) - left);
    const height = Math.min(Math.round(r.h * scale), (meta.height ?? 0) - top);
    if (width < 8 || height < 8) continue;
    const data = await img
      .clone()
      .extract({ left, top, width, height })
      .resize({ width: Math.max(8, Math.round(r.w * ASSET_SCALE)), withoutEnlargement: true })
      .webp({ quality: ASSET_QUALITY, effort: 6 })
      .toBuffer()
      .catch(() => undefined);
    if (!data) continue;
    out.push({
      nodeId: r.nodeId,
      data,
      hash: createHash("sha1").update(data).digest("hex").slice(0, 16),
    });
  }
}

/** 要素の矩形中央のページ座標 */
export function nodeCenter(nodeId: number): Promise<{ x: number; y: number } | undefined> {
  const { page } = getActivePage();
  return page.evaluate((id: number) => {
    const store = (window as unknown as { __strawserNodes?: Map<number, Element> }).__strawserNodes;
    const el = store?.get(id);
    if (!el) return undefined;
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return undefined;
    return {
      x: Math.round(r.left + window.scrollX + r.width / 2),
      y: Math.round(r.top + window.scrollY + r.height / 2),
    };
  }, nodeId);
}

// 同じopなら同じ文字列になる。キーの並びは組み立てる経路で決まっていて抽出のたびに変わらない
const sigOf = (op: DrawOp): string => JSON.stringify(op);

// これより短い一致はコピー指示の方が大きい
const MIN_RUN = 3;
// これだけ続けば繋ぎ先として十分
const RUN_ENOUGH = 64;
// 同じ絵のopは何十個も並ぶ。総当たりにするとop数の2乗になる
const CANDIDATES = 8;

/** 色とフォントの表が土台の続きになっているか。違えば差分のindexが噛み合わない */
export function extendsTables(base: DisplayList, next: DisplayList): boolean {
  if (next.colors.length < base.colors.length || next.fonts.length < base.fonts.length) {
    return false;
  }
  for (let i = 0; i < base.colors.length; i++) {
    if (base.colors[i] !== next.colors[i]) return false;
  }
  for (let i = 0; i < base.fonts.length; i++) {
    if (String(base.fonts[i]) !== String(next.fonts[i])) return false;
  }
  return true;
}

/** 土台のどこから引き継ぐかを組み立てる。並び替えは追えないので送り直しになる */
export function diffOps(base: DrawOp[], next: DrawOp[]): OpChunk[] {
  const baseSig = base.map(sigOf);
  const nextSig = next.map(sigOf);
  const at = new Map<string, number[]>();
  for (let j = 0; j < baseSig.length; j++) {
    const found = at.get(baseSig[j]!);
    if (found) found.push(j);
    else at.set(baseSig[j]!, [j]);
  }
  // listは昇順。from以降の先頭を二分探索で拾う
  const seek = (list: number[], from: number): number => {
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid]! < from) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const runAt = (j: number, i: number): number => {
    let n = 0;
    while (j + n < baseSig.length && i + n < nextSig.length && baseSig[j + n] === nextSig[i + n]) {
      n++;
    }
    return n;
  };

  const chunks: OpChunk[] = [];
  let fresh: DrawOp[] = [];
  const flush = (): void => {
    if (fresh.length === 0) return;
    chunks.push({ o: fresh });
    fresh = [];
  };

  let from = 0;
  let i = 0;
  while (i < nextSig.length) {
    let start = from;
    let run = runAt(from, i);
    // 消えたopの先で繋ぎ直す
    if (run < MIN_RUN) {
      const list = at.get(nextSig[i]!) ?? [];
      const head = seek(list, from);
      for (let k = head; k < list.length && k - head < CANDIDATES; k++) {
        const j = list[k]!;
        const n = runAt(j, i);
        if (n > run) {
          run = n;
          start = j;
        }
        if (run >= RUN_ENOUGH) break;
      }
    }
    if (run < MIN_RUN) {
      fresh.push(next[i]!);
      i++;
      continue;
    }
    flush();
    chunks.push({ a: start, n: run });
    from = start + run;
    i += run;
  }
  flush();
  return chunks;
}
