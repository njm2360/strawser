import { WebSocketServer } from "ws";
import { startBrowser, stopBrowser } from "./browser.ts";
import { loadConfig } from "./config.ts";
import { handleMsg } from "./handlers.ts";
import { setLiveFrameInFlight } from "./modes/live.ts";
import { attachTab } from "./tabs.ts";
import { client, setClient, send, stripAnsi } from "./wire.ts";
import type { ClientMsg } from "./protocol.ts";

const PORT = 8080;
const config = loadConfig();

const CLOSE_UNAUTHORIZED = 4001;
// 受け取った側は再接続してはならない。し合うと互いを蹴り続ける
const CLOSE_SUPERSEDED = 4002;

async function main(): Promise<void> {
  await startBrowser(attachTab);

  // 表示リストのJSONは圧縮で3分の1以下になる。閾値より小さいフレームは素通しする
  const wss = new WebSocketServer({
    port: PORT,
    perMessageDeflate: { threshold: 2048 },
  });
  wss.on("connection", (ws, req) => {
    const token = new URL(req.url ?? "/", "ws://localhost").searchParams.get("token");
    if (token !== config.token) {
      console.log("client rejected: bad token");
      ws.close(CLOSE_UNAUTHORIZED, "unauthorized");
      return;
    }
    console.log("client connected");
    client?.close(CLOSE_SUPERSEDED, "superseded");
    setClient(ws);
    setLiveFrameInFlight(false); // 旧接続の liveAck は二度と来ない

    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      let msg: ClientMsg;
      try {
        msg = JSON.parse(data.toString()) as ClientMsg;
      } catch {
        send({ type: "error", message: "invalid JSON" });
        return;
      }
      console.log(msg.type === "scrollPos" ? `<- scrollPos y=${msg.y}` : `<- ${msg.type}`);
      handleMsg(msg).catch((e) => {
        console.error("handleMsg failed:", e);
        send({ type: "error", message: stripAnsi(String(e)) });
      });
    });

    ws.on("close", () => {
      if (client === ws) setClient(undefined);
      console.log("client disconnected");
    });
    ws.on("error", (e) => console.error("ws error:", e));
  });

  console.log(`listening on ws://0.0.0.0:${PORT}`);
  console.log(`auth token: ${config.token}`);

  const shutdown = async () => {
    wss.close();
    await stopBrowser();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
