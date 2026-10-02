/**
 * 场次（Scene）数据模型
 * 一出台戏按场序拆分出的排练单元，支持拖拽调序、勾选本次排练覆盖范围。
 */

/** 影窗规格 */
export type ShadowScreenSpec = 'small' | 'standard' | 'large' | 'twin';

export interface Scene {
  /** 主键，uuid */
  id: string;
  /** 所属剧目 id */
  playId: string;
  /** 场序，从 1 开始，连续整数 */
  seq: number;
  /** 场次标题，如「第一场·借伞」 */
  title: string;
  /** 时长（分钟） */
  durationMin: number;
  /** 舞台提示 */
  stageNote: string;
  /** 影窗规格 */
  needsShadowScreen: ShadowScreenSpec;
  /** 排练进度 0-100 */
  progress: number;
  /** 创建时间（ISO 字符串） */
  createdAt: string;
  /** 最近修改时间（ISO 字符串） */
  updatedAt: string;
}

/** 新建场次时的表单草稿 */
export type SceneDraft = Pick<
  Scene,
  'title' | 'durationMin' | 'stageNote' | 'needsShadowScreen' | 'progress'
>;

export const SHADOW_SCREEN_OPTIONS: ReadonlyArray<{ value: ShadowScreenSpec; label: string }> = [
  { value: 'small', label: '小影窗 · 1.2m' },
  { value: 'standard', label: '标准影窗 · 1.8m' },
  { value: 'large', label: '大影窗 · 2.4m' },
  { value: 'twin', label: '双联影窗 · 2×1.6m' },
];

export const SHADOW_SCREEN_LABEL: Record<ShadowScreenSpec, string> = {
  small: '小影窗 · 1.2m',
  standard: '标准影窗 · 1.8m',
  large: '大影窗 · 2.4m',
  twin: '双联影窗 · 2×1.6m',
};

export function createEmptySceneDraft(seq: number): SceneDraft {
  return {
    title: `第 ${seq} 场`,
    durationMin: 12,
    stageNote: '',
    needsShadowScreen: 'standard',
    progress: 0,
  };
}

/** 排练成熟度分档，用于环形指示与文案 */
export type MaturityLevel = 'cold' | 'warm' | 'hot' | 'ready';

export function maturityOf(progress: number): MaturityLevel {
  if (progress >= 100) return 'ready';
  if (progress >= 60) return 'hot';
  if (progress >= 30) return 'warm';
  return 'cold';
}

export const MATURITY_LABEL: Record<MaturityLevel, string> = {
  cold: '生台',
  warm: '顺场',
  hot: '待合乐',
  ready: '可上演',
};

export const MATURITY_COLOR: Record<MaturityLevel, string> = {
  cold: '#8c8c8c',
  warm: '#d48806',
  hot: '#c9963c',
  ready: '#7a1f1f',
};
