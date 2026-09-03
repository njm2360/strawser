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
  // 反映する（dprはサーバー側の上限で切り詰められる）
  | { type: "hello"; ver: 1; token: string; viewportW: number; viewportH: number; dpr: number }
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
  | { type: "tap"; x: number; y: number }            // ページ座標（pageWidth基準）
  | { type: "longPress"; x: number; y: number }
  | { type: "scrollPos"; y: number }                  // ローカルスクロール位置通知（300ms スロットル）
  | { type: "insertText"; text: string }              // IME 確定文字列
  | { type: "key"; key: "Enter" | "Backspace" }
  | { type: "setMode"; mode: "page" | "live" }        // ライブモード切替
  | { type: "liveAck" }                               // ライブフレーム受信確認（次フレーム送信の許可）
  | { type: "requestTiles"; indices: number[] };      // 明示的なタイル再要求

// ---- サーバー → クライアント ----
export type ServerMsg =
  | { type: "helloAck"; ver: 1; sessionId: string }
  // 直後のバイナリフレームが本体。width/heightはページ座標（CSS px）
  | { type: "screenshotHeader"; format: "webp"; width: number; height: number; byteLength: number }
  // pageWidthはこのページのタイルを撮ったエミュレーション幅。以降の座標はすべてこれが基準
  | { type: "pageBegin"; pageId: string; url: string; title: string; pageWidth: number;
      fullHeight: number; tileHeight: number; tileCount: number }
  | { type: "tileHeader"; pageId: string; tileIndex: number; offsetY: number;
      format: "webp"; byteLength: number }
  | { type: "pageExtend"; pageId: string; newFullHeight: number; addedTiles: number }
  // scrollY: フレーム時点の実ページのスクロール位置（ページ座標）。
  // ライブ中のタップ座標変換とクライアント側スクロール量の基準に使う
  | { type: "liveFrameHeader"; format: "jpeg"; byteLength: number; scrollY: number;
      pageWidth: number }
  | { type: "focus"; kind: "text" | "none" }          // 入力欄フォーカス状態 → IME 表示制御
  | { type: "navState"; canGoBack: boolean; canGoForward: boolean; url: string; loading: boolean }
  // タブの増減・並び・表示中タブ・タイトル更新のたびに一覧ごと送り直す
  | { type: "tabs"; tabs: { id: string; title: string; url: string }[]; activeId: string }
  | { type: "error"; message: string };
