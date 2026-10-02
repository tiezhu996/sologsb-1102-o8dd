/**
 * 浏览器本地存储封装
 * - IndexedDB（Dexie）：剧目 / 场次 / 影人角色 / 操耍人 / 锣鼓点 的持久化
 * - localStorage：各类界面偏好与最后一次导出的存档信息
 */

const STORAGE_PREFIX = 'gbshadowplay:';

export const STORAGE_KEYS = {
  /** 最近一次打开的剧目 id */
  lastPlayId: 'lastPlayId',
  /** 最近导出存档的时间 */
  lastBackupAt: 'lastBackupAt',
  /** 场次页表头偏好（是否只看本次排练勾选） */
  sceneOnlySelected: 'sceneOnlySelected',
} as const;

export type StorageKey = (typeof STORAGE_KEYS)[keyof typeof STORAGE_KEYS];

/** 读取字符串配置 */
export function readLocal(key: StorageKey, fallback = ''): string {
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + key);
    return raw === null ? fallback : raw;
  } catch {
    return fallback;
  }
}

/** 写入字符串配置 */
export function writeLocal(key: StorageKey, value: string): void {
  try {
    window.localStorage.setItem(STORAGE_PREFIX + key, value);
  } catch {
    /* 隐私模式下写入失败时静默降级，不影响主流程 */
  }
}

/** 移除配置 */
export function removeLocal(key: StorageKey): void {
  try {
    window.localStorage.removeItem(STORAGE_PREFIX + key);
  } catch {
    /* 同上 */
  }
}

/** 读取布尔配置 */
export function readLocalFlag(key: StorageKey, fallback = false): boolean {
  const raw = readLocal(key, fallback ? '1' : '0');
  return raw === '1' || raw === 'true';
}

/** 写入布尔配置 */
export function writeLocalFlag(key: StorageKey, value: boolean): void {
  writeLocal(key, value ? '1' : '0');
}

/** 读取 JSON 配置（解析失败返回 fallback） */
export function readLocalJson<T>(key: StorageKey, fallback: T): T {
  const raw = readLocal(key, '');
  if (raw === '') return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** 写入 JSON 配置 */
export function writeLocalJson<T>(key: StorageKey, value: T): void {
  try {
    writeLocal(key, JSON.stringify(value));
  } catch {
    /* 同上 */
  }
}
