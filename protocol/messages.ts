// WS メッセージ型定義の単一ソース。
// サーバーは server/src/protocol.ts から再エクスポートして参照する。
// Android 側は net/Protocol.kt に転記する（変更時は両方を更新すること）。
//
// テキストフレームは JSON。バイナリフレームは直前のヘッダメッセージ
// （screenshotHeader / tileHeader / liveFrameHeader）に対応する画像データ。
//
// 座標系はサーバー側エミュレーション幅（CSS px）が基準。クライアントの表示幅dpをそのまま
// 採用するので1 CSS px = 1 dpになる。幅は回転で変わるのでpageBegin/liveFrameHeaderの
// pageWidthで毎回渡す。

// ---- クライアント → サーバー ----
export type ClientMsg =
  // viewportW/Hはdp、dprは端末の表示密度。サーバーはこれをエミュレーション幅と転送解像度に
  // 反映する（dprはサーバー側の上限で切り詰められる）。
  // cacheIdはタイルキャッシュの世代。再接続で同じidが来ればサーバーは送信済みの記憶を
  // 持ち越す。cacheBytesはその容量で、サーバーは同じ容量でクライアントの中身を推定する
  | {
      type: "hello";
      ver: 1;
      token: string;
      viewportW: number;
      viewportH: number;
      dpr: number;
      cacheId: string;
      cacheBytes: number;
    }
  // 画面回転などによる表示領域の変更
  | { type: "viewport"; width: number; height: number; dpr: number }
  // 絶対URL。URLか検索語かの振り分けと検索エンジンはクライアントが持つ
  | { type: "navigate"; url: string }
  | { type: "back" }
  | { type: "forward" }
  | { type: "reload" }
  | { type: "newTab"; url?: string }
  | { type: "closeTab"; tabId: string }
  | { type: "selectTab"; tabId: string }
  | { type: "tap"; x: number; y: number } // ページ座標（pageWidth基準）
  | { type: "longPress"; x: number; y: number }
  // ローカルスクロール位置通知（300msスロットル）。idは宛先で、pageモードはpageId、
  // vectorモードはlistId、live中は空。
  // 遷移直後は前のページ向けの通知が遅れて届くので、サーバーはこれで宛先を確かめる
  | { type: "scrollPos"; id: string; y: number }
  | { type: "insertText"; text: string } // IME 確定文字列
  | { type: "key"; key: "Enter" | "Backspace" }
  | { type: "setMode"; mode: Mode }
  | { type: "liveAck" } // ライブフレーム受信確認（次フレーム送信の許可）
  // tileRefで指されたタイルが手元に無かったときの再要求。サーバーは実体を送り直す
  | { type: "requestTiles"; indices: number[] }
  // x/yは押された位置（ページ座標）。サーバーはこれを要素の矩形へ丸め込んでタッチを注入する。
  // 大きい要素は中央が別の要素に覆われていることがある。
  // nodeIdは同じ文書のあいだ変わらないが、遷移をまたぐとlistIdで弾かれる
  | { type: "activate"; listId: string; nodeId: number; x: number; y: number }
  // 画面に入った画像の実体要求。要求されるまで送らない。
  // rawは手元でバイト列を失ったとき。assetRefで返されても絵は戻らないので実体を送り直す
  | { type: "requestAssets"; listId: string; nodeIds: number[]; raw?: boolean }
  // vectorDiffの土台が手元に無かったとき。サーバーは表示リストを丸ごと送り直す
  | { type: "requestList" }
  // textはpromptの入力
  | { type: "dialogResult"; id: string; accept: boolean; text: string };

export type Mode = "page" | "live" | "vector";

// ---- サーバー → クライアント ----
export type ServerMsg =
  | { type: "helloAck"; ver: 1; sessionId: string }
  // 直後のバイナリフレームが本体。width/heightはページ座標（CSS px）
  | {
      type: "screenshotHeader";
      format: "webp";
      width: number;
      height: number;
      byteLength: number;
    }
  // pageWidthはこのページのタイルを撮ったエミュレーション幅。以降の座標はすべてこれが基準。
  // scrollYは表示を始める位置。戻る・進む・タブ切替では離れたときの位置が返る。
  // hashesはindex順のタイルhashで、クライアントが持っているはずのものだけ入る（未送信はnull）。
  // 手元に無かったものはrequestTilesで要求し直す
  | {
      type: "pageBegin";
      pageId: string;
      url: string;
      title: string;
      pageWidth: number;
      fullHeight: number;
      tileHeight: number;
      tileCount: number;
      scrollY: number;
      hashes: (string | null)[];
    }
  // hashはこのタイルのバイト列の識別子。クライアントは受け取った実体をhashで持っておく
  | {
      type: "tileHeader";
      pageId: string;
      tileIndex: number;
      offsetY: number;
      format: "webp";
      byteLength: number;
      hash: string;
    }
  // 送信済みのタイルと同じ絵。実体を送らずhashで参照する（戻る・進むでほぼ全面が一致する）。
  // 手元に無ければrequestTilesで実体を要求すること
  | {
      type: "tileRef";
      pageId: string;
      tileIndex: number;
      offsetY: number;
      hash: string;
    }
  | {
      type: "pageExtend";
      pageId: string;
      newFullHeight: number;
      addedTiles: number;
    }
  // scrollY: フレーム時点の実ページのスクロール位置（ページ座標）。
  // ライブ中のタップ座標変換とクライアント側スクロール量の基準に使う
  | {
      type: "liveFrameHeader";
      format: "jpeg";
      byteLength: number;
      scrollY: number;
      pageWidth: number;
    }
  | { type: "focus"; kind: "text" | "none" } // 入力欄フォーカス状態 → IME 表示制御
  | {
      type: "navState";
      canGoBack: boolean;
      canGoForward: boolean;
      url: string;
      loading: boolean;
    }
  // タブの増減・並び・表示中タブ・タイトル更新のたびに一覧ごと送り直す
  | {
      type: "tabs";
      tabs: { id: string; title: string; url: string }[];
      activeId: string;
    }
  // ページ全体の描画コマンド。文字と箱はここで出し切る（実測で4〜14KB、圧縮後）。
  // 画像は矩形だけ載り、実体はrequestAssetsで要求された分だけ届く
  | {
      type: "vectorBegin";
      listId: string;
      viewKey: string; // 履歴エントリの識別子。クライアントはこれを鍵に表示リストを取っておく
      url: string;
      title: string;
      list: DisplayList;
    }
  // viewKeyの表示リストとの差分。opsは引き継ぐ区間と新しいopの並び。
  // colorsとfontsは前の表の続きだけ（indexは積み増しなので前の分はそのまま使える）
  | {
      type: "vectorDiff";
      listId: string;
      viewKey: string;
      baseId: string; // これを持っていなければrequestListで丸ごと要求する
      url: string;
      title: string;
      pageWidth: number;
      fullHeight: number;
      bg: number;
      colors: string[];
      fonts: number[][];
      ops: OpChunk[];
    }
  // 直後のバイナリフレームが画像本体
  | {
      type: "assetHeader";
      listId: string;
      nodeId: number;
      format: "webp";
      byteLength: number;
      hash: string;
    }
  // 送信済みの画像と同じバイト列。tileRefと同じくhashで引く
  | { type: "assetRef"; listId: string; nodeId: number; hash: string }
  // 答えが返るまでそのタブのJSは止まったまま
  | {
      type: "dialog";
      id: string;
      kind: "alert" | "confirm" | "prompt" | "beforeunload";
      message: string;
      defaultValue: string;
    }
  | { type: "error"; message: string };

// nが正なら土台のopsをa番目からn個、yをdyだけずらして使う。そうでなければoを差し込む。
// 同じページでも訪れ直すと版面の高さが0.5px以下動くことがあり、その下は全部ずれる
export interface OpChunk {
  a?: number;
  n?: number;
  dy?: number;
  o?: DrawOp[];
}

// 座標はすべてページ座標（CSS px）。文字は折り返し後の1行ずつを実測位置つきで送るので、
// 端末側で折り返しをやり直さない。写真とアイコンだけラスタに落ちる。
// 色とフォントは表に集約してindexで引く（1ページあたり実測で色14〜27種）

export interface DisplayList {
  pageWidth: number;
  fullHeight: number;
  bg: number; // 地の色。colorsのindex（-1なら白）
  colors: string[]; // "#rrggbb" または "#rrggbbaa"
  fonts: number[][]; // [px, weight, italic, family(0=sans,1=serif,2=mono), letterSpacing, ascent]
  ops: DrawOp[];
}

// tは 0=矩形 1=テキスト行 2=画像 3=当たり判定（描くものは無い。押せる要素と入力欄に置く）
export interface DrawOp {
  t: 0 | 1 | 2 | 3;
  b: number[]; // x, y, w, h
  f?: number; // 塗り色
  k?: number; // 枠線色
  kw?: number; // 枠線幅
  r?: number[]; // 角丸4隅
  g?: number[]; // グラデーション。角度（0が上向き、時計回り）に続いて塗り色と勾配線上の位置の組
  fo?: number; // フォント
  co?: number; // 文字色
  s?: string; // 文字
  u?: number; // 装飾のビット。1=下線、2=取り消し線
  i?: number; // 画像のnodeId。実体はrequestAssetsで要求する
  a?: number; // 押せる要素のnodeId
  sh?: number[]; // 影。dx/dy/ぼかし/色
  cl?: number[]; // 切り取り枠。x/y/w/h。overflowで切れる分だけ載る
  pn?: number; // 画面に貼り付くopを下へ運べる距離。ずらす量はmin(scrollY,pn)
}
