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
  | { type: "hello"; ver: 1; token: string; viewportW: number; viewportH: number; dpr: number;
      cacheId: string; cacheBytes: number }
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
  // ローカルスクロール位置通知（300msスロットル）。live中はpageIdを空にする。
  // 遷移直後は前のページ向けの通知が遅れて届くので、サーバーはpageIdで宛先を確かめる
  | { type: "scrollPos"; pageId: string; y: number }
  | { type: "insertText"; text: string }              // IME 確定文字列
  | { type: "key"; key: "Enter" | "Backspace" }
  | { type: "setMode"; mode: "page" | "live" }        // ライブモード切替
  | { type: "liveAck" }                               // ライブフレーム受信確認（次フレーム送信の許可）
  // tileRefで指されたタイルが手元に無かったときの再要求。サーバーは実体を送り直す
  | { type: "requestTiles"; indices: number[] };

// ---- サーバー → クライアント ----
export type ServerMsg =
  | { type: "helloAck"; ver: 1; sessionId: string }
  // 直後のバイナリフレームが本体。width/heightはページ座標（CSS px）
  | { type: "screenshotHeader"; format: "webp"; width: number; height: number; byteLength: number }
  // pageWidthはこのページのタイルを撮ったエミュレーション幅。以降の座標はすべてこれが基準。
  // scrollYは表示を始める位置。戻る・進む・タブ切替では離れたときの位置が返る。
  // hashesはindex順のタイルhashで、クライアントが持っているはずのものだけ入る（未送信はnull）。
  // 手元に無かったものはrequestTilesで要求し直す
  | { type: "pageBegin"; pageId: string; url: string; title: string; pageWidth: number;
      fullHeight: number; tileHeight: number; tileCount: number; scrollY: number;
      hashes: (string | null)[] }
  // hashはこのタイルのバイト列の識別子。クライアントは受け取った実体をhashで持っておく
  | { type: "tileHeader"; pageId: string; tileIndex: number; offsetY: number;
      format: "webp"; byteLength: number; hash: string }
  // 送信済みのタイルと同じ絵。実体を送らずhashで参照する（戻る・進むでほぼ全面が一致する）。
  // 手元に無ければrequestTilesで実体を要求すること
  | { type: "tileRef"; pageId: string; tileIndex: number; offsetY: number; hash: string }
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
