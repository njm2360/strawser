// クライアントのタイルキャッシュの写し。hashからバイト数で、挿入順がLRU。
// helloで渡された容量に合わせて同じ順に捨てる。復号のためのアクセスまでは追えないので
// 完全一致はしないが、食い違ってもrequestTilesで実体を要求され直すだけで済む
export const clientTiles = new Map<string, number>();
export let clientCacheId = "";
export let clientCacheLimit = 16 * 1024 * 1024;
let clientCacheUsed = 0;

export function setClientCacheLimit(bytes: number): void {
  clientCacheLimit = bytes;
}

export function resetClientTiles(cacheId: string): void {
  clientCacheId = cacheId;
  clientTiles.clear();
  clientCacheUsed = 0;
}

export function rememberHash(hash: string, byteLength: number): void {
  const prev = clientTiles.get(hash);
  if (prev !== undefined) {
    clientTiles.delete(hash); // 再挿入して最近使った順にする
    clientCacheUsed -= prev;
  }
  clientTiles.set(hash, byteLength);
  clientCacheUsed += byteLength;
  for (const [old, size] of clientTiles) {
    if (clientCacheUsed <= clientCacheLimit) break;
    clientTiles.delete(old);
    clientCacheUsed -= size;
  }
}
