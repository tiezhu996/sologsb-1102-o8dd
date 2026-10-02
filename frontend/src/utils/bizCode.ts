/**
 * 业务编号（bizCode）工具
 * - 两台机器各自的 uuid 互不相认；跨分队离线排演包一律按业务编号认关系
 * - 编号规则：剧目 J-001；场次 J-001-S03；角色 J-001-S03-R02；锣鼓点 J-001-S03-C01；操耍人 M-001
 * - 新增时在同范围内取下一个连号；历史数据迁移时按既有顺序补齐
 */

export const BIZ_PREFIX = {
  play: 'J',
  scene: 'S',
  role: 'R',
  cue: 'C',
  operator: 'M',
} as const;

/** 业务编号合法字符：字母数字、连字符与下划线，2-40 位 */
const BIZ_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{1,39}$/;

export function isValidBizCode(code: string): boolean {
  return BIZ_CODE_PATTERN.test(code.trim());
}

function pad(value: number, length: number): string {
  return String(value).padStart(length, '0');
}

export function buildPlayCode(seq: number): string {
  return `${BIZ_PREFIX.play}-${pad(Math.max(1, seq), 3)}`;
}

export function buildOperatorCode(seq: number): string {
  return `${BIZ_PREFIX.operator}-${pad(Math.max(1, seq), 3)}`;
}

export function buildSceneCode(playCode: string, seq: number): string {
  return `${playCode}-${BIZ_PREFIX.scene}${pad(Math.max(1, seq), 2)}`;
}

export function buildRoleCode(sceneCode: string, seq: number): string {
  return `${sceneCode}-${BIZ_PREFIX.role}${pad(Math.max(1, seq), 2)}`;
}

export function buildCueCode(sceneCode: string, seq: number): string {
  return `${sceneCode}-${BIZ_PREFIX.cue}${pad(Math.max(1, seq), 2)}`;
}

/**
 * 取前缀下一个连号。
 * 从已有编号末尾抽取数字（如 J-001-S03 → 3），取最大值 +1。
 */
export function nextSequencedCode(used: string[], build: (seq: number) => string): string {
  let max = 0;
  used.forEach((code) => {
    const match = code.match(/(\d+)$/);
    if (match) max = Math.max(max, Number(match[1]));
  });
  return build(max + 1);
}

/* ------------------------- 跨机新增实体的稳定本机 id ------------------------- */

/**
 * 远端新增的实体不能沿用对方机器的 uuid，也不能每次合并都重新生成 id
 * （否则重试同一包会重复追加）。按「表名 + 业务编号」派生一个确定性 id，
 * 同一业务编号在本机永远映射到同一 id，合并天然幂等。
 */

function fnv1a32(text: string, seed: number): number {
  let hash = seed >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    // FNV 质数
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function toHex8(value: number): string {
  return value.toString(16).padStart(8, '0');
}

export function stableLocalId(kind: string, bizCode: string): string {
  const key = `${kind}:${bizCode}`;
  // 四个不同种子各取 32 位，拼成 128 位，按 uuid v4 形状输出
  const hex =
    toHex8(fnv1a32(key, 0x811c9dc5)) +
    toHex8(fnv1a32(key, 0x12345678)) +
    toHex8(fnv1a32(key, 0x9e3779b9)) +
    toHex8(fnv1a32(key, 0xdeadbeef));
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
