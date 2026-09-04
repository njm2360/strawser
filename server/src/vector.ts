import { createHash } from "node:crypto";
import sharp from "sharp";
import { getActivePage, getViewport } from "./browser.ts";
import type { DisplayList, DrawOp } from "./protocol.ts";

// dpr2/q30の3分の1のバイト数になる。記事のサムネイルなら判別に支障はない
const ASSET_SCALE = 1;
const ASSET_QUALITY = 35;

// 切り出しにだけ使う。クライアントへは送らない
export interface AssetRect {
  nodeId: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Extraction {
  title: string;
  url: string;
  list: DisplayList;
  rects: AssetRect[];
}

// page.evaluateへ渡すのでソースだけがブラウザへ行く。外の値は掴めない。
// 番号から要素への対応はページ側のMapに残す。遷移すればMapごと消えるので、
// 古い番号が別の要素を指すことはない
function walkPage(): Extraction {
  const store = new Map<number, Element>();
  (window as unknown as { __strawserNodes: Map<number, Element> }).__strawserNodes = store;
  let nextId = 1;
  const idOf = (el: Element): number => {
    const id = nextId++;
    store.set(id, el);
    return id;
  };

  const colors: string[] = [];
  const colorIndex = new Map<string, number>();
  const fonts: number[][] = [];
  const fontIndex = new Map<string, number>();
  const ops: DrawOp[] = [];
  const rects: AssetRect[] = [];
  const sx = window.scrollX;
  const sy = window.scrollY;

  const hex2 = (n: number): string => n.toString(16).padStart(2, "0");
  const colorId = (css: string): number => {
    const m = /rgba?\(([^)]+)\)/.exec(css);
    if (!m) return -1;
    const p = m[1]!.split(",").map((v) => parseFloat(v));
    const a = p.length > 3 ? p[3]! : 1;
    if (a === 0) return -1;
    const rgb = `#${hex2(p[0]!)}${hex2(p[1]!)}${hex2(p[2]!)}`;
    const key = a === 1 ? rgb : `${rgb}${hex2(Math.round(a * 255))}`;
    let id = colorIndex.get(key);
    if (id === undefined) {
      id = colors.length;
      colors.push(key);
      colorIndex.set(key, id);
    }
    return id;
  };

  const familyClass = (ff: string): number => {
    const f = ff.toLowerCase();
    if (f.includes("mono") || f.includes("courier") || f.includes("consol")) return 2;
    if (f.includes("serif") && !f.includes("sans-serif")) return 1;
    return 0;
  };

  const measure = document.createElement("canvas").getContext("2d")!;
  const FAMILY = ["sans-serif", "serif", "monospace"];

  const fontId = (cs: CSSStyleDeclaration): number => {
    const size = Math.round(parseFloat(cs.fontSize) * 10) / 10;
    const weight = parseInt(cs.fontWeight) || 400;
    const italic = cs.fontStyle === "italic" ? 1 : 0;
    const fam = familyClass(cs.fontFamily);
    const ls = Math.round((parseFloat(cs.letterSpacing) || 0) * 10) / 10;
    const key = `${size}/${weight}/${italic}/${fam}/${ls}`;
    let id = fontIndex.get(key);
    if (id === undefined) {
      id = fonts.length;
      // 端末へ渡すのは行の上端だけなので、ベースラインまでの距離をここで測る
      measure.font = `${italic ? "italic " : ""}${weight} ${size}px ${FAMILY[fam]}`;
      const m = measure.measureText("Mg亜");
      const ascent = Math.round((m.fontBoundingBoxAscent || size * 0.8) * 10) / 10;
      fonts.push([size, weight, italic, fam, ls, ascent]);
      fontIndex.set(key, id);
    }
    return id;
  };

  const round = (v: number): number => Math.round(v * 10) / 10;

  interface Rect {
    x: number;
    y: number;
    w: number;
    h: number;
  }

  const emitBox = (cs: CSSStyleDeclaration, r: Rect): void => {
    const bg = colorId(cs.backgroundColor);
    const bw = [
      parseFloat(cs.borderTopWidth),
      parseFloat(cs.borderRightWidth),
      parseFloat(cs.borderBottomWidth),
      parseFloat(cs.borderLeftWidth),
    ];
    const bordered = bw.some((w) => w > 0);
    if (bg < 0 && !bordered) return;
    const op: DrawOp = { t: 0, b: [round(r.x), round(r.y), round(r.w), round(r.h)] };
    if (bg >= 0) op.f = bg;
    const rd = [
      parseFloat(cs.borderTopLeftRadius),
      parseFloat(cs.borderTopRightRadius),
      parseFloat(cs.borderBottomRightRadius),
      parseFloat(cs.borderBottomLeftRadius),
    ].map((v) => (Number.isFinite(v) ? Math.round(v) : 0));
    if (rd.some((v) => v > 0)) op.r = rd;
    if (bordered) {
      const uniform =
        bw[0] === bw[1] &&
        bw[1] === bw[2] &&
        bw[2] === bw[3] &&
        cs.borderTopColor === cs.borderRightColor &&
        cs.borderRightColor === cs.borderBottomColor &&
        cs.borderBottomColor === cs.borderLeftColor;
      if (uniform) {
        const kc = colorId(cs.borderTopColor);
        if (kc >= 0) {
          op.k = kc;
          op.kw = round(bw[0]!);
        }
      } else {
        // 下線だけの見出しなど、辺ごとに幅も色も違うものは1つの枠線に畳めない
        const sides: [number, number, number, number, string][] = [
          [r.x, r.y, r.w, bw[0]!, cs.borderTopColor],
          [r.x + r.w - bw[1]!, r.y, bw[1]!, r.h, cs.borderRightColor],
          [r.x, r.y + r.h - bw[2]!, r.w, bw[2]!, cs.borderBottomColor],
          [r.x, r.y, bw[3]!, r.h, cs.borderLeftColor],
        ];
        for (const [x, y, w, h, c] of sides) {
          if (w <= 0 || h <= 0) continue;
          const f = colorId(c);
          if (f < 0) continue;
          ops.push({ t: 0, b: [round(x), round(y), round(w), round(h)], f });
        }
      }
    }
    if (op.f !== undefined || op.k !== undefined) ops.push(op);
  };

  // 二分探索で行の境目を探す。1文字ずつ測ると日本語の長文で桁が変わる
  const range = document.createRange();
  const lineRects = (node: Text): { r: DOMRect; t: string }[] => {
    const text = node.nodeValue ?? "";
    if (!text.trim()) return [];
    range.selectNodeContents(node);
    const found = range.getClientRects();
    if (found.length === 0) return [];
    if (found.length === 1) return [{ r: found[0]!, t: text }];
    const out: { r: DOMRect; t: string }[] = [];
    let start = 0;
    for (let i = 0; i < found.length - 1; i++) {
      let lo = start;
      let hi = text.length;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        range.setStart(node, start);
        range.setEnd(node, mid);
        if (range.getClientRects().length <= 1) lo = mid;
        else hi = mid - 1;
      }
      if (lo <= start) break;
      range.setStart(node, start);
      range.setEnd(node, lo);
      const r = range.getBoundingClientRect();
      if (r.width > 0) out.push({ r, t: text.slice(start, lo) });
      start = lo;
    }
    if (start < text.length) {
      range.setStart(node, start);
      range.setEnd(node, text.length);
      const r = range.getBoundingClientRect();
      if (r.width > 0) out.push({ r, t: text.slice(start) });
    }
    return out;
  };

  const emitText = (
    node: Text,
    cs: CSSStyleDeclaration,
    link: number | undefined,
    clip: Rect | undefined,
  ): void => {
    const co = colorId(cs.color);
    if (co < 0) return;
    const fo = fontId(cs);
    const underline = cs.textDecorationLine.includes("underline");
    for (const line of lineRects(node)) {
      const t = line.t.replace(/\s+/g, " ");
      if (!t.trim()) continue;
      const y = line.r.top + sy;
      if (clip && (y + line.r.height <= clip.y || y >= clip.y + clip.h)) continue;
      const op: DrawOp = {
        t: 1,
        b: [round(line.r.left + sx), round(y), round(line.r.width), round(line.r.height)],
        fo,
        co,
        s: t,
      };
      if (underline) op.u = 1;
      if (link !== undefined) op.a = link;
      ops.push(op);
    }
  };

  const SKIP = new Set([
    "SCRIPT",
    "STYLE",
    "NOSCRIPT",
    "TEMPLATE",
    "HEAD",
    "LINK",
    "META",
    "TITLE",
    "BR",
  ]);
  const RASTER = new Set(["IMG", "PICTURE", "CANVAS", "VIDEO", "IFRAME", "SVG"]);
  const FIELD = new Set(["INPUT", "TEXTAREA", "SELECT"]);

  // 読み上げ専用に1pxへ潰した要素。中の文字は元の大きさで測れてしまうので枝ごと落とす
  const hiddenForReaders = (cs: CSSStyleDeclaration, r: Rect): boolean =>
    ((r.w <= 1 || r.h <= 1) && cs.overflow !== "visible") ||
    (cs.clip !== "auto" && cs.clip !== "") ||
    cs.clipPath === "inset(50%)";

  const outside = (r: Rect, clip: Rect | undefined): boolean =>
    clip !== undefined && (r.y + r.h <= clip.y || r.y >= clip.y + clip.h || r.x >= clip.x + clip.w);

  const raster = (el: Element, r: Rect, link: number | undefined): void => {
    const id = idOf(el);
    rects.push({
      nodeId: id,
      x: Math.round(r.x),
      y: Math.round(r.y),
      w: Math.round(r.w),
      h: Math.round(r.h),
    });
    const op: DrawOp = { t: 2, b: [round(r.x), round(r.y), round(r.w), round(r.h)], i: id };
    if (link !== undefined) op.a = link;
    ops.push(op);
  };

  const walk = (
    el: Element,
    link: number | undefined,
    depth: number,
    clip: Rect | undefined,
  ): void => {
    if (depth > 80) return;
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) {
        emitText(node as Text, getComputedStyle(el), link, clip);
        continue;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      const child = node as Element;
      // SVG要素のtagNameはXML由来で小文字（svg）。大文字前提で拾うと絵ごと落ちる
      const tag = child.tagName.toUpperCase();
      if (SKIP.has(tag)) continue;
      const cs = getComputedStyle(child);
      if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) continue;
      const cr = child.getBoundingClientRect();
      if (cr.width < 0.5 && cr.height < 0.5) continue;
      const r: Rect = { x: cr.left + sx, y: cr.top + sy, w: cr.width, h: cr.height };
      if (hiddenForReaders(cs, r) || outside(r, clip)) continue;
      const nextClip = cs.overflow === "visible" ? clip : r;

      let nextLink = link;
      if ((tag === "A" && child.getAttribute("href") !== null) || tag === "BUTTON") {
        nextLink = idOf(child);
      }

      if (RASTER.has(tag)) {
        raster(child, r, nextLink);
        continue;
      }
      // 背景画像とグラデーションは箱ごとラスタにする。上に子の文字が乗るので走査は続ける
      if (cs.backgroundImage !== "none" && r.w >= 8 && r.h >= 8) {
        raster(child, r, nextLink);
        walk(child, nextLink, depth + 1, nextClip);
        continue;
      }

      emitBox(cs, r);
      if (FIELD.has(tag)) {
        const input = child as HTMLInputElement;
        const id = idOf(child);
        const shown = input.value || input.placeholder || "";
        if (shown) {
          const size = parseFloat(cs.fontSize);
          ops.push({
            t: 1,
            b: [
              round(r.x + 6),
              round(r.y + (r.h - size * 1.2) / 2),
              round(r.w - 12),
              round(size * 1.2),
            ],
            fo: fontId(cs),
            co: colorId(input.value ? cs.color : "rgb(150,150,150)"),
            s: shown,
          });
        }
        ops.push({ t: 3, b: [round(r.x), round(r.y), round(r.w), round(r.h)], i: id });
        continue;
      }
      walk(child, nextLink, depth + 1, nextClip);
    }
  };

  walk(document.body, undefined, 0, undefined);

  return {
    title: document.title,
    url: location.href,
    list: {
      pageWidth: document.documentElement.clientWidth,
      fullHeight: Math.ceil(document.documentElement.scrollHeight),
      bg: colorId(getComputedStyle(document.body).backgroundColor),
      colors,
      fonts,
      ops,
    },
    rects,
  };
}

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

/** 要求された画像を実ページのスクリーンショットから切り出す */
export async function captureAssets(nodeIds: number[]): Promise<EncodedAsset[]> {
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
    const shot = await cdp
      .send("Page.captureScreenshot", {
        format: "png",
        clip: { x: 0, y: baseY, width: pageWidth, height: BAND_HEIGHT, scale },
        captureBeyondViewport: true,
      })
      .catch(() => undefined);
    if (!shot) continue;
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
  return out;
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

/** 入力欄の値を丸ごと置き換える */
export function setNodeValue(nodeId: number, text: string): Promise<boolean> {
  const { page } = getActivePage();
  return page.evaluate(
    ({ id, value }: { id: number; value: string }) => {
      const store = (window as unknown as { __strawserNodes?: Map<number, Element> })
        .__strawserNodes;
      const el = store?.get(id);
      if (!el) return false;
      const field = el as HTMLInputElement | HTMLTextAreaElement;
      field.focus();
      field.value = value;
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    },
    { id: nodeId, value: text },
  );
}
