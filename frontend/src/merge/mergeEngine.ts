/**
 * 离线排演包合并引擎（纯函数，不碰数据库）
 * 三向合并：本机当前（local）× 分队排演包（base 底稿 + remote 改动）。
 * 认关系一律走业务编号（剧目 / 场次 / 影人角色 / 操耍人），本机 uuid 不同不硬套；
 * 同一字段两边都改 → 并列保留为冲突，人工选定后再一起写入；
 * 场次 / 操耍人被一边撤掉 → 提交时把角色指派、锣鼓点处理干净（级联删 / 解绑）。
 */
import type { Play, PlayGenre, PlayStatus } from '../types/play';
import type { Scene, ShadowScreenSpec } from '../types/scene';
import type { ShadowRole, RoleType, PropPart } from '../types/role';
import type { Operator, SkillTag, Weekday, BusySlot } from '../types/operator';
import type { PercussionCue, BeatName, Instrument } from '../types/cue';
import type {
  ArrayConflict,
  ArrayPolicy,
  Conflict,
  DeleteModifyConflict,
  DeletePolicy,
  FieldConflict,
  FieldSide,
  MergeEntry,
  MergeEntityKind,
  MergeWarning,
} from '../types/rehearsalPackage';
import type { RehearsalPackageView } from './packageIO';
import {
  PLAY_GENRE_LABEL,
  PLAY_STATUS_LABEL,
} from '../types/play';
import { MATURITY_LABEL, SHADOW_SCREEN_LABEL, maturityOf } from '../types/scene';
import { PROP_PART_LABEL, ROLE_TYPE_LABEL } from '../types/role';
import { SKILL_TAG_LABEL, WEEKDAY_LABEL, minuteToClock } from '../types/operator';
import { BEAT_NAME_LABEL, INSTRUMENT_LABEL } from '../types/cue';

/* ------------------------------- 行数据（含可选编号，容忍旧数据） ------------------------------- */

export type GenericEntity = Record<string, unknown>;

/** 强类型行 → 通用实体（字段级合并在 GenericEntity 上做） */
function asEntity(row: unknown): GenericEntity {
  return row as GenericEntity;
}

/** 可空行 → 可空通用实体 */
function asNullableEntity(row: unknown): GenericEntity | null {
  return row === null || row === undefined ? null : (row as GenericEntity);
}

interface FieldMeta {
  field: string;
  label: string;
  format: (value: unknown) => string;
}

function text(value: unknown): string {
  if (value === null || value === undefined || value === '') return '（空）';
  return String(value);
}

function num(unit: string): (value: unknown) => string {
  return (value) => `${Number(value ?? 0)}${unit}`;
}

function enumLabel<T extends string>(map: Record<T, string>): (value: unknown) => string {
  return (value) => map[value as T] ?? text(value);
}

function progressText(value: unknown): string {
  const n = Number(value ?? 0);
  return `${n}%（${MATURITY_LABEL[maturityOf(n)]}）`;
}

/** 参与字段级合并的标量字段（id / bizCode / 外键 / 时间戳 / 修订号不走字段合并） */
export const FIELD_META: Record<MergeEntityKind, FieldMeta[]> = {
  play: [
    { field: 'title', label: '剧目名', format: text },
    { field: 'genre', label: '剧种', format: enumLabel<PlayGenre>(PLAY_GENRE_LABEL) },
    { field: 'scriptText', label: '剧情提要', format: text },
    { field: 'totalScenes', label: '场次总数', format: num(' 场') },
    { field: 'premiereVenue', label: '首演戏台', format: text },
    { field: 'status', label: '筹备状态', format: enumLabel<PlayStatus>(PLAY_STATUS_LABEL) },
  ],
  scene: [
    { field: 'seq', label: '场序', format: num('') },
    { field: 'title', label: '场次标题', format: text },
    { field: 'durationMin', label: '时长', format: num(' 分钟') },
    { field: 'stageNote', label: '舞台提示', format: text },
    { field: 'needsShadowScreen', label: '影窗规格', format: enumLabel<ShadowScreenSpec>(SHADOW_SCREEN_LABEL) },
    { field: 'progress', label: '排练进度', format: progressText },
  ],
  role: [
    { field: 'name', label: '角色名', format: text },
    { field: 'roleType', label: '行当', format: enumLabel<RoleType>(ROLE_TYPE_LABEL) },
    { field: 'entranceCue', label: '出场提示', format: text },
    { field: 'lineNote', label: '唱白要点', format: text },
    { field: 'operatorId', label: '操耍人', format: (value) => (value === null || value === undefined || value === '' ? '待指派' : '编号 ' + String(value)) },
  ],
  cue: [
    { field: 'beatName', label: '锣鼓点名', format: enumLabel<BeatName>(BEAT_NAME_LABEL) },
    { field: 'instrument', label: '主奏乐器', format: enumLabel<Instrument>(INSTRUMENT_LABEL) },
    { field: 'atSecond', label: '出场秒点', format: (value) => `${Number(value ?? 0)} 秒` },
    { field: 'leadOperator', label: '领奏操耍人', format: (value) => (value === null || value === undefined || value === '' ? '待指派' : '编号 ' + String(value)) },
    { field: 'note', label: '备注', format: text },
  ],
  operator: [
    { field: 'name', label: '姓名', format: text },
    { field: 'rehearsalHours', label: '累计排练时长', format: num(' 小时') },
  ],
};

/** 数组型字段（两边都增删时并列保留为数组冲突） */
export const ARRAY_FIELD_META: Partial<Record<MergeEntityKind, ArrayFieldMeta[]>> = {
  role: [
    {
      field: 'propParts',
      label: '需备影件',
      keyOf: (item) => String(item),
      labelOf: (item) => PROP_PART_LABEL[item as PropPart] ?? String(item),
    },
  ],
  operator: [
    {
      field: 'skillTags',
      label: '技能标签',
      keyOf: (item) => String(item),
      labelOf: (item) => SKILL_TAG_LABEL[item as SkillTag] ?? String(item),
    },
    {
      field: 'busySlots',
      label: '冲突时段',
      keyOf: (item) => String((item as BusySlot).bizCode ?? ''),
      labelOf: (item) => {
        const slot = item as BusySlot;
        return `${WEEKDAY_LABEL[slot.weekday as Weekday] ?? ''} ${minuteToClock(slot.startMinute)}-${minuteToClock(
          slot.startMinute + slot.durationMinute,
        )} ${slot.label}`.trim();
      },
    },
  ],
};

/* ------------------------------- 三向标量合并 ------------------------------- */

export interface ScalarMergeResult {
  value: unknown;
  /** 相对 base 是否变化（用于无冲突差异摘要） */
  changedFromBase: boolean;
  conflict: FieldConflict | null;
}

export function mergeScalarField(
  meta: FieldMeta,
  baseValue: unknown,
  localValue: unknown,
  remoteValue: unknown,
): ScalarMergeResult {
  const localChanged = JSON.stringify(localValue) !== JSON.stringify(baseValue);
  const remoteChanged = JSON.stringify(remoteValue) !== JSON.stringify(baseValue);
  if (localChanged && remoteChanged && JSON.stringify(localValue) !== JSON.stringify(remoteValue)) {
    return {
      value: undefined,
      changedFromBase: true,
      conflict: {
        conflictKind: 'field',
        field: meta.field,
        fieldLabel: meta.label,
        baseValue,
        localValue,
        remoteValue,
        resolution: null,
      },
    };
  }
  // 都没改 / 只一边改 / 两边改成相同值
  const value = remoteChanged ? remoteValue : localValue;
  return { value, changedFromBase: localChanged || remoteChanged, conflict: null };
}

/* ------------------------------- 三向数组合并 ------------------------------- */

export interface ArrayMergeResult {
  /** 无冲突时的结果；有冲突且未选 union 时按 resolution 取用 */
  value: unknown[];
  changedFromBase: boolean;
  conflict: ArrayConflict | null;
}

interface ItemView {
  code: string;
  label: string;
  raw: unknown;
}

export interface ArrayFieldMeta {
  field: string;
  label: string;
  /** 取元素的业务键 */
  keyOf: (item: unknown) => string;
  /** 取元素的展示文案 */
  labelOf: (item: unknown) => string;
}

export function toItems(value: unknown, meta: ArrayFieldMeta): ItemView[] {
  if (!Array.isArray(value)) return [];
  return value.map((raw) => ({ code: meta.keyOf(raw), label: meta.labelOf(raw), raw }));
}

export function mergeArrayField(
  meta: ArrayFieldMeta,
  baseValue: unknown,
  localValue: unknown,
  remoteValue: unknown,
): ArrayMergeResult {
  const base = toItems(baseValue, meta);
  const local = toItems(localValue, meta);
  const remote = toItems(remoteValue, meta);

  const baseCodes = new Set(base.map((item) => item.code));
  const localCodes = new Set(local.map((item) => item.code));
  const remoteCodes = new Set(remote.map((item) => item.code));

  const localAdded = local.filter((item) => !baseCodes.has(item.code)).map(({ code, label }) => ({ code, label }));
  const localRemoved = base.filter((item) => !localCodes.has(item.code)).map(({ code, label }) => ({ code, label }));
  const remoteAdded = remote.filter((item) => !baseCodes.has(item.code)).map(({ code, label }) => ({ code, label }));
  const remoteRemoved = base.filter((item) => !remoteCodes.has(item.code)).map(({ code, label }) => ({ code, label }));

  const bothTouched =
    localAdded.length + localRemoved.length > 0 && remoteAdded.length + remoteRemoved.length > 0;

  // 无冲突：以 remote 为基准叠加双方新增（并集），仅被一方删除的保留删除结果
  if (!bothTouched) {
    const merged = unionItems(local, remote);
    const removedByLocal = new Set(localRemoved.map((item) => item.code));
    const removedByRemote = new Set(remoteRemoved.map((item) => item.code));
    const filtered = merged.filter((item) => !removedByLocal.has(item.code) && !removedByRemote.has(item.code));
    return {
      value: filtered.map((item) => item.raw),
      changedFromBase: JSON.stringify(base.map((i) => i.code).sort()) !== JSON.stringify(filtered.map((i) => i.code).sort()),
      conflict: null,
    };
  }

  return {
    value: unionItems(local, remote).map((item) => item.raw),
    changedFromBase: true,
    conflict: {
      conflictKind: 'array',
      field: meta.field,
      fieldLabel: meta.label,
      baseItems: base.map(({ code, label }) => ({ code, label })),
      localAdded,
      localRemoved,
      remoteAdded,
      remoteRemoved,
      resolution: null,
    },
  };
}

function unionItems(a: ItemView[], b: ItemView[]): ItemView[] {
  const seen = new Set<string>();
  const out: ItemView[] = [];
  [...a, ...b].forEach((item) => {
    if (seen.has(item.code)) return;
    seen.add(item.code);
    out.push(item);
  });
  return out;
}

/* ------------------------------- 删除/修改冲突 ------------------------------- */

export function deleteModifyConflict(deletedBy: 'local' | 'remote', modifiedSummary: string): DeleteModifyConflict {
  return {
    conflictKind: 'deleteModify',
    deletedBy,
    modifiedSummary,
    resolution: null,
  };
}

/* ------------------------------- 合并计划 ------------------------------- */

/** 实体的三向快照（任一侧可能缺失：base/remote/local） */
export interface EntityTriple {
  kind: MergeEntityKind;
  bizCode: string;
  base: GenericEntity | null;
  local: GenericEntity | null;
  remote: GenericEntity | null;
}

export interface EntityPlan extends EntityTriple {
  label: string;
  status: MergeEntry['status'];
  diffs: string[];
  conflicts: Conflict[];
  /** 字段级合并后的草稿（冲突字段为 undefined，待选定回填） */
  merged: GenericEntity | null;
}

export interface MergePlan {
  playBizCode: string;
  entries: EntityPlan[];
  warnings: MergeWarning[];
  /** 远端引用到、但两侧操耍人档都没有的业务编号（提交时解绑并预警） */
  danglingOperatorCodes: string[];
}

function labelOf(kind: MergeEntityKind, row: GenericEntity | null, fallback: string): string {
  if (!row) return fallback;
  if (kind === 'play') return String(row.title ?? fallback);
  if (kind === 'scene') return String(row.title ?? fallback);
  if (kind === 'role') return String(row.name ?? fallback);
  if (kind === 'cue') {
    const beat = BEAT_NAME_LABEL[row.beatName as BeatName] ?? String(row.beatName ?? '');
    return `${beat}@${Number(row.atSecond ?? 0)}秒`;
  }
  return String(row.name ?? fallback);
}

/** 合并单个实体的全部标量与数组字段，返回 merged 草稿 / 差异摘要 / 冲突 */
function mergeEntityFields(
  kind: MergeEntityKind,
  base: GenericEntity | null,
  local: GenericEntity | null,
  remote: GenericEntity | null,
): { merged: GenericEntity; diffs: string[]; conflicts: Conflict[] } {
  // 以「存在的底稿」为基底；旧数据无底稿时按当前记录迁移补齐（取 local）
  const baseRow = base ?? local ?? remote ?? {};
  const localRow = local ?? baseRow;
  const remoteRow = remote ?? baseRow;

  const merged: GenericEntity = {};
  const diffs: string[] = [];
  const conflicts: Conflict[] = [];

  FIELD_META[kind].forEach((meta) => {
    const result = mergeScalarField(meta, baseRow[meta.field], localRow[meta.field], remoteRow[meta.field]);
    if (result.conflict) {
      conflicts.push(result.conflict);
      return;
    }
    if (result.changedFromBase && JSON.stringify(result.value) !== JSON.stringify(baseRow[meta.field])) {
      diffs.push(`${meta.label}：${meta.format(baseRow[meta.field])} → ${meta.format(result.value)}`);
    }
    merged[meta.field] = result.value;
  });

  (ARRAY_FIELD_META[kind] ?? []).forEach((meta) => {
    const result = mergeArrayField(meta, baseRow[meta.field], localRow[meta.field], remoteRow[meta.field]);
    if (result.conflict) {
      conflicts.push(result.conflict);
      return;
    }
    if (result.changedFromBase) {
      const before = toItems(baseRow[meta.field], meta);
      const after = toItems(result.value, meta);
      const beforeSet = new Set(before.map((item) => item.code));
      const afterSet = new Set(after.map((item) => item.code));
      const added = after.filter((item) => !beforeSet.has(item.code));
      const removed = before.filter((item) => !afterSet.has(item.code));
      const parts: string[] = [];
      if (added.length > 0) parts.push(`+ ${added.map((item) => item.label).join('、')}`);
      if (removed.length > 0) parts.push(`− ${removed.map((item) => item.label).join('、')}`);
      diffs.push(`${meta.label}：${parts.join('；')}`);
    }
    merged[meta.field] = result.value;
  });

  return { merged, diffs, conflicts };
}

/**
 * 构建合并计划（纯计算，可重复执行；失败重试同一包结果一致）。
 * @param local 本机当前全量（按剧目范围取好：play/scenes/roles/cues + 全部 operators）
 * @param pkg   分队排演包
 */
export function buildMergePlan(
  local: {
    play: Play | null;
    scenes: Scene[];
    roles: ShadowRole[];
    cues: PercussionCue[];
    operators: Operator[];
  },
  pkg: RehearsalPackageView,
): MergePlan {
  const warnings: MergeWarning[] = [];
  const danglingOperatorCodes = new Set<string>();

  // 旧数据缺底稿：按当前记录迁移补齐（用本机当前记录当 base），再合并
  const baseline: RehearsalPackageView['current'] = pkg.baseline ?? {
    play: local.play ?? pkg.current.play,
    scenes: local.scenes,
    roles: local.roles,
    cues: local.cues,
    operators: local.operators,
  };
  if (!pkg.baseline) {
    warnings.push({
      level: 'warning',
      message: '该排演包缺少上次交接底稿，已按本机当前记录迁移补齐后再合并，冲突识别可能不全。',
    });
  }

  // 包目标剧目与本机剧目需对得上业务编号
  const remotePlay = pkg.current.play;
  if (remotePlay.bizCode !== pkg.playBizCode) {
    warnings.push({
      level: 'error',
      message: `排演包标注的剧目编号 ${pkg.playBizCode} 与包内剧目编号 ${remotePlay.bizCode} 不一致，无法合并。`,
    });
  }

  const indexByCode = <T extends { bizCode: string }>(rows: T[]): Map<string, T> => {
    const map = new Map<string, T>();
    rows.forEach((row) => map.set(row.bizCode, row));
    return map;
  };

  const localPlay = local.play;
  const basePlay = baseline.play;
  const entries: EntityPlan[] = [];

  /* ------------------------------- 操耍人 ------------------------------- */
  const localOperators = indexByCode(local.operators);
  const baseOperators = indexByCode(baseline.operators);
  const remoteOperators = indexByCode(pkg.current.operators);
  const operatorCodes = new Set<string>([
    ...localOperators.keys(),
    ...baseOperators.keys(),
    ...remoteOperators.keys(),
  ]);

  operatorCodes.forEach((code) => {
    const base = asNullableEntity(baseOperators.get(code));
    const loc = asNullableEntity(localOperators.get(code));
    const rem = asNullableEntity(remoteOperators.get(code));
    const triple = { kind: 'operator' as const, bizCode: code, base, local: loc, remote: rem };
    if (loc && !rem) {
      if (!base) {
        // 底稿里没有：是打包后本机才新增的，分队并不知情，保留本机
        entries.push({ ...triple, label: labelOf('operator', loc, code), status: 'localOnly', diffs: [], conflicts: [], merged: loc });
        return;
      }
      if (entityModifiedFrom('operator', base, loc)) {
        // 分队撤掉、本机改过 → 删除/修改冲突
        const { diffs } = mergeEntityFields('operator', base, loc, base);
        entries.push({
          ...triple,
          label: labelOf('operator', loc, code),
          status: 'conflict',
          diffs,
          conflicts: [deleteModifyConflict('remote', diffs.join('；') || '本机有改动')],
          merged: loc,
        });
      } else {
        // 分队撤掉、本机没动 → 直接删除，提交时解绑相关角色指派与领奏
        entries.push({
          ...triple,
          label: labelOf('operator', loc, code),
          status: 'deleted',
          diffs: ['分队撤掉该操耍人，名下角色指派与领奏解绑'],
          conflicts: [],
          merged: null,
        });
      }
      return;
    }
    if (!loc && rem) {
      entries.push({
        ...triple,
        label: labelOf('operator', rem, code),
        status: 'remoteOnly',
        diffs: ['分队新增操耍人'],
        conflicts: [],
        merged: rem,
      });
      return;
    }
    if (loc && rem) {
      const { merged, diffs, conflicts } = mergeEntityFields('operator', base, loc, rem);
      entries.push({
        ...triple,
        label: labelOf('operator', loc, code),
        status: conflicts.length > 0 ? 'conflict' : diffs.length > 0 ? 'modified' : 'unchanged',
        diffs,
        conflicts,
        merged,
      });
    }
  });

  /* ------------------------------- 剧目 ------------------------------- */
  const playTriple: EntityTriple = {
    kind: 'play',
    bizCode: remotePlay.bizCode,
    base: asNullableEntity(basePlay),
    local: asNullableEntity(localPlay),
    remote: asEntity(remotePlay),
  };
  if (localPlay) {
    const { merged, diffs, conflicts } = mergeEntityFields('play', playTriple.base, playTriple.local, playTriple.remote);
    entries.push({
      ...playTriple,
      label: labelOf('play', playTriple.local, remotePlay.title),
      status: conflicts.length > 0 ? 'conflict' : diffs.length > 0 ? 'modified' : 'unchanged',
      diffs,
      conflicts,
      merged,
    });
  } else {
    entries.push({
      ...playTriple,
      label: labelOf('play', playTriple.remote, remotePlay.title),
      status: 'remoteOnly',
      diffs: ['本机无此剧目，随包并入'],
      conflicts: [],
      merged: playTriple.remote,
    });
  }

  /* 编号 → 是否在合并后存在（用于外键悬挂检查） */
  const operatorExistsAfter = new Set(operatorCodes);

  /* ------------------------------- 场次 / 角色 / 锣鼓点 ------------------------------- */
  const localScenes = indexByCode(local.scenes);
  const baseScenes = indexByCode(baseline.scenes);
  const remoteScenes = indexByCode(pkg.current.scenes);
  const sceneCodes = new Set<string>([...localScenes.keys(), ...baseScenes.keys(), ...remoteScenes.keys()]);

  const localRoles = indexByCode(local.roles);
  const baseRoles = indexByCode(baseline.roles);
  const remoteRoles = indexByCode(pkg.current.roles);

  const localCues = indexByCode(local.cues);
  const baseCues = indexByCode(baseline.cues);
  const remoteCues = indexByCode(pkg.current.cues);

  // 场次 uuid → 业务编号（本机 / 底稿 / 分队三套映射合并）
  const sceneIdToCode = new Map<string, string>();
  [local.scenes, baseline.scenes, pkg.current.scenes].forEach((rows) => {
    rows.forEach((scene) => {
      if (scene.id) sceneIdToCode.set(scene.id, scene.bizCode);
    });
  });

  // 操耍人外键统一规范化为业务编号：两台机器 uuid 不同但编号相同即认作同一人，避免误报冲突
  const operatorIdToCode = new Map<string, string>();
  [local.operators, baseline.operators, pkg.current.operators].forEach((rows) => {
    rows.forEach((operator) => {
      if (operator.id) operatorIdToCode.set(operator.id, operator.bizCode);
    });
  });
  const normalizeRoleRow = (row: GenericEntity | null): GenericEntity | null => {
    if (!row) return null;
    const code =
      (row.operatorBizCode as string | undefined) ??
      (typeof row.operatorId === 'string' ? (operatorIdToCode.get(row.operatorId) ?? null) : null);
    const sceneCode =
      (row.sceneBizCode as string | undefined) ??
      (typeof row.sceneId === 'string' ? (sceneIdToCode.get(row.sceneId) ?? inferParentCode(String(row.bizCode ?? ''), 'R')) : '');
    return { ...row, sceneBizCode: sceneCode, operatorId: code ?? null };
  };
  const normalizeCueRow = (row: GenericEntity | null): GenericEntity | null => {
    if (!row) return null;
    const code =
      (row.leadOperatorBizCode as string | undefined) ??
      (typeof row.leadOperator === 'string' ? (operatorIdToCode.get(row.leadOperator) ?? null) : null);
    const sceneCode =
      (row.sceneBizCode as string | undefined) ??
      (typeof row.sceneId === 'string' ? (sceneIdToCode.get(row.sceneId) ?? inferParentCode(String(row.bizCode ?? ''), 'C')) : '');
    return { ...row, sceneBizCode: sceneCode, leadOperator: code ?? null };
  };

  // 场序排序：冲突选择前先按声明顺序稳定排列，便于页面展示
  const orderedSceneCodes = [...sceneCodes].sort((a, b) => {
    const sa = localScenes.get(a) ?? baseScenes.get(a) ?? remoteScenes.get(a);
    const sb = localScenes.get(b) ?? baseScenes.get(b) ?? remoteScenes.get(b);
    return Number(sa?.seq ?? 999) - Number(sb?.seq ?? 999) || a.localeCompare(b);
  });

  orderedSceneCodes.forEach((code) => {
    const base = asNullableEntity(baseScenes.get(code));
    const loc = asNullableEntity(localScenes.get(code));
    const rem = asNullableEntity(remoteScenes.get(code));
    const triple = { kind: 'scene' as const, bizCode: code, base, local: loc, remote: rem };

    if (loc && !rem) {
      if (!base) {
        // 底稿里没有：打包后本机才新增的场次，分队不知情，保留本机
        entries.push({ ...triple, label: labelOf('scene', loc, code), status: 'localOnly', diffs: [], conflicts: [], merged: loc });
        return;
      }
      // 分队撤掉场次：本机若改过 → 删/留冲突；否则直接随包删除（级联清角色与锣鼓点）
      if (entityModifiedFrom('scene', base, loc)) {
        const { diffs } = mergeEntityFields('scene', base, loc, base);
        entries.push({
          ...triple,
          label: labelOf('scene', loc, code),
          status: 'conflict',
          diffs,
          conflicts: [deleteModifyConflict('remote', diffs.join('；') || '本机有改动')],
          merged: loc,
        });
      } else {
        entries.push({
          ...triple,
          label: labelOf('scene', loc ?? base, code),
          status: 'deleted',
          diffs: ['分队撤掉本场，角色指派与锣鼓点一并清掉'],
          conflicts: [],
          merged: null,
        });
      }
      return;
    }
    if (!loc && rem) {
      if (base) {
        // 本机删了、分队改了
        const { diffs } = mergeEntityFields('scene', base, base, rem);
        entries.push({
          ...triple,
          label: labelOf('scene', rem, code),
          status: 'conflict',
          diffs,
          conflicts: [deleteModifyConflict('local', diffs.join('；') || '分队有改动')],
          merged: rem,
        });
      } else {
        entries.push({
          ...triple,
          label: labelOf('scene', rem, code),
          status: 'remoteOnly',
          diffs: ['分队新增场次'],
          conflicts: [],
          merged: rem,
        });
      }
      return;
    }
    if (loc && rem) {
      const { merged, diffs, conflicts } = mergeEntityFields('scene', base, loc, rem);
      entries.push({
        ...triple,
        label: labelOf('scene', loc, code),
        status: conflicts.length > 0 ? 'conflict' : diffs.length > 0 ? 'modified' : 'unchanged',
        diffs,
        conflicts,
        merged,
      });
    }
  });

  // 场次的最终存续（未被删除），角色/锣鼓点只在存续场次里合并
  const deletedSceneCodes = new Set<string>();
  entries.forEach((entry) => {
    if (entry.kind !== 'scene') return;
    if (isSceneDeleted(entry)) deletedSceneCodes.add(entry.bizCode);
  });

  /* ----- 角色 ----- */
  const roleCodes = new Set<string>([...localRoles.keys(), ...baseRoles.keys(), ...remoteRoles.keys()]);
  roleCodes.forEach((code) => {
    const base = normalizeRoleRow(asNullableEntity(baseRoles.get(code)));
    const loc = normalizeRoleRow(asNullableEntity(localRoles.get(code)));
    const rem = normalizeRoleRow(asNullableEntity(remoteRoles.get(code)));
    const sceneCode = String((loc ?? rem ?? base)?.sceneBizCode ?? inferParentCode(code, 'R'));
    if (deletedSceneCodes.has(sceneCode)) {
      // 场次撤掉：角色随之清掉，不单独并入
      if (loc) {
        entries.push({
          kind: 'role',
          bizCode: code,
          base,
          local: loc,
          remote: rem,
          label: labelOf('role', loc, code),
          status: 'deleted',
          diffs: [`所属场次 ${sceneCode} 已撤掉，角色随级联清掉`],
          conflicts: [],
          merged: null,
        });
      }
      return;
    }
    pushChildEntry({
      entries,
      kind: 'role',
      code,
      base,
      loc,
      rem,
      remoteOnlyDiff: '分队新增影人角色',
    });
  });

  /* ----- 锣鼓点 ----- */
  const cueCodes = new Set<string>([...localCues.keys(), ...baseCues.keys(), ...remoteCues.keys()]);
  cueCodes.forEach((code) => {
    const base = normalizeCueRow(asNullableEntity(baseCues.get(code)));
    const loc = normalizeCueRow(asNullableEntity(localCues.get(code)));
    const rem = normalizeCueRow(asNullableEntity(remoteCues.get(code)));
    const sceneCode = String((loc ?? rem ?? base)?.sceneBizCode ?? inferParentCode(code, 'C'));
    if (deletedSceneCodes.has(sceneCode)) {
      if (loc) {
        entries.push({
          kind: 'cue',
          bizCode: code,
          base,
          local: loc,
          remote: rem,
          label: labelOf('cue', loc, code),
          status: 'deleted',
          diffs: [`所属场次 ${sceneCode} 已撤掉，锣鼓点随级联清掉`],
          conflicts: [],
          merged: null,
        });
      }
      return;
    }
    pushChildEntry({
      entries,
      kind: 'cue',
      code,
      base,
      loc,
      rem,
      remoteOnlyDiff: '分队新增锣鼓点',
    });
  });

  // 悬挂操耍人检查：角色/锣鼓点引用了合并后操耍人档中不存在的业务编号
  entries.forEach((entry) => {
    if (entry.kind !== 'role' && entry.kind !== 'cue') return;
    const field = entry.kind === 'role' ? 'operatorId' : 'leadOperator';
    [entry.base, entry.local, entry.remote].forEach((row) => {
      const refCode = row?.[field];
      if (refCode && !operatorExistsAfter.has(String(refCode))) {
        danglingOperatorCodes.add(String(refCode));
      }
    });
  });
  if (danglingOperatorCodes.size > 0) {
    warnings.push({
      level: 'warning',
      message: `包内指派引用了操耍人档中不存在的编号 ${[...danglingOperatorCodes].join('、')}，提交时这些指派会解绑为待指派。`,
    });
  }

  // 排个稳定展示顺序：剧目 → 场次 → 角色 → 锣鼓点 → 操耍人
  const order: Record<MergeEntityKind, number> = { play: 0, scene: 1, role: 2, cue: 3, operator: 4 };
  entries.sort((a, b) => order[a.kind] - order[b.kind] || a.bizCode.localeCompare(b.bizCode));

  return { playBizCode: pkg.playBizCode, entries, warnings, danglingOperatorCodes: [...danglingOperatorCodes] };
}

/**
 * 场次是否最终撤掉：
 * - status=deleted（一方撤、另一方没动）→ 删
 * - 删除/修改冲突：选 delete → 删；选 keep / 未选 → 留（未选时阻断提交，这里先按留处理级联）
 * - 其余情况保留
 */
export function isSceneDeleted(entry: EntityPlan): boolean {
  if (entry.status === 'deleted') return true;
  const delConflict = entry.conflicts.find((c): c is DeleteModifyConflict => c.conflictKind === 'deleteModify');
  if (delConflict) return delConflict.resolution === 'delete';
  return false;
}

interface PushChildArgs {
  entries: EntityPlan[];
  kind: 'role' | 'cue';
  code: string;
  base: GenericEntity | null;
  loc: GenericEntity | null;
  rem: GenericEntity | null;
  remoteOnlyDiff: string;
}

function pushChildEntry(args: PushChildArgs): void {
  const { entries, kind, code, base, loc, rem, remoteOnlyDiff } = args;
  const triple = { kind, bizCode: code, base, local: loc, remote: rem };
  if (loc && !rem) {
    if (!base) {
      // 打包后本机才新增的，分队不知情，保留本机
      entries.push({ ...triple, label: labelOf(kind, loc, code), status: 'localOnly', diffs: [], conflicts: [], merged: loc });
      return;
    }
    if (entityModifiedFrom(kind, base, loc)) {
      const { diffs } = mergeEntityFields(kind, base, loc, base);
      entries.push({
        ...triple,
        label: labelOf(kind, loc, code),
        status: 'conflict',
        diffs,
        conflicts: [deleteModifyConflict('remote', diffs.join('；') || '本机有改动')],
        merged: loc,
      });
    } else {
      // 分队撤掉、本机没动 → 直接删除该角色 / 锣鼓点
      entries.push({
        ...triple,
        label: labelOf(kind, loc, code),
        status: 'deleted',
        diffs: [kind === 'role' ? '分队撤掉该角色' : '分队撤掉该锣鼓点'],
        conflicts: [],
        merged: null,
      });
    }
    return;
  }
  if (!loc && rem) {
    if (base) {
      const { diffs } = mergeEntityFields(kind, base, base, rem);
      entries.push({
        ...triple,
        label: labelOf(kind, rem, code),
        status: 'conflict',
        diffs,
        conflicts: [deleteModifyConflict('local', diffs.join('；') || '分队有改动')],
        merged: rem,
      });
    } else {
      entries.push({
        ...triple,
        label: labelOf(kind, rem, code),
        status: 'remoteOnly',
        diffs: [remoteOnlyDiff],
        conflicts: [],
        merged: rem,
      });
    }
    return;
  }
  if (loc && rem) {
    const { merged, diffs, conflicts } = mergeEntityFields(kind, base, loc, rem);
    entries.push({
      ...triple,
      label: labelOf(kind, loc, code),
      status: conflicts.length > 0 ? 'conflict' : diffs.length > 0 ? 'modified' : 'unchanged',
      diffs,
      conflicts,
      merged,
    });
  }
}

/** 本机相对底稿是否改过（用于删除/修改冲突判定） */
function entityModifiedFrom(kind: MergeEntityKind, base: GenericEntity, row: GenericEntity): boolean {
  const scalarChanged = FIELD_META[kind].some(
    (meta) => JSON.stringify(base[meta.field]) !== JSON.stringify(row[meta.field]),
  );
  const arrayChanged = (ARRAY_FIELD_META[kind] ?? []).some((meta) => {
    const baseItems = toItems(base[meta.field], meta).map((item) => item.code).sort();
    const rowItems = toItems(row[meta.field], meta).map((item) => item.code).sort();
    return JSON.stringify(baseItems) !== JSON.stringify(rowItems);
  });
  return scalarChanged || arrayChanged;
}

/** 从子级业务编号反推场次编号（J-001-S03-R02 → J-001-S03） */
function inferParentCode(code: string, marker: 'R' | 'C'): string {
  const idx = code.indexOf(`-${marker}`);
  return idx > 0 ? code.slice(0, idx) : code;
}

/* ------------------------------- 冲突选择与可提交判定 ------------------------------- */

export function unresolvedConflictCount(plan: MergePlan): number {
  return plan.entries.reduce(
    (acc, entry) => acc + entry.conflicts.filter((conflict) => conflict.resolution === null).length,
    0,
  );
}

/** 应用会话里已保存的核对进度（重试同一包时恢复） */
export function applyResolutions(
  plan: MergePlan,
  resolutions: Record<string, FieldSide | ArrayPolicy | DeletePolicy>,
): MergePlan {
  plan.entries.forEach((entry, entryIndex) => {
    entry.conflicts.forEach((conflict, conflictIndex) => {
      const key = `${entry.kind}:${entry.bizCode}:${conflictIndex}`;
      const saved = resolutions[key];
      if (saved === undefined) return;
      if (conflict.conflictKind === 'field') conflict.resolution = saved as FieldSide;
      else if (conflict.conflictKind === 'array') conflict.resolution = saved as ArrayPolicy;
      else conflict.resolution = saved as DeletePolicy;
      void entryIndex;
    });
  });
  return plan;
}

/** 冲突在会话进度表里的 key（页面选择时用） */
export function conflictKey(entry: EntityPlan, conflictIndex: number): string {
  return `${entry.kind}:${entry.bizCode}:${conflictIndex}`;
}

/** 数组冲突按选定策略求最终值 */
export function resolveArrayValue(conflict: ArrayConflict, localItems: unknown[], remoteItems: unknown[]): unknown[] {
  if (conflict.resolution === 'local') return localItems;
  if (conflict.resolution === 'remote') return remoteItems;
  // union（默认并列保留：两边增的都留下，仅当一方删而另一方未动同一项时尊重删除）
  const localDeleted = new Set(conflict.localRemoved.map((item) => item.code));
  const remoteDeleted = new Set(conflict.remoteRemoved.map((item) => item.code));
  const merged = new Map<string, unknown>();
  [...localItems, ...remoteItems].forEach((raw) => {
    const code =
      conflict.field === 'busySlots'
        ? String((raw as BusySlot).bizCode ?? '')
        : String(raw);
    if (localDeleted.has(code) || remoteDeleted.has(code)) return;
    merged.set(code, raw);
  });
  return [...merged.values()];
}
