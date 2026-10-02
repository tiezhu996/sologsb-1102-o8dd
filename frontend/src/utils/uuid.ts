/**
 * 通用小工具：主键生成
 * 浏览器优先使用 crypto.randomUUID，降级到时间戳 + 随机串，避免依赖外部库。
 */

function fallbackUuid(): string {
  const rand = Math.random().toString(16).slice(2, 10);
  const rand2 = Math.random().toString(16).slice(2, 6);
  return `${Date.now().toString(16)}-${rand}-${rand2}`;
}

export function uuid(): string {
  const cryptoObj: Crypto | undefined =
    typeof globalThis !== 'undefined' ? (globalThis.crypto as Crypto | undefined) : undefined;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return cryptoObj.randomUUID();
  }
  return fallbackUuid();
}

/** 当前时间 ISO 字符串 */
export function nowIso(): string {
  return new Date().toISOString();
}

/** ISO 字符串 → 「MM-DD HH:mm」 */
export function formatStamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 深拷贝（结构化数据，仅用于本地草稿） */
export function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
