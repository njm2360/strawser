import { createHash } from "node:crypto";
import sharp from "sharp";
import { getActivePage, getViewport, screenshotViewport } from "./browser.ts";
import { walkPage, seedTables, type AssetRect, type Extraction } from "./page-script.ts";
import type { DisplayList, DrawOp, OpChunk } from "./protocol.ts";

export type { AssetRect, Extraction };

// dpr2/q30の3分の1のバイト数になる。記事のサムネイルなら判別に支障はない
const ASSET_SCALE = 1;
const ASSET_QUALITY = 35;

// tsx(esbuild)は関数名を保つために__nameの呼び出しを差し込む。evaluateへ渡るのは
// 関数のソースだけなので、内側に関数を持つものはブラウザ側に受け皿が要る。
// ここは文字列で渡す（式そのものが__nameで包まれると自分を呼びに行って落ちる）
const NAME_SHIM = "window.__name = window.__name || function (f) { return f; }";

// 戻る・進むの直後はloadが来てもまだ載っていない枝がある（Wikipediaで7264opsが375opsになる）。
// 表に出ていないタブではrAFが来ないので300msで打ち切る。
// ページ内で評価するので外の値は掴めない（page-script.tsと同じ）
const settle = (): Promise<void> =>
  new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    setTimeout(resolve, 300);
  });

/** baseはこの場所で前に撮ったリスト。文書が作り直されていれば表を置き直してから歩く */
export async function extractList(base?: DisplayList): Promise<Extraction> {
  const { page } = getActivePage();
  await page.evaluate(NAME_SHIM);
  if (base) await page.evaluate(seedTables, { colors: base.colors, fonts: base.fonts });
  await page.evaluate(settle).catch(() => {});
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

// 撮る位置ごとにまとめる。1枚で覆えるのは表示1画面ぶんなので、
// それに収まらない矩形は自分から始まる1枚に入るところまで。
// 位置は下端に寄せる。先頭1画面ならスクロールせずに済み（スクロールで見出しを差し替える
// サイトがある。tenki.jp）、上に貼り付くものからも遠ざかる
function shotsFor(rects: AssetRect[], height: number): { y: number; list: AssetRect[] }[] {
  const groups: { top: number; bottom: number; list: AssetRect[] }[] = [];
  let cur: { top: number; bottom: number; list: AssetRect[] } | undefined;
  for (const r of [...rects].sort((a, b) => a.y - b.y)) {
    if (cur && r.y + r.h <= cur.top + height) {
      cur.bottom = Math.max(cur.bottom, r.y + r.h);
      cur.list.push(r);
      continue;
    }
    cur = { top: r.y, bottom: r.y + r.h, list: [r] };
    groups.push(cur);
  }
  return groups.map((g) => ({ y: Math.max(0, g.bottom - height), list: g.list }));
}

// 切り抜きは実ページの撮り直しなので、矩形に重なるものが一緒に焼き付き、opとしても
// 描かれて二重になる。撮るあいだだけ対象の血縁でないものを隠す。
// 背景として撮るものは半透明のことがあり、下に敷かれた絵まで消えるので重なりでは落とさない
// （cookpadのカードはグラデーション越しに写真が見える）
async function isolate(nodeIds: number[], asBackground: boolean, on: boolean): Promise<void> {
  const { page } = getActivePage();
  await page
    .evaluate(
      ({ ids, asBackground, on }: { ids: number[]; asBackground: boolean; on: boolean }) => {
        for (const el of document.querySelectorAll("[data-sw-bg],[data-sw-over]")) {
          el.removeAttribute("data-sw-bg");
          el.removeAttribute("data-sw-over");
        }
        let style = document.getElementById("__strawserMask");
        if (!on) {
          style?.remove();
          return;
        }
        const store = (window as unknown as { __strawserNodes?: Map<number, Element> })
          .__strawserNodes;
        const targets: Element[] = [];
        for (const id of ids) {
          const el = store?.get(id);
          if (el) targets.push(el);
        }
        // 祖先を隠すと対象ごと消え、子孫は絵の一部
        const kin = new Set<Element>();
        for (const el of targets) {
          for (let p: Element | null = el; p; p = p.parentElement) kin.add(p);
          if (!asBackground) for (const d of el.querySelectorAll("*")) kin.add(d);
        }
        if (asBackground) for (const el of targets) el.setAttribute("data-sw-bg", "");
        const boxes = asBackground ? [] : targets.map((el) => el.getBoundingClientRect());
        for (const el of document.body.querySelectorAll("*")) {
          if (kin.has(el)) continue;
          // 背景の下に敷かれた絵は残したいが、上へ貼り付いたものは絵ではない
          if (asBackground) {
            const pos = getComputedStyle(el).position;
            if (pos === "fixed" || pos === "sticky") el.setAttribute("data-sw-over", "");
            continue;
          }
          const r = el.getBoundingClientRect();
          if (r.width < 1 || r.height < 1) continue;
          const hit = boxes.some(
            (b) => r.right > b.left && r.left < b.right && r.bottom > b.top && r.top < b.bottom,
          );
          if (hit) el.setAttribute("data-sw-over", "");
        }
        if (!style) {
          style = document.createElement("style");
          style.id = "__strawserMask";
          document.head.appendChild(style);
        }
        // 直下のテキストノードは子孫セレクタで掴めないので、色を抜いて消す。
        // 背景と、色を自前で持つ擬似要素は残る
        style.textContent =
          "[data-sw-over], [data-sw-bg] * { visibility: hidden !important }" +
          "[data-sw-bg] { color: transparent !important;" +
          " -webkit-text-fill-color: transparent !important; text-shadow: none !important }";
      },
      { ids: nodeIds, asBackground, on },
    )
    .catch(() => {});
}

/** 要求された画像を実ページのスクリーンショットから切り出す */
export async function captureAssets(
  nodeIds: number[],
  background: ReadonlySet<number>,
): Promise<EncodedAsset[]> {
  const rects = await freshRects(nodeIds);
  if (rects.length === 0) return [];
  const { height: viewHeight, scale } = getViewport();

  const out: EncodedAsset[] = [];
  for (const asBackground of [false, true]) {
    const group = rects.filter((r) => background.has(r.nodeId) === asBackground);
    if (group.length === 0) continue;
    for (const shot of shotsFor(group, viewHeight)) {
      await encodeShot(out, shot.y, scale, asBackground, shot.list);
    }
  }
  return out;
}

async function encodeShot(
  out: EncodedAsset[],
  wantY: number,
  scale: number,
  asBackground: boolean,
  list: AssetRect[],
): Promise<void> {
  const ids = list.map((r) => r.nodeId);
  // 矩形も隠すものも撮る位置で決める。スクロールで畳まれる帯があると版面がずれ（tenki.jpの
  // アプリ誘導）、stickyが貼り付くのもJSがそれを切り替えるのもスクロール後
  let shotRects = list;
  const shot = await screenshotViewport(wantY, scale, async () => {
    shotRects = await freshRects(ids);
    await isolate(ids, asBackground, true);
  });
  await isolate(ids, asBackground, false);
  if (!shot) return;
  const img = sharp(shot.png);
  const meta = await img.metadata();
  for (const r of shotRects) {
    const left = Math.max(0, Math.round(r.x * scale));
    const top = Math.max(0, Math.round((r.y - shot.y) * scale));
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

/** 押された位置を要素の矩形へ丸め込んだページ座標 */
export function nodePoint(
  nodeId: number,
  x: number,
  y: number,
): Promise<{ x: number; y: number } | undefined> {
  const { page } = getActivePage();
  return page.evaluate(
    (at: { id: number; x: number; y: number }) => {
      const store = (window as unknown as { __strawserNodes?: Map<number, Element> })
        .__strawserNodes;
      const el = store?.get(at.id);
      if (!el) return undefined;
      el.scrollIntoView({ block: "center" });
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return undefined;
      const sx = window.scrollX;
      const sy = window.scrollY;
      return {
        x: Math.round(Math.min(Math.max(at.x, r.left + sx + 1), r.right + sx - 1)),
        y: Math.round(Math.min(Math.max(at.y, r.top + sy + 1), r.bottom + sy - 1)),
      };
    },
    { id: nodeId, x, y },
  );
}

// 座標と同じ0.1pxの刻みへ戻す
const round = (v: number): number => Math.round(v * 10) / 10;

// yを抜いた署名。切り取り枠はop自身のyからの距離で持つので、区間ごとずらしても崩れない。
// 同じopなら同じ文字列になる。キーの並びは組み立てる経路で決まっていて抽出のたびに変わらない
const sigOf = (op: DrawOp): string =>
  JSON.stringify({
    ...op,
    b: [op.b[0], 0, op.b[2], op.b[3]],
    cl: op.cl && [op.cl[0], round(op.cl[1]! - op.b[1]!), op.cl[2], op.cl[3]],
  });

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
  const baseY = base.map((op) => op.b[1] ?? 0);
  const nextY = next.map((op) => op.b[1] ?? 0);
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
  // 縦のずれが一定であるあいだが1区間
  const runAt = (j: number, i: number): { n: number; dy: number } => {
    if (j >= baseSig.length || i >= nextSig.length || baseSig[j] !== nextSig[i]) {
      return { n: 0, dy: 0 };
    }
    const dy = round(nextY[i]! - baseY[j]!);
    let n = 0;
    while (
      j + n < baseSig.length &&
      i + n < nextSig.length &&
      baseSig[j + n] === nextSig[i + n] &&
      round(nextY[i + n]! - baseY[j + n]!) === dy
    ) {
      n++;
    }
    return { n, dy };
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
    let { n: run, dy } = runAt(from, i);
    // 消えたopの先で繋ぎ直す
    if (run < MIN_RUN) {
      const list = at.get(nextSig[i]!) ?? [];
      const head = seek(list, from);
      for (let k = head; k < list.length && k - head < CANDIDATES; k++) {
        const j = list[k]!;
        const found = runAt(j, i);
        if (found.n > run) {
          run = found.n;
          dy = found.dy;
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
    chunks.push(dy === 0 ? { a: start, n: run } : { a: start, n: run, dy });
    from = start + run;
    i += run;
  }
  flush();
  return chunks;
}
