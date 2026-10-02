/**
 * 操耍人（Operator）数据模型
 * 班社里负责签子操耍的师傅，含技能标签、冲突时段与已派角色。
 */

/** 签子 / 连本 / 武打 */
export type SkillTag = 'qianzi' | 'lianben' | 'wuda';

/** 一周中的排练日 */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** 已排时段（用于冲突预警） */
export interface BusySlot {
  /** 主键，uuid */
  id: string;
  /** 星期，0 = 周日 */
  weekday: Weekday;
  /** 起始「分钟偏移」，相对当日 08:00 计算，便于比较 */
  startMinute: number;
  /** 持续分钟数 */
  durationMinute: number;
  /** 备注，如「连排第三场」 */
  label: string;
}

export interface Operator {
  /** 主键，uuid */
  id: string;
  /** 姓名 */
  name: string;
  /** 技能标签 */
  skillTags: SkillTag[];
  /** 冲突时段 */
  busySlots: BusySlot[];
  /** 已派角色 id 列表 */
  assignedRoleIds: string[];
  /** 累计排练时长（小时） */
  rehearsalHours: number;
  /** 创建时间（ISO 字符串） */
  createdAt: string;
  /** 最近修改时间（ISO 字符串） */
  updatedAt: string;
}

/** 新建操耍人表单草稿 */
export type OperatorDraft = Pick<Operator, 'name' | 'skillTags'>;

export const SKILL_TAG_OPTIONS: ReadonlyArray<{ value: SkillTag; label: string }> = [
  { value: 'qianzi', label: '签子' },
  { value: 'lianben', label: '连本' },
  { value: 'wuda', label: '武打' },
];

export const SKILL_TAG_LABEL: Record<SkillTag, string> = {
  qianzi: '签子',
  lianben: '连本',
  wuda: '武打',
};

export const SKILL_TAG_COLOR: Record<SkillTag, string> = {
  qianzi: 'gold',
  lianben: 'blue',
  wuda: 'red',
};

export const WEEKDAY_OPTIONS: ReadonlyArray<{ value: Weekday; label: string }> = [
  { value: 0, label: '周日' },
  { value: 1, label: '周一' },
  { value: 2, label: '周二' },
  { value: 3, label: '周三' },
  { value: 4, label: '周四' },
  { value: 5, label: '周五' },
  { value: 6, label: '周六' },
];

export const WEEKDAY_LABEL: Record<Weekday, string> = {
  0: '周日',
  1: '周一',
  2: '周二',
  3: '周三',
  4: '周四',
  5: '周五',
  6: '周六',
};

/** 排练日基准时间：08:00 记作 0 分钟 */
export const DAY_BASE_HOUR = 8;

/** 把「分钟偏移」格式化为 HH:mm */
export function minuteToClock(minute: number): string {
  const total = DAY_BASE_HOUR * 60 + minute;
  const h = Math.floor(total / 60) % 24;
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** 时段区间，用于冲突判定 */
export interface SlotRange {
  slotId: string;
  weekday: Weekday;
  startMinute: number;
  endMinute: number;
  label: string;
}

/** 两个时段是否重叠 */
export function slotsOverlap(a: SlotRange, b: SlotRange): boolean {
  if (a.weekday !== b.weekday) return false;
  return a.startMinute < b.endMinute && b.startMinute < a.endMinute;
}

export function createEmptyOperatorDraft(): OperatorDraft {
  return { name: '', skillTags: ['qianzi'] };
}
