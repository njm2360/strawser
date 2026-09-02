// WS メッセージ型定義の単一ソース。
// サーバーは server/src/protocol.ts から再エクスポートして参照する。
// Android 側は net/Protocol.kt に転記する（変更時は両方を更新すること）。
//
// テキストフレームは JSON。バイナリフレームは直前のヘッダメッセージ
// （screenshotHeader / tileHeader / liveFrameHeader）に対応する画像データ。
// 座標系はサーバー側エミュレーション幅 720px（CSS px）を基準にする。

// ---- クライアント → サーバー ----
export type ClientMsg =
  | { type: "hello"; ver: 1; token: string; viewportW: number; viewportH: number }
  | { type: "navigate"; url: string }
  | { type: "back" }
  | { type: "forward" }
  | { type: "reload" }
  | { type: "tap"; x: number; y: number }            // ページ座標（720px 基準）
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
  // 直後のバイナリフレームが本体。width/height はページ座標（720px 基準の CSS px）
  | { type: "screenshotHeader"; format: "webp"; width: number; height: number; byteLength: number }
  | { type: "pageBegin"; pageId: string; url: string; title: string;
      fullHeight: number; tileHeight: 2048; tileCount: number }
  | { type: "tileHeader"; pageId: string; tileIndex: number; offsetY: number;
      format: "webp"; byteLength: number }
  | { type: "pageExtend"; pageId: string; newFullHeight: number; addedTiles: number }
  // scrollY: フレーム時点の実ページのスクロール位置（ページ座標）。
  // ライブ中のタップ座標変換とクライアント側スクロール量の基準に使う
  | { type: "liveFrameHeader"; format: "jpeg"; byteLength: number; scrollY: number }
  | { type: "focus"; kind: "text" | "none" }          // 入力欄フォーカス状態 → IME 表示制御
  | { type: "navState"; canGoBack: boolean; canGoForward: boolean; url: string; loading: boolean }
  | { type: "error"; message: string };
