/**
 * 三方合并引擎（纯函数，不依赖 IndexedDB / DOM，可直接用 Node 跑单测）
 *
 * 认关系的锚点全部是业务编号（playCode / sceneCode / roleCode / operatorCode / cueCode / slotCode），
 * 本机 uuid 在进入引擎前已被剥掉，所以「本机编号不同」绝不会硬套错关系。
 *
 * 输入：base（上次交接底稿）/ local（班社本机当前）/ remote（分队包里这次的改动）。
 * 输出：MergePlan —— 字段冲突、实体去留冲突、级联清理提示、增改删清单。
 * 冲突一律并列保留（resolution = null），选定后才允许写入；选择只存 id → 'local' | 'remote'。
 */
import { BEAT_NAME_LABEL } from '../types/cue';
import type {
  PackageCue,
  PackageOperator,
  PackagePlay,
  PackageRole,
  PackageScene,
  PackageSlot,
  PackageSnapshot,
} from '../types/package';

/* ------------------------------- 数据集 ------------------------------- */

export interface MergeDataset {
  play: PackagePlay | null;
  scenes: Map<string, PackageScene>;
  roles: Map<string, PackageRole>;
  cues: Map<string, PackageCue>;
  operators: Map<string, PackageOperator>;
}

export function emptyDataset(): MergeDataset {
  return {
    play: null,
    scenes: new Map(),
    roles: new Map(),
    cues: new Map(),
    operators: new Map(),
  };
}

export function datasetFromSnapshot(snapshot: PackageSnapshot): MergeDataset {
  return {
    play: snapshot.play,
    scenes: new Map(snapshot.scenes.map((row) => [row.sceneCode, row])),
    roles: new Map(snapshot.roles.map((row) => [row.roleCode, row])),
    cues: new Map(snapshot.cues.map((row) => [row.cueCode, row])),
    operators: new Map(snapshot.operators.map((row) => [row.operatorCode, row])),
  };
}

/* ------------------------------- 冲突模型 ------------------------------- */

export type MergeEntityKind = 'play' | 'scene' | 'role' | 'cue' | 'operator' | 'slot';

/** 同一字段两边都改过：并列保留，待选定 */
export interface FieldConflict {
  /** 稳定 id：选定结果按它持久化，重试同一包时进度不丢 */
  id: string;
  entity: MergeEntityKind;
  /** slot 冲突时为 `${operatorCode}/${slotCode}`，其余为行业务编号 */
  code: string;
  field: string;
  /** 冲突所在行的展示名（如「第二场·结亲」） */
  entityLabel: string;
  fieldLabel: string;
  baseValue: unknown;
  localValue: unknown;
  remoteValue: unknown;
  /** null = 并列保留未选定；'local' / 'remote' = 采用哪一边 */
  resolution: 'local' | 'remote' | null;
}

/** 一边删了行、另一边改了行：去留也要人定 */
export interface EntityConflict {
  id: string;
  entity: Exclude<MergeEntityKind, 'play'>;
  code: string;
  entityLabel: string;
  kind: 'remote-delete-local-modified' | 'local-delete-remote-modified';
  /** null = 未选定；'keep' = 保留改动；'delete' = 听从撤掉的一方 */
  resolution: 'keep' | 'delete' | null;
}

export interface MergeWarning {
  id: string;
  level: 'info' | 'warning';
  message: string;
}

export type ChangeAction = 'add' | 'update' | 'delete' | 'unchanged';

export interface EntityChange<T> {
  code: string;
  action: ChangeAction;
  entityLabel: string;
  base: T | null;
  local: T | null;
  remote: T | null;
}

export interface SlotChange {
  operatorCode: string;
  slotCode: string;
  action: ChangeAction;
  base: PackageSlot | null;
  local: PackageSlot | null;
  remote: PackageSlot | null;
}

export interface MergePlan {
  packageCode: string;
  playCode: string;
  packageLabel: string;
  brigadeName: string;
  exportedAt: string;
  /** 底稿缺失、已按本机当前记录迁移补齐 */
  baselineMigrated: boolean;
  conflicts: FieldConflict[];
  entityConflicts: EntityConflict[];
  warnings: MergeWarning[];
  changes: {
    play: EntityChange<PackagePlay> | null;
    scenes: Array<EntityChange<PackageScene>>;
    roles: Array<EntityChange<PackageRole>>;
    cues: Array<EntityChange<PackageCue>>;
    operators: Array<EntityChange<PackageOperator>>;
    slots: SlotChange[];
  };
  generatedAt: string;
}

export type ResolutionMap = Record<string, 'local' | 'remote' | 'keep' | 'delete'>;

/* ------------------------------- 基础工具 ------------------------------- */

/** 深比较（数组按顺序比较：propParts / skillTags / busySlots 都视为有序） */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as Record<string, unknown>);
    const kb = Object.keys(b as Record<string, unknown>);
    if (ka.length !== kb.length) return false;
    return ka.every((key) => deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
  }
  return false;
}

interface FieldSpec<TRow> {
  field: keyof TRow & string;
  label: string;
}

const PLAY_FIELDS: Array<FieldSpec<PackagePlay>> = [
  { field: 'title', label: '剧目名' },
  { field: 'genre', label: '剧种' },
  { field: 'scriptText', label: '剧情提要' },
  { field: 'premiereVenue', label: '首演戏台' },
  { field: 'status', label: '状态' },
];

const SCENE_FIELDS: Array<FieldSpec<PackageScene>> = [
  { field: 'seq', label: '场序' },
  { field: 'title', label: '场次标题' },
  { field: 'durationMin', label: '时长（分钟）' },
  { field: 'stageNote', label: '舞台提示' },
  { field: 'needsShadowScreen', label: '影窗规格' },
  { field: 'progress', label: '排练进度（%）' },
];

const ROLE_FIELDS: Array<FieldSpec<PackageRole>> = [
  { field: 'name', label: '角色名' },
  { field: 'roleType', label: '行当' },
  { field: 'propParts', label: '需备影件' },
  { field: 'entranceCue', label: '出场提示' },
  { field: 'lineNote', label: '唱白要点' },
  { field: 'operatorCode', label: '操耍人指派' },
];

const CUE_FIELDS: Array<FieldSpec<PackageCue>> = [
  { field: 'beatName', label: '锣鼓点' },
  { field: 'instrument', label: '主奏乐器' },
  { field: 'atSecond', label: '出场秒点' },
  { field: 'leadOperatorCode', label: '领奏操耍人' },
  { field: 'note', label: '备注' },
];

const OPERATOR_FIELDS: Array<FieldSpec<PackageOperator>> = [
  { field: 'name', label: '姓名' },
  { field: 'skillTags', label: '技能标签' },
  { field: 'rehearsalHours', label: '累计排练时长（小时）' },
];

const SLOT_FIELDS: Array<FieldSpec<PackageSlot>> = [
  { field: 'weekday', label: '星期' },
  { field: 'startMinute', label: '开始时间' },
  { field: 'durationMinute', label: '持续分钟' },
  { field: 'label', label: '时段备注' },
];

/* ------------------------------- 展示名 ------------------------------- */

function sceneLabel(row: PackageScene | null): string {
  if (!row) return '（已撤场次）';
  return `第${row.seq}场 ${row.title}`;
}

function roleLabel(row: PackageRole | null): string {
  return row ? row.name : '（已撤角色）';
}

function cueLabel(row: PackageCue | null): string {
  if (!row) return '（已撤锣鼓点）';
  return `${BEAT_NAME_LABEL[row.beatName]} @${row.atSecond}s`;
}

function operatorLabel(row: PackageOperator | null): string {
  return row ? row.name : '（已撤操耍人）';
}

function slotLabel(row: PackageSlot | null): string {
  return row ? row.label || '排练时段' : '（已撤时段）';
}

/* --------------------------- 行级三方字段合并 --------------------------- */

function mergeFields<TRow extends object>(args: {
  entity: MergeEntityKind;
  code: string;
  entityLabel: string;
  fields: Array<FieldSpec<TRow>>;
  base: TRow | null;
  local: TRow | null;
  remote: TRow | null;
}): { conflicts: FieldConflict[]; changed: boolean } {
  const { entity, code, entityLabel, fields, base, local, remote } = args;
  const conflicts: FieldConflict[] = [];
  let changed = false;
  fields.forEach((spec) => {
    const b = base ? base[spec.field] : undefined;
    const l = local ? local[spec.field] : undefined;
    const r = remote ? remote[spec.field] : undefined;
    const localChanged = !deepEqual(b, l);
    const remoteChanged = !deepEqual(b, r);
    if (localChanged || remoteChanged) changed = true;
    // 两边都改、且改后不一致 → 并列保留
    if (localChanged && remoteChanged && !deepEqual(l, r)) {
      conflicts.push({
        id: `field:${entity}:${code}:${spec.field}`,
        entity,
        code,
        field: spec.field,
        entityLabel,
        fieldLabel: spec.label,
        baseValue: b ?? null,
        localValue: l ?? null,
        remoteValue: r ?? null,
        resolution: null,
      });
    }
  });
  return { conflicts, changed };
}

/* --------------------------- 集合级三方合并 --------------------------- */

interface CollectionMergeResult<T> {
  changes: Array<EntityChange<T>>;
  conflicts: FieldConflict[];
  entityConflicts: EntityConflict[];
  labelOf: (row: T | null) => string;
}

function mergeCollection<T extends object>(args: {
  entity: Exclude<MergeEntityKind, 'play' | 'slot'>;
  labelOf: (row: T | null) => string;
  fields: Array<FieldSpec<T>>;
  base: Map<string, T>;
  local: Map<string, T>;
  remote: Map<string, T>;
  conflicts: FieldConflict[];
  entityConflicts: EntityConflict[];
  /** 迁移基线下为 true：无法证实删除，不产生 delete / 去留冲突 */
  suppressDeletes?: boolean;
}): CollectionMergeResult<T> {
  const { entity, labelOf, fields, base, local, remote, conflicts, entityConflicts, suppressDeletes = false } = args;
  const changes: Array<EntityChange<T>> = [];
  const codes = new Set<string>([...base.keys(), ...local.keys(), ...remote.keys()]);
  codes.forEach((code) => {
    const b = base.get(code) ?? null;
    const l = local.get(code) ?? null;
    const r = remote.get(code) ?? null;
    const labelRow = (l ?? r ?? b) as T | null;
    const entityLabel = labelOf(labelRow);
    const inBase = b !== null;
    const inLocal = l !== null;
    const inRemote = r !== null;

    let action: ChangeAction;
    if (inBase) {
      if (inLocal && inRemote) action = 'unchanged';
      else if (inLocal) action = suppressDeletes ? 'unchanged' : 'delete'; // 分队撤了（迁移基线无法证实）
      else if (inRemote) action = suppressDeletes ? 'unchanged' : 'delete'; // 本机撤了（可能升级为去留冲突）
      else action = suppressDeletes ? 'unchanged' : 'delete'; // 两边都撤了
    } else {
      if (inLocal && inRemote) action = 'add';
      else if (inRemote) action = 'add'; // 分队新增
      else if (inLocal) action = 'unchanged'; // 本机自有的，包没碰
      else action = 'unchanged';
    }

    // 去留冲突：一边撤掉、另一边改过（迁移基线下无法证实撤掉，不产生）
    if (!suppressDeletes && inBase && inLocal && !inRemote && !deepEqual(b, l)) {
      entityConflicts.push({
        id: `entity:${entity}:${code}`,
        entity,
        code,
        entityLabel,
        kind: 'remote-delete-local-modified',
        resolution: null,
      });
    }
    if (!suppressDeletes && inBase && !inLocal && inRemote && !deepEqual(b, r)) {
      entityConflicts.push({
        id: `entity:${entity}:${code}`,
        entity,
        code,
        entityLabel,
        kind: 'local-delete-remote-modified',
        resolution: null,
      });
    }

    // 两边都在（或底稿缺失但两边各自新增了同号行）：逐字段比对
    if (inLocal && inRemote) {
      const { conflicts: rowConflicts, changed } = mergeFields({
        entity,
        code,
        entityLabel,
        fields,
        base: b,
        local: l,
        remote: r,
      });
      conflicts.push(...rowConflicts);
      if (!inBase) {
        action = 'add';
      } else if (changed) {
        action = 'update';
      } else {
        action = 'unchanged';
      }
    }

    changes.push({ code, action, entityLabel, base: b, local: l, remote: r });
  });
  return { changes, conflicts, entityConflicts, labelOf };
}

/* ------------------------------- 主入口 ------------------------------- */

export interface CreatePlanOptions {
  /** true：旧包缺底稿，已用本机当前记录补齐 */
  baselineMigrated?: boolean;
  now?: string;
}

export function createMergePlan(
  local: MergeDataset,
  base: MergeDataset,
  remote: MergeDataset,
  packageMeta: { packageCode: string; packageLabel: string; brigadeName: string; exportedAt: string; playCode: string },
  options: CreatePlanOptions = {},
): MergePlan {
  const conflicts: FieldConflict[] = [];
  const entityConflicts: EntityConflict[] = [];
  const warnings: MergeWarning[] = [];

  /* ----- 剧目（单例行） ----- */
  const pb = base.play;
  const pl = local.play;
  const pr = remote.play;
  let playChange: EntityChange<PackagePlay> | null = null;
  if (pb || pl || pr) {
    const code = (pr ?? pl ?? pb)?.playCode ?? packageMeta.playCode;
    const entityLabel = (pr ?? pl ?? pb)?.title ?? code;
    let action: ChangeAction;
    if (pb) {
      action = pl && pr ? 'unchanged' : 'delete';
    } else {
      action = pr ? 'add' : 'unchanged';
    }
    if (pl && pr) {
      const { conflicts: c, changed } = mergeFields({
        entity: 'play',
        code,
        entityLabel,
        fields: PLAY_FIELDS,
        base: pb,
        local: pl,
        remote: pr,
      });
      conflicts.push(...c);
      action = pb ? (changed ? 'update' : 'unchanged') : 'add';
    }
    playChange = { code, action, entityLabel, base: pb ?? null, local: pl ?? null, remote: pr ?? null };
  }

  /* ----- 场次 / 角色 / 锣鼓点 / 操耍人 ----- */
  const sceneMerge = mergeCollection({
    entity: 'scene',
    labelOf: (row) => sceneLabel(row),
    fields: SCENE_FIELDS,
    base: base.scenes,
    local: local.scenes,
    remote: remote.scenes,
    conflicts,
    entityConflicts,
    suppressDeletes: Boolean(options.baselineMigrated),
  });

  const roleMerge = mergeCollection({
    entity: 'role',
    labelOf: (row) => roleLabel(row),
    fields: ROLE_FIELDS,
    base: base.roles,
    local: local.roles,
    remote: remote.roles,
    conflicts,
    entityConflicts,
    suppressDeletes: Boolean(options.baselineMigrated),
  });

  const cueMerge = mergeCollection({
    entity: 'cue',
    labelOf: (row) => cueLabel(row),
    fields: CUE_FIELDS,
    base: base.cues,
    local: local.cues,
    remote: remote.cues,
    conflicts,
    entityConflicts,
    suppressDeletes: Boolean(options.baselineMigrated),
  });

  const operatorMerge = mergeCollection({
    entity: 'operator',
    labelOf: (row) => operatorLabel(row),
    fields: OPERATOR_FIELDS,
    base: base.operators,
    local: local.operators,
    remote: remote.operators,
    conflicts,
    entityConflicts,
    suppressDeletes: Boolean(options.baselineMigrated),
  });

  /* ----- 操耍人档期时段（嵌套集合，按 operatorCode/slotCode 三方） ----- */
  const slotChanges: SlotChange[] = [];
  const allOperatorCodes = new Set<string>([
    ...base.operators.keys(),
    ...local.operators.keys(),
    ...remote.operators.keys(),
  ]);
  allOperatorCodes.forEach((operatorCode) => {
    const ob = base.operators.get(operatorCode) ?? null;
    const ol = local.operators.get(operatorCode) ?? null;
    const or2 = remote.operators.get(operatorCode) ?? null;
    const operatorName = (ol ?? or2 ?? ob)?.name ?? operatorCode;
    const toSlotMap = (row: PackageOperator | null): Map<string, PackageSlot> =>
      new Map((row?.busySlots ?? []).map((slot) => [slot.slotCode, slot]));
    const mb = toSlotMap(ob);
    const ml = toSlotMap(ol);
    const mr = toSlotMap(or2);
    // 任一边操耍人已撤，档期不参与逐时段比对
    if (!ol && !or2) return;
    new Set<string>([...mb.keys(), ...ml.keys(), ...mr.keys()]).forEach((slotCode) => {
      const sb = mb.get(slotCode) ?? null;
      const sl = ml.get(slotCode) ?? null;
      const sr = mr.get(slotCode) ?? null;
      const inBase = sb !== null;
      const inLocal = sl !== null;
      const inRemote = sr !== null;
      let action: ChangeAction;
      if (inBase) {
        const del = options.baselineMigrated ? 'unchanged' : 'delete';
        action = inLocal && inRemote ? 'unchanged' : del;
      } else {
        action = inRemote ? 'add' : 'unchanged';
        if (inLocal && inRemote) action = 'add';
      }
      if (inLocal && inRemote) {
        const { conflicts: slotConflicts, changed } = mergeFields({
          entity: 'slot',
          code: `${operatorCode}/${slotCode}`,
          entityLabel: `${operatorName} · ${slotLabel(sl ?? sr)}`,
          fields: SLOT_FIELDS,
          base: sb,
          local: sl,
          remote: sr,
        });
        conflicts.push(...slotConflicts);
        action = inBase ? (changed ? 'update' : 'unchanged') : 'add';
      }
      slotChanges.push({ operatorCode, slotCode, action, base: sb, local: sl, remote: sr });
    });
  });

  /* ----- 级联：撤场次 → 该场角色指派与锣鼓点处理干净 ----- */
  // 最终撤掉的场次：remote 没有而 local 有（含底稿内），且去留冲突没有被选「保留」。
  // 迁移补齐的底稿无法证实「撤掉」，不产生删除与级联。
  const deletedSceneCodes = new Set<string>();
  if (!options.baselineMigrated) {
    sceneMerge.changes.forEach((change) => {
      if (change.action !== 'delete' && !(change.remote === null && change.local !== null)) return;
      const ec = entityConflicts.find((item) => item.entity === 'scene' && item.code === change.code);
      if (ec) return; // 去留待选 / 已另行决定，级联在落盘阶段按最终结果算
      if (change.local !== null && change.remote === null) deletedSceneCodes.add(change.code);
    });
  }

  deletedSceneCodes.forEach((sceneCode) => {
    const scene = local.scenes.get(sceneCode);
    const label = scene ? sceneLabel(scene) : sceneCode;
    local.roles.forEach((role) => {
      if (role.sceneCode !== sceneCode) return;
      warnings.push({
        id: `warn:cascade-role:${role.roleCode}`,
        level: 'warning',
        message: `场次「${label}」被撤，其影人角色「${role.name}」随场一并清理`,
      });
    });
    local.cues.forEach((cue) => {
      if (cue.sceneCode !== sceneCode) return;
      warnings.push({
        id: `warn:cascade-cue:${cue.cueCode}`,
        level: 'warning',
        message: `场次「${label}」被撤，锣鼓点「${cueLabel(cue)}」随场一并清理`,
      });
    });
  });

  /* ----- 级联：撤操耍人 → 角色指派 / 锣鼓点领奏解绑 ----- */
  const deletedOperatorCodes = new Set<string>();
  if (!options.baselineMigrated) {
    operatorMerge.changes.forEach((change) => {
      if (change.local !== null && change.remote === null) {
        const ec = entityConflicts.find((item) => item.entity === 'operator' && item.code === change.code);
        if (!ec) deletedOperatorCodes.add(change.code);
      }
    });
  }
  deletedOperatorCodes.forEach((operatorCode) => {
    const operator = local.operators.get(operatorCode);
    const name = operator ? operator.name : operatorCode;
    local.roles.forEach((role) => {
      if (role.operatorCode !== operatorCode) return;
      warnings.push({
        id: `warn:unbind-role:${role.roleCode}`,
        level: 'warning',
        message: `操耍人「${name}」被撤，角色「${role.name}」的指派已解绑（待重派）`,
      });
    });
    local.cues.forEach((cue) => {
      if (cue.leadOperatorCode !== operatorCode) return;
      warnings.push({
        id: `warn:unbind-cue:${cue.cueCode}`,
        level: 'warning',
        message: `操耍人「${name}」被撤，锣鼓点「${cueLabel(cue)}」的领奏已解绑（待重派）`,
      });
    });
  });

  if (options.baselineMigrated) {
    warnings.push({
      id: 'warn:baseline-migrated',
      level: 'info',
      message: '该包缺少上次交接底稿字段，已按本机当前记录迁移补齐后再合并（本机改动不会被误判为冲突）',
    });
  }

  return {
    packageCode: packageMeta.packageCode,
    playCode: packageMeta.playCode,
    packageLabel: packageMeta.packageLabel,
    brigadeName: packageMeta.brigadeName,
    exportedAt: packageMeta.exportedAt,
    baselineMigrated: Boolean(options.baselineMigrated),
    conflicts,
    entityConflicts,
    warnings,
    changes: {
      play: playChange,
      scenes: sceneMerge.changes,
      roles: roleMerge.changes,
      cues: cueMerge.changes,
      operators: operatorMerge.changes,
      slots: slotChanges,
    },
    generatedAt: options.now ?? new Date().toISOString(),
  };
}

/* --------------------------- 冲突选择与落盘数据 --------------------------- */

export function isPlanResolved(plan: MergePlan, resolutions: ResolutionMap): boolean {
  return (
    plan.conflicts.every((conflict) => resolutions[conflict.id] === 'local' || resolutions[conflict.id] === 'remote') &&
    plan.entityConflicts.every(
      (conflict) => resolutions[conflict.id] === 'keep' || resolutions[conflict.id] === 'delete',
    )
  );
}

export function unresolvedCount(plan: MergePlan, resolutions: ResolutionMap): number {
  const fields = plan.conflicts.filter(
    (conflict) => resolutions[conflict.id] !== 'local' && resolutions[conflict.id] !== 'remote',
  ).length;
  const entities = plan.entityConflicts.filter(
    (conflict) => resolutions[conflict.id] !== 'keep' && resolutions[conflict.id] !== 'delete',
  ).length;
  return fields + entities;
}

function chosenValue<T>(conflictId: string, b: T, l: T, r: T, resolutions: ResolutionMap): T {
  const picked = resolutions[conflictId];
  if (picked === 'local') return l;
  if (picked === 'remote') return r;
  return b; // 未选定不应走到这里（落盘前会拦截）
}

function mergeRowFields<TRow extends object>(args: {
  entity: MergeEntityKind;
  code: string;
  fields: Array<FieldSpec<TRow>>;
  base: TRow | null;
  local: TRow | null;
  remote: TRow | null;
  resolutions: ResolutionMap;
}): TRow {
  const { entity, code, fields, base, local, remote, resolutions } = args;
  // 以「存在的行」为骨架拷贝，再逐字段覆盖，保证新增行也有完整字段
  const result = { ...((local ?? remote ?? base) as TRow) } as Record<string, unknown> as TRow;
  const writer = result as unknown as Record<string, unknown>;
  fields.forEach((spec) => {
    const b = base ? base[spec.field] : undefined;
    const l = local ? local[spec.field] : undefined;
    const r = remote ? remote[spec.field] : undefined;
    const conflictId = `field:${entity}:${code}:${spec.field}`;
    if (resolutions[conflictId]) {
      writer[spec.field] = chosenValue(conflictId, b, l, r, resolutions);
      return;
    }
    const localChanged = !deepEqual(b, l);
    const remoteChanged = !deepEqual(b, r);
    if (remoteChanged && !localChanged) {
      writer[spec.field] = r;
    } else if (localChanged && !remoteChanged) {
      writer[spec.field] = l;
    } else if (localChanged && remoteChanged && deepEqual(l, r)) {
      writer[spec.field] = r;
    } else if (local !== null && !base) {
      writer[spec.field] = l;
    } else if (remote !== null) {
      writer[spec.field] = r;
    }
  });
  return result;
}

/** 去留判定：true = 撤掉。未决去留冲突落盘前会被拦截，这里不会走到 null 态 */
function shouldDeleteEntity(
  entity: Exclude<MergeEntityKind, 'play' | 'slot'>,
  code: string,
  action: ChangeAction,
  remoteExists: boolean,
  resolutions: ResolutionMap,
  suppressDeletes: boolean,
): boolean {
  const decision = resolutions[`entity:${entity}:${code}`];
  if (decision === 'delete') return !suppressDeletes; // 迁移基线下无法证实删除，忽略显式删除
  if (decision === 'keep') return false;
  if (suppressDeletes) return false;
  // 无去留冲突时：只有「底稿里有、分队那边撤掉」才撤；
  // 本机交接后自建、包没碰的行（不在底稿/分队）一律保留，不会被误删。
  return action === 'delete' && !remoteExists;
}

/**
 * 按选定结果算出合并后的最终数据集（业务编号键）。
 * 调用方必须先用 isPlanResolved 拦截未决冲突。
 *
 * 底稿缺失、按本机当前记录迁移补齐时（plan.baselineMigrated）：
 * 无法证明「分队撤掉了某行」，因此凡是包内没有的本机行一律保留，不做删除/级联，
 * 只吸收包内新增与可确认的字段改动。
 */
export function buildMergedDataset(plan: MergePlan, resolutions: ResolutionMap): MergeDataset {
  const result = emptyDataset();
  const suppressDeletes = plan.baselineMigrated;

  // 剧目（剧目整体被撤属于极端情形：直接进入空剧目库，仍保持幂等）
  const playChange = plan.changes.play;
  if (playChange && playChange.action !== 'delete' && (playChange.local || playChange.remote)) {
    result.play = mergeRowFields({
      entity: 'play',
      code: playChange.code,
      fields: PLAY_FIELDS,
      base: playChange.base,
      local: playChange.local,
      remote: playChange.remote,
      resolutions,
    });
  }

  const sceneKept = new Set<string>();
  // 场次「一边撤、一边改」时选了保留：随场级联删掉的子行（无自己的去留冲突）一并保留
  const cascadeKeptScenes = new Set<string>();
  plan.changes.scenes.forEach((change) => {
    const decision = resolutions[`entity:scene:${change.code}`];
    if (decision === 'keep') cascadeKeptScenes.add(change.code);
    if (shouldDeleteEntity('scene', change.code, change.action, change.remote !== null, resolutions, suppressDeletes)) return;
    if (!change.local && !change.remote) return;
    const row = mergeRowFields({
      entity: 'scene',
      code: change.code,
      fields: SCENE_FIELDS,
      base: change.base,
      local: change.local,
      remote: change.remote,
      resolutions,
    });
    result.scenes.set(change.code, row);
    sceneKept.add(change.code);
  });

  // 角色：先按自身去留，再按最终场次级联
  plan.changes.roles.forEach((change) => {
    const ownEntityDecision = resolutions[`entity:role:${change.code}`];
    const cascadedFromKeptScene =
      ownEntityDecision === undefined &&
      change.base !== null &&
      change.local !== null &&
      change.remote === null &&
      cascadeKeptScenes.has(change.base.sceneCode);
    if (!cascadedFromKeptScene) {
      if (shouldDeleteEntity('role', change.code, change.action, change.remote !== null, resolutions, suppressDeletes)) return;
    }
    if (!change.local && !change.remote) return;
    const row = mergeRowFields({
      entity: 'role',
      code: change.code,
      fields: ROLE_FIELDS,
      base: change.base,
      local: change.local,
      remote: change.remote,
      resolutions,
    });
    if (!sceneKept.has(row.sceneCode)) return; // 场次撤了，角色处理干净
    result.roles.set(change.code, row);
  });

  // 锣鼓点：同上
  plan.changes.cues.forEach((change) => {
    const ownEntityDecision = resolutions[`entity:cue:${change.code}`];
    const cascadedFromKeptScene =
      ownEntityDecision === undefined &&
      change.base !== null &&
      change.local !== null &&
      change.remote === null &&
      cascadeKeptScenes.has(change.base.sceneCode);
    if (!cascadedFromKeptScene) {
      if (shouldDeleteEntity('cue', change.code, change.action, change.remote !== null, resolutions, suppressDeletes)) return;
    }
    if (!change.local && !change.remote) return;
    const row = mergeRowFields({
      entity: 'cue',
      code: change.code,
      fields: CUE_FIELDS,
      base: change.base,
      local: change.local,
      remote: change.remote,
      resolutions,
    });
    if (!sceneKept.has(row.sceneCode)) return; // 场次撤了，锣鼓点处理干净
    result.cues.set(change.code, row);
  });

  // 操耍人 + 档期
  const keptOperatorCodes = new Set<string>();
  plan.changes.operators.forEach((change) => {
    if (shouldDeleteEntity('operator', change.code, change.action, change.remote !== null, resolutions, suppressDeletes)) return;
    if (!change.local && !change.remote) return;
    const row = mergeRowFields({
      entity: 'operator',
      code: change.code,
      fields: OPERATOR_FIELDS,
      base: change.base,
      local: change.local,
      remote: change.remote,
      resolutions,
    });
    // 档期逐时段合并（底稿在、分队撤掉的时段随之撤；本机新加的时段保留）
    const slots: PackageSlot[] = [];
    plan.changes.slots
      .filter((slotChange) => slotChange.operatorCode === change.code)
      .forEach((slotChange) => {
        if (!suppressDeletes && slotChange.base && !slotChange.remote) return;
        if (!slotChange.local && !slotChange.remote) return;
        const slotRow = mergeRowFields({
          entity: 'slot',
          code: `${change.code}/${slotChange.slotCode}`,
          fields: SLOT_FIELDS,
          base: slotChange.base,
          local: slotChange.local,
          remote: slotChange.remote,
          resolutions,
        });
        slots.push({ ...slotRow, slotCode: slotChange.slotCode });
      });
    row.busySlots = slots;
    result.operators.set(change.code, row);
    keptOperatorCodes.add(change.code);
  });

  // 操耍人撤掉 → 指派 / 领奏解绑干净
  result.roles.forEach((role) => {
    if (role.operatorCode !== null && !keptOperatorCodes.has(role.operatorCode)) {
      role.operatorCode = null;
    }
  });
  result.cues.forEach((cue) => {
    if (cue.leadOperatorCode !== null && !keptOperatorCodes.has(cue.leadOperatorCode)) {
      cue.leadOperatorCode = null;
    }
  });

  return result;
}

/* ------------------------------- 汇总统计 ------------------------------- */

export interface PlanStats {
  adds: number;
  updates: number;
  deletes: number;
  fieldConflicts: number;
  entityConflicts: number;
}

export function planStats(plan: MergePlan): PlanStats {
  const count = <T>(rows: Array<EntityChange<T>>): { add: number; upd: number; del: number } =>
    rows.reduce(
      (acc, row) => {
        if (row.action === 'add') acc.add += 1;
        if (row.action === 'update') acc.upd += 1;
        if (row.action === 'delete') acc.del += 1;
        return acc;
      },
      { add: 0, upd: 0, del: 0 },
    );
  const groups = [
    count(plan.changes.scenes),
    count(plan.changes.roles),
    count(plan.changes.cues),
    count(plan.changes.operators),
  ];
  const slotAdds = plan.changes.slots.filter((slot) => slot.action === 'add').length;
  const slotDels = plan.changes.slots.filter((slot) => slot.action === 'delete').length;
  return {
    adds: groups.reduce((acc, item) => acc + item.add, 0) + slotAdds + (plan.changes.play?.action === 'add' ? 1 : 0),
    updates:
      groups.reduce((acc, item) => acc + item.upd, 0) + (plan.changes.play?.action === 'update' ? 1 : 0),
    deletes:
      groups.reduce((acc, item) => acc + item.del, 0) + slotDels + (plan.changes.play?.action === 'delete' ? 1 : 0),
    fieldConflicts: plan.conflicts.length,
    entityConflicts: plan.entityConflicts.length,
  };
}
