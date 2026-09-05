import type { DisplayList, DrawOp } from "./protocol.ts";

// ブラウザのページ内で評価する抽出本体。page.evaluateへはソースだけが渡るので、
// このファイルは外の値を掴まないこと（型の参照は消えるので構わない）

// 切り出しにだけ使う。クライアントへは送らない。
// bgが立っているものは背景として撮るので、撮影中は子孫を隠す
export interface AssetRect {
  nodeId: number;
  x: number;
  y: number;
  w: number;
  h: number;
  bg?: 1;
}

export interface Extraction {
  title: string;
  url: string;
  list: DisplayList;
  rects: AssetRect[];
}

// layerはopを置く塗り順の経路。三つ組[段、z-index、文書順]を重ね合わせ文脈の入れ子ぶん
// 並べ、末尾に段を1つ置く。辞書順で比べると描画順になる。
// stackは今いる重ね合わせ文脈の経路で、子の三つ組はここへ継ぎ足す
interface Ctx {
  link: number | undefined;
  clip: Rect | undefined;
  stack: number[];
  layer: number[];
  alpha: number;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// 同じ文書のあいだ持ち越す。nodeIdと表のindexが抽出をまたいで動くと、
// 前に送った表示リストとの差分が取れない
interface Carried {
  ids: WeakMap<Element, number>;
  nextId: number;
  colors: string[];
  colorIndex: Map<string, number>;
  fonts: number[][];
  fontIndex: Map<string, number>;
}

// 戻る・進むでは文書ごと作り直されて表が消える。前に撮ったときの表を置き直してから歩く。
// indexが1つでもずれると全opの署名が変わって差分が取れない
export function seedTables(seed: { colors: string[]; fonts: number[][] }): void {
  const w = window as unknown as { __strawserVec?: Carried };
  if (w.__strawserVec) return; // 生きている表の方が新しい
  w.__strawserVec = {
    ids: new WeakMap(),
    nextId: 1,
    colors: seed.colors.slice(),
    colorIndex: new Map(seed.colors.map((c, i) => [c, i])),
    fonts: seed.fonts.map((f) => f.slice()),
    fontIndex: new Map(seed.fonts.map((f, i) => [f.slice(0, 5).join("/"), i])),
  };
}

export function walkPage(): Extraction {
  const w = window as unknown as {
    __strawserVec?: Carried;
    __strawserNodes: Map<number, Element>;
  };
  const carried: Carried = (w.__strawserVec ??= {
    ids: new WeakMap(),
    nextId: 1,
    colors: [],
    colorIndex: new Map(),
    fonts: [],
    fontIndex: new Map(),
  });
  // 引けるのは今そこにある要素だけ。持ち越すと外れた要素を掴み続ける
  const store = new Map<number, Element>();
  w.__strawserNodes = store;
  const idOf = (el: Element): number => {
    let id = carried.ids.get(el);
    if (id === undefined) {
      id = carried.nextId++;
      carried.ids.set(el, id);
    }
    store.set(id, el);
    return id;
  };

  const colors = carried.colors;
  const colorIndex = carried.colorIndex;
  const fonts = carried.fonts;
  const fontIndex = carried.fontIndex;
  const layered: { op: DrawOp; layer: number[] }[] = [];
  const rects: AssetRect[] = [];
  const sx = window.scrollX;
  const sy = window.scrollY;
  const pageWidth = document.documentElement.clientWidth;

  const hex2 = (n: number): string => n.toString(16).padStart(2, "0");
  const colorId = (css: string, alpha: number): number => {
    const m = /rgba?\(([^)]+)\)/.exec(css);
    if (!m) return -1;
    const p = m[1]!.split(",").map((v) => parseFloat(v));
    const a = (p.length > 3 ? p[3]! : 1) * alpha;
    if (a < 0.004) return -1;
    const rgb = `#${hex2(p[0]!)}${hex2(p[1]!)}${hex2(p[2]!)}`;
    const key = a > 0.996 ? rgb : `${rgb}${hex2(Math.round(a * 255))}`;
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
  const box = (r: Rect): number[] => [round(r.x), round(r.y), round(r.w), round(r.h)];

  // はみ出す分は端末側で切る
  const clipOf = (r: Rect, clip: Rect | undefined): number[] | undefined => {
    if (!clip) return undefined;
    if (
      r.x >= clip.x &&
      r.y >= clip.y &&
      r.x + r.w <= clip.x + clip.w &&
      r.y + r.h <= clip.y + clip.h
    ) {
      return undefined;
    }
    return box(clip);
  };

  const push = (op: DrawOp, ctx: Ctx, r: Rect): void => {
    const cl = clipOf(r, ctx.clip);
    if (cl) op.cl = cl;
    layered.push({ op, layer: ctx.layer });
  };

  const raster = (el: Element, r: Rect, ctx: Ctx, background: boolean): void => {
    const id = idOf(el);
    const rect: AssetRect = {
      nodeId: id,
      x: Math.round(r.x),
      y: Math.round(r.y),
      w: Math.round(r.w),
      h: Math.round(r.h),
    };
    if (background) rect.bg = 1;
    rects.push(rect);
    const op: DrawOp = { t: 2, b: box(r), i: id };
    if (ctx.link !== undefined) op.a = ctx.link;
    push(op, ctx, r);
  };

  // 内側の影（inset）は捨てる
  const parseShadow = (css: string, alpha: number): number[] | undefined => {
    if (!css || css === "none" || css.includes("inset")) return undefined;
    const color = /rgba?\([^)]+\)/.exec(css);
    if (!color) return undefined;
    const nums = css.slice(color.index + color[0].length).match(/-?[\d.]+px/g);
    if (!nums || nums.length < 2) return undefined;
    const cid = colorId(color[0], alpha);
    if (cid < 0) return undefined;
    if (nums.every((n) => parseFloat(n) === 0)) return undefined;
    return [
      round(parseFloat(nums[0]!)),
      round(parseFloat(nums[1]!)),
      round(parseFloat(nums[2] ?? "0")),
      cid,
    ];
  };

  const emitBox = (cs: CSSStyleDeclaration, r: Rect, ctx: Ctx): void => {
    const bg = colorId(cs.backgroundColor, ctx.alpha);
    const bw = [
      parseFloat(cs.borderTopWidth),
      parseFloat(cs.borderRightWidth),
      parseFloat(cs.borderBottomWidth),
      parseFloat(cs.borderLeftWidth),
    ];
    const bordered = bw.some((w) => w > 0);
    const shadow = parseShadow(cs.boxShadow, ctx.alpha);
    if (bg < 0 && !bordered && !shadow) return;
    const op: DrawOp = { t: 0, b: box(r) };
    if (bg >= 0) op.f = bg;
    if (shadow) op.sh = shadow;
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
        const kc = colorId(cs.borderTopColor, ctx.alpha);
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
          const f = colorId(c, ctx.alpha);
          if (f < 0) continue;
          const side = { x, y, w, h };
          push({ t: 0, b: box(side), f }, ctx, side);
        }
      }
    }
    if (op.f !== undefined || op.k !== undefined || op.sh !== undefined) push(op, ctx, r);
  };

  // 行の境目は二分探索で探す。1文字ずつ測ると日本語の長文で桁が変わる
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

  const emitLine = (cs: CSSStyleDeclaration, r: Rect, text: string, ctx: Ctx): void => {
    const co = colorId(cs.color, ctx.alpha);
    if (co < 0) return;
    const op: DrawOp = { t: 1, b: box(r), fo: fontId(cs), co, s: text };
    if (cs.textDecorationLine.includes("underline")) op.u = 1;
    if (ctx.link !== undefined) op.a = ctx.link;
    push(op, ctx, r);
  };

  const PRE_SPACE = new Set(["pre", "pre-wrap", "break-spaces"]);
  const TAB_COLUMNS = 8;

  // 行の区切りは矩形が持っているので改行そのものは落とす。
  // tab-sizeがpx指定のときは桁に直せないので既定の桁数で置く
  const keepSpaces = (text: string, cs: CSSStyleDeclaration): string => {
    const cols = cs.tabSize.endsWith("px") ? TAB_COLUMNS : parseInt(cs.tabSize) || TAB_COLUMNS;
    let out = "";
    for (const ch of text) {
      if (ch === "\n" || ch === "\r") continue;
      out += ch === "\t" ? " ".repeat(cols - (out.length % cols)) : ch;
    }
    return out;
  };

  const emitText = (node: Text, cs: CSSStyleDeclaration, ctx: Ctx): void => {
    const pre = PRE_SPACE.has(cs.whiteSpace);
    for (const line of lineRects(node)) {
      const t = pre ? keepSpaces(line.t, cs) : line.t.replace(/\s+/g, " ");
      if (!t.trim()) continue;
      const r = { x: line.r.left + sx, y: line.r.top + sy, w: line.r.width, h: line.r.height };
      if (ctx.clip && (r.y + r.h <= ctx.clip.y || r.y >= ctx.clip.y + ctx.clip.h)) continue;
      emitLine(cs, r, t, ctx);
    }
  };

  const MARKERS: Record<string, string> = {
    disc: "•",
    circle: "◦",
    square: "▪",
  };

  // ::markerはgetComputedStyleに載らないので、list-style-typeから文字を起こす
  const emitMarker = (el: Element, cs: CSSStyleDeclaration, r: Rect, ctx: Ctx): void => {
    if (cs.listStyleType === "none" || cs.listStylePosition !== "outside") return;
    let glyph = MARKERS[cs.listStyleType];
    if (!glyph && cs.listStyleType === "decimal") {
      let index = 1;
      for (let p = el.previousElementSibling; p; p = p.previousElementSibling) index++;
      glyph = `${index}.`;
    }
    if (!glyph) return;
    const size = parseFloat(cs.fontSize);
    const lineHeight = parseFloat(cs.lineHeight) || size * 1.4;
    const marker = {
      x: r.x - size,
      y: r.y + (lineHeight - size) / 2,
      w: size * 0.9,
      h: size * 1.2,
    };
    emitLine(cs, marker, glyph, ctx);
  };

  // 擬似要素の矩形は直接測れない。position:absoluteなら親の枠と指定値から起こせる
  const pseudoRect = (cs: CSSStyleDeclaration, parent: Rect): Rect | undefined => {
    if (cs.position !== "absolute" && cs.position !== "fixed") return undefined;
    const w = parseFloat(cs.width);
    const h = parseFloat(cs.height);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w < 0.5 || h < 0.5) return undefined;
    const left = parseFloat(cs.left);
    const right = parseFloat(cs.right);
    const top = parseFloat(cs.top);
    const bottom = parseFloat(cs.bottom);
    const x = Number.isFinite(left)
      ? parent.x + left
      : Number.isFinite(right)
        ? parent.x + parent.w - right - w
        : parent.x;
    const y = Number.isFinite(top)
      ? parent.y + top
      : Number.isFinite(bottom)
        ? parent.y + parent.h - bottom - h
        : parent.y;
    return { x, y, w, h };
  };

  const CONTENT_TEXT = /^"(.*)"$/s;

  // アイコン書体が字を割り当てる私用領域。面15と16は全域が私用領域なので代理対も見る。
  // 書体を置き換えて描くと豆腐になる
  const PUA = /[\ue000-\uf8ff]|[\udb80-\udbff][\udc00-\udfff]/;

  // 戻り値は「この要素ごとラスタにしないと再現できない」か
  const emitPseudo = (el: Element, kind: string, parent: Rect, ctx: Ctx): boolean => {
    const cs = getComputedStyle(el, kind);
    const content = cs.content;
    if (!content || content === "none" || content === "normal") return false;
    if (cs.display === "none" || cs.visibility === "hidden") return false;
    const opacity = Number(cs.opacity);
    if (opacity === 0) return false;
    const inner: Ctx = {
      ...ctx,
      alpha: ctx.alpha * (Number.isFinite(opacity) ? opacity : 1),
    };
    const r = pseudoRect(cs, parent);
    const text = CONTENT_TEXT.exec(content)?.[1];
    if (text !== undefined && PUA.test(text)) return true;
    // 流れの中に置かれた擬似要素は位置を起こせない
    if (!r) return cs.backgroundImage !== "none" || text === undefined;
    if (cs.backgroundImage !== "none") return true;
    emitBox(cs, r, inner);
    if (text && text.trim()) emitLine(cs, r, text, inner);
    return false;
  };

  const hasText = (el: Element): boolean => (el.textContent ?? "").trim().length > 0;

  const maskOf = (cs: CSSStyleDeclaration): string => {
    const style = cs as CSSStyleDeclaration & { webkitMaskImage?: string };
    const mask = cs.maskImage ?? style.webkitMaskImage;
    return mask && mask !== "" ? mask : "none";
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

  const ACTIVATION_ROLES = new Set([
    "button",
    "link",
    "checkbox",
    "switch",
    "radio",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "tab",
    "option",
  ]);

  // cursor:pointerとtabindexは見ない。cursorは継承するので親に付いていれば無関係な子孫まで
  // 押せることになり、tabindexはスクロール領域にも付く
  const clickable = (el: Element, tag: string): boolean => {
    if (tag === "A") return el.getAttribute("href") !== null;
    if (tag === "BUTTON" || tag === "SUMMARY") return true;
    // checkboxを隠してlabelだけ見せる開閉メニュー。controlを持たないlabelは
    // サイト側のJSが拾う（Wikipediaの☰を閉じるマスク）
    if (tag === "LABEL") return true;
    // 入力欄はFIELD側で当たり判定を置く
    if (FIELD.has(tag)) return false;
    if (el.hasAttribute("onclick")) return true;
    const role = el.getAttribute("role");
    return role !== null && role.split(/\s+/).some((r) => ACTIVATION_ROLES.has(r));
  };

  // 塗り順の段（CSS2.1付録E）。SELFは文脈を作った要素自身の背景、FLOWはその中の通常フロー
  const SELF = 0;
  const BELOW = 1;
  const FLOW = 2;
  const ABOVE = 3;
  let order = 0;

  // opacityとtransformとfilterで文脈を作る要素は、位置指定でなくてもz:0の位置指定と同じ段。
  // z:autoの位置指定は文脈を作らないので、中の位置指定要素は外の文脈に属したままにする
  const layersOf = (cs: CSSStyleDeclaration, ctx: Ctx) => {
    const positioned = cs.position !== "static";
    const z = positioned ? parseInt(cs.zIndex) : NaN;
    const context =
      Number.isFinite(z) ||
      Number(cs.opacity) < 1 ||
      cs.transform !== "none" ||
      cs.filter !== "none";
    if (!positioned && !context) return { stack: ctx.stack, layer: ctx.layer, own: ctx.layer };
    const zi = Number.isFinite(z) ? z : 0;
    const step = [...ctx.stack, zi < 0 ? BELOW : ABOVE, zi, order++];
    const layer = [...step, FLOW];
    if (!context) return { stack: ctx.stack, layer, own: layer };
    return { stack: step, layer, own: [...step, SELF] };
  };

  const walk = (el: Element, ctx: Ctx, depth: number): void => {
    if (depth > 80) return;
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) {
        emitText(node as Text, getComputedStyle(el), ctx);
        continue;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      const child = node as Element;
      // SVG要素のtagNameはXML由来で小文字（svg）。大文字前提で拾うと絵ごと落ちる
      const tag = child.tagName.toUpperCase();
      if (SKIP.has(tag)) continue;
      const cs = getComputedStyle(child);
      // content-visibility:hiddenの中身は描かれないのに矩形は畳む前のまま返る
      // （Wikipediaの折りたたまれた節）。歩くと閉じた節が全部重なって出る
      if (
        cs.display === "none" ||
        cs.visibility === "hidden" ||
        cs.contentVisibility === "hidden"
      ) {
        continue;
      }
      // display:contentsは箱を作らないので矩形が0x0で返る
      if (cs.display === "contents") {
        const through: Ctx = { ...ctx };
        if (clickable(child, tag)) through.link = idOf(child);
        walk(child, through, depth + 1);
        continue;
      }
      const opacity = Number(cs.opacity);
      if (opacity === 0) continue;
      const cr = child.getBoundingClientRect();
      // 子が全部position:absoluteだと箱が0x0に潰れる（ニコニコのサムネイルの<picture>）。
      // overflowが効いていなければ子はその外へ描かれるので、枝ごと落とすと絵が消える
      if (cr.width < 0.5 && cr.height < 0.5) {
        if (cs.overflow !== "visible") continue;
        const through: Ctx = { ...ctx };
        if (clickable(child, tag)) through.link = idOf(child);
        walk(child, through, depth + 1);
        continue;
      }
      const r: Rect = { x: cr.left + sx, y: cr.top + sy, w: cr.width, h: cr.height };
      if (hiddenForReaders(cs, r) || outside(r, ctx.clip)) continue;
      // 画像が撮れないままクライアントが要求し続け、キューが詰まる
      if (r.x >= pageWidth || r.x + r.w <= 0) continue;

      const layers = layersOf(cs, ctx);
      const inner: Ctx = {
        link: ctx.link,
        clip: cs.overflow === "visible" ? ctx.clip : r,
        stack: layers.stack,
        layer: layers.layer,
        alpha: ctx.alpha * (Number.isFinite(opacity) ? opacity : 1),
      };
      const link = clickable(child, tag) ? idOf(child) : undefined;
      if (link !== undefined) inner.link = link;
      // 自身の背景は文脈の最初の段。負のzの子はこの上に乗る
      const own: Ctx = layers.own === layers.layer ? inner : { ...inner, layer: layers.own };
      // インライン要素の枠は行をまたぐと行間まで含む。中の文字と画像のopが
      // 同じnodeIdを持つので当たり判定は要らない
      if (link !== undefined && cs.display !== "inline" && child.getClientRects().length === 1) {
        push({ t: 3, b: box(r), a: link }, own, r);
      }

      if (RASTER.has(tag)) {
        raster(child, r, own, false);
        continue;
      }
      // background-colorをマスクで抜いてアイコンにする書き方。
      // 色で塗るだけだと絵が四角い塊になる
      if (maskOf(cs) !== "none" && r.w >= 4 && r.h >= 4) {
        raster(child, r, own, true);
        continue;
      }
      // 背景の上に子の文字が乗るので、ラスタにしても走査は続ける
      if (cs.backgroundImage !== "none" && r.w >= 8 && r.h >= 8) {
        raster(child, r, own, true);
        walk(child, inner, depth + 1);
        continue;
      }

      // 行をまたぐインライン要素は矩形が行ごとに返る。まとめた1つで塗ると行間まで埋まり、
      // 折り返した先の行が丸ごと背景色になる（MDNの<code>）
      const fragments = cs.display === "inline" ? child.getClientRects() : undefined;
      if (fragments !== undefined && fragments.length > 1) {
        for (const f of fragments) {
          emitBox(cs, { x: f.left + sx, y: f.top + sy, w: f.width, h: f.height }, own);
        }
      } else {
        emitBox(cs, r, own);
      }
      const iconic =
        emitPseudo(child, "::before", r, inner) || emitPseudo(child, "::after", r, inner);
      if (iconic && !hasText(child)) {
        raster(child, r, own, true);
        continue;
      }
      if (FIELD.has(tag)) {
        const input = child as HTMLInputElement;
        const id = idOf(child);
        // selectのvalueはoption要素のvalue属性。見えているのは選ばれたoptionの文字
        const picked = tag === "SELECT" ? (child as HTMLSelectElement).selectedOptions[0] : null;
        const shown = picked ? picked.text.trim() : input.value || input.placeholder || "";
        if (shown) {
          const size = parseFloat(cs.fontSize);
          const fo = fontId(cs); // measureのフォントもここで揃う
          // 欄の外へ押し出して字を隠す書き方（Amazonの検索ボタンはアイコンだけ見せる）。
          // 位置さえ合わせれば欄のclipで消える。%指定は解決前の値が返るので使わない
          const indent = cs.textIndent.endsWith("px") ? parseFloat(cs.textIndent) : 0;
          const left = parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth) + indent;
          const line = {
            x: r.x + (Number.isFinite(left) ? left : 6),
            y: r.y + (r.h - size * 1.2) / 2,
            w: Math.min(measure.measureText(shown).width, r.w),
            h: size * 1.2,
          };
          const co = colorId(picked || input.value ? cs.color : "rgb(150,150,150)", inner.alpha);
          if (co >= 0) push({ t: 1, b: box(line), fo, co, s: shown }, inner, line);
        }
        // 描くものは無い。タップでこの欄へ入るための当たり判定として置く
        push({ t: 3, b: box(r), a: id }, inner, r);
        continue;
      }
      if (cs.display === "list-item") emitMarker(child, cs, r, inner);
      walk(child, inner, depth + 1);
    }
  };

  walk(document.body, { link: undefined, clip: undefined, stack: [], layer: [FLOW], alpha: 1 }, 0);

  // 同じ経路はDOM順のまま。Array.sortが安定であることに頼っている
  layered.sort((a, b) => {
    const n = Math.min(a.layer.length, b.layer.length);
    for (let i = 0; i < n; i++) {
      if (a.layer[i] !== b.layer[i]) return a.layer[i]! - b.layer[i]!;
    }
    return a.layer.length - b.layer.length;
  });

  return {
    title: document.title,
    url: location.href,
    list: {
      pageWidth,
      fullHeight: Math.ceil(document.documentElement.scrollHeight),
      bg: colorId(getComputedStyle(document.body).backgroundColor, 1),
      colors,
      fonts,
      ops: layered.map((l) => l.op),
    },
    rects,
  };
}
