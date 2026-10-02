/**
 * 锣鼓点（PercussionCue）数据模型
 * 场次时间轴上的一个鼓点：按秒插入并与其他场次对齐。
 */

/** 急急风 / 四击头 / 水底鱼 */
export type BeatName = 'jijifeng' | 'sijitou' | 'shuidiyu';

/** 板鼓 / 大锣 / 小锣 / 铙钹 */
export type Instrument = 'bangu' | 'daluo' | 'xiaoluo' | 'naobo';

export interface PercussionCue {
  /** 主键，uuid */
  id: string;
  /** 所属场次 id */
  sceneId: string;
  /** 锣鼓点名 */
  beatName: BeatName;
  /** 主奏乐器 */
  instrument: Instrument;
  /** 出场秒点（相对场次开场，秒） */
  atSecond: number;
  /** 领奏操耍人 id，未指派为 null */
  leadOperator: string | null;
  /** 备注 */
  note: string;
  /** 创建时间（ISO 字符串） */
  createdAt: string;
  /** 最近修改时间（ISO 字符串） */
  updatedAt: string;
}

/** 新建鼓点表单草稿（atSecond 由时间轴光标带入） */
export type CueDraft = Pick<PercussionCue, 'beatName' | 'instrument' | 'atSecond' | 'leadOperator' | 'note'>;

export const BEAT_NAME_OPTIONS: ReadonlyArray<{ value: BeatName; label: string }> = [
  { value: 'jijifeng', label: '急急风' },
  { value: 'sijitou', label: '四击头' },
  { value: 'shuidiyu', label: '水底鱼' },
];

export const BEAT_NAME_LABEL: Record<BeatName, string> = {
  jijifeng: '急急风',
  sijitou: '四击头',
  shuidiyu: '水底鱼',
};

/** 锣鼓点的节奏密度（每分钟拍点），用于时间轴提示 */
export const BEAT_DENSITY: Record<BeatName, number> = {
  jijifeng: 168,
  sijitou: 96,
  shuidiyu: 132,
};

export const INSTRUMENT_OPTIONS: ReadonlyArray<{ value: Instrument; label: string }> = [
  { value: 'bangu', label: '板鼓' },
  { value: 'daluo', label: '大锣' },
  { value: 'xiaoluo', label: '小锣' },
  { value: 'naobo', label: '铙钹' },
];

export const INSTRUMENT_LABEL: Record<Instrument, string> = {
  bangu: '板鼓',
  daluo: '大锣',
  xiaoluo: '小锣',
  naobo: '铙钹',
};

export const INSTRUMENT_COLOR: Record<Instrument, string> = {
  bangu: '#7a1f1f',
  daluo: '#c9963c',
  xiaoluo: '#2f6f4f',
  naobo: '#3b5b8c',
};

export function createEmptyCueDraft(atSecond: number): CueDraft {
  return {
    beatName: 'sijitou',
    instrument: 'bangu',
    atSecond: Math.max(0, Math.round(atSecond)),
    leadOperator: null,
    note: '',
  };
}
