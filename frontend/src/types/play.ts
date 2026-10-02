/**
 * 剧目（Play）数据模型
 * 一出台戏的顶层信息，新建剧目后自动生成场次拆分入口。
 */

/** 传统折子 / 新编 */
export type PlayGenre = 'traditional' | 'newly';

/** 筹备中 / 排练中 / 可上演 */
export type PlayStatus = 'preparing' | 'rehearsing' | 'ready';

export interface Play {
  /** 主键，uuid */
  id: string;
  /** 剧目名 */
  title: string;
  /** 剧种：传统折子 / 新编 */
  genre: PlayGenre;
  /** 剧情提要 */
  scriptText: string;
  /** 场次总数（由场次拆分页维护，创建时给默认值） */
  totalScenes: number;
  /** 首演戏台 */
  premiereVenue: string;
  /** 筹备状态 */
  status: PlayStatus;
  /** 创建时间（ISO 字符串） */
  createdAt: string;
  /** 最近修改时间（ISO 字符串） */
  updatedAt: string;
}

/** 新建剧目时的表单草稿（id / 时间戳 / totalScenes 由 store 生成） */
export type PlayDraft = Pick<Play, 'title' | 'genre' | 'scriptText' | 'premiereVenue' | 'status'>;

export const PLAY_GENRE_OPTIONS: ReadonlyArray<{ value: PlayGenre; label: string }> = [
  { value: 'traditional', label: '传统折子' },
  { value: 'newly', label: '新编' },
];

export const PLAY_STATUS_OPTIONS: ReadonlyArray<{ value: PlayStatus; label: string }> = [
  { value: 'preparing', label: '筹备中' },
  { value: 'rehearsing', label: '排练中' },
  { value: 'ready', label: '可上演' },
];

export const PLAY_GENRE_LABEL: Record<PlayGenre, string> = {
  traditional: '传统折子',
  newly: '新编',
};

export const PLAY_STATUS_LABEL: Record<PlayStatus, string> = {
  preparing: '筹备中',
  rehearsing: '排练中',
  ready: '可上演',
};

export const PLAY_STATUS_COLOR: Record<PlayStatus, string> = {
  preparing: 'default',
  rehearsing: 'processing',
  ready: 'success',
};

/** 新建剧目的默认值，供表单与 store 共用 */
export function createEmptyPlayDraft(): PlayDraft {
  return {
    title: '',
    genre: 'traditional',
    scriptText: '',
    premiereVenue: '',
    status: 'preparing',
  };
}
