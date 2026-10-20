/** 哈希：文档指纹与缓存键都基于 SHA-256（WebCrypto，扩展页与 SW 均可用） */

export async function sha256Hex(input: ArrayBuffer | Uint8Array | string): Promise<string> {
  let data: BufferSource;
  if (typeof input === 'string') data = new TextEncoder().encode(input);
  else if (input instanceof Uint8Array) data = input as unknown as BufferSource;
  else data = input;
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** 取前 16 位，用于展示 */
export function shortId(hash: string): string {
  return hash.slice(0, 16);
}

/**
 * 文档指纹：文件字节哈希（最稳）。若字节不可用（例如超大文件）退回 URL+大小。
 */
export async function documentFingerprint(bytes: ArrayBuffer | null, url: string, size: number): Promise<string> {
  if (bytes) return `b:${await sha256Hex(bytes)}`;
  return `u:${await sha256Hex(`${url}|${size}`)}`;
}
