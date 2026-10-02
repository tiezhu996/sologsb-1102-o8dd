/**
 * 业务编号（业务键）统一发放
 *
 * 跨分队 / 跨机器合并时一律认业务编号，不认本机 uuid。
 * 编号格式：前缀-四位顺序号（JU-0001），顺序号持久化在 meta 表的全局计数器里。
 */

export const CODE_PREFIX = {
  play: 'JU',
  scene: 'CH',
  role: 'YING',
  operator: 'CAO',
  cue: 'LUO',
  slot: 'SLOT',
  /** 排演包编号（含时间信息，天然不撞） */
  package: 'BAO',
} as const;

export type CodePrefixKey = keyof typeof CODE_PREFIX;

/** meta 表里计数器的 key 前缀 */
const COUNTER_KEY_PREFIX = 'counter:';

export function counterKey(kind: CodePrefixKey): string {
  return COUNTER_KEY_PREFIX + kind;
}

/** 生成下一个业务编号 */
export function formatCode(kind: CodePrefixKey, seq: number): string {
  return `${CODE_PREFIX[kind]}-${String(seq).padStart(4, '0')}`;
}

/** 从已有编号里解析出顺序号（非本前缀 / 无法解析返回 null） */
export function parseCodeSeq(kind: CodePrefixKey, code: string | null | undefined): number | null {
  if (typeof code !== 'string') return null;
  const match = new RegExp(`^${CODE_PREFIX[kind]}-(\\d{4,})$`).exec(code);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * 旧数据迁移编号：旧库没有业务编号，只有 uuid。
 * 用 LEGACY 段编号，避免和新顺序号撞号；它同样是稳定业务键，之后即正常合并。
 */
const LEGACY_PREFIX = 'LEGACY';

export function legacyCode(kind: CodePrefixKey, seq: number): string {
  return `${CODE_PREFIX[kind]}-${LEGACY_PREFIX}-${String(seq).padStart(3, '0')}`;
}

export function isLegacyCode(code: string): boolean {
  return code.includes(`-${LEGACY_PREFIX}-`);
}
