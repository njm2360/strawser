import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

// server/config.json に固定トークンを保持する。初回起動時に自動生成される。
// Tailscale/WireGuard が実質の認証層であり、これは誤接続防止程度の位置づけ
const CONFIG_PATH = path.resolve(import.meta.dirname, "..", "config.json");

export interface Config {
  token: string;
}

export function loadConfig(): Config {
  if (existsSync(CONFIG_PATH)) {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Config;
  }
  const config: Config = { token: randomBytes(16).toString("hex") };
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
  console.log(`generated new token in ${CONFIG_PATH}`);
  return config;
}
