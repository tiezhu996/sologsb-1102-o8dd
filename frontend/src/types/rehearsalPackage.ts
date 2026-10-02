/**
 * 离线排演包（RehearsalPackage）与合并会话的数据结构
 * 分队离线前从班社机器「打包」：内含上次交接底稿 + 这次改动；
 * 回班社后按剧目 / 场次 / 影人角色 / 操耍人业务编号认关系合并。
 */
import type { Play } from './play';
import type { Scene } from './scene';
import type { ShadowRole } from './role';
import type { Operator } from './operator';
import type { PercussionCue } from './cue';

/** 交接底稿（三向合并里的 base）：一次剧目快照，子项用业务编号外键跨机认关系 */
export interface HandoverScene extends Scene {
  /** 冗余的剧目业务编号，便于脱离 uuid 认归属 */
  playBizCode?: string;
}
export interface HandoverRole extends ShadowRole {
  sceneBizCode?: string;
  operatorBizCode?: string | null;
}
export interface HandoverCue extends PercussionCue {
  sceneBizCode?: string;
  leadOperatorBizCode?: string | null;
}

export interface HandoverBaseline {
  play: Play;
  scenes: HandoverScene[];
  roles: HandoverRole[];
  cues: HandoverCue[];
  operators: Operator[];
}

/** 排演包文件格式（导给分队、再带回班社合并） */
export interface RehearsalPackage {
  /** 文件标识，固定常量，解析时校验 */
  kind: 'gbshadowplay-rehearsal-package';
  /** 格式版本 */
  packageVersion: number;
  /** 包 id：同一包反复重试据此找回已核对进度，绝不重复追加 */
  packageId: string;
  /** 打包的分队名（如「东路队」） */
  detachmentName: string;
  createdAt: string;
  /** 目标剧目业务编号 */
  playBizCode: string;
  /** 上次交接底稿；旧数据缺底稿时由合并方按当前记录迁移补齐 */
  baseline: HandoverBaseline | null;
  /** 分队这次改动后的当前记录 */
  current: HandoverBaseline;
}

/** 合并明细行类型 */
export type MergeEntityKind = 'play' | 'scene' | 'role' | 'cue' | 'operator';

/** 冲突形态 */
export type ConflictKind =
  /** 同一标量字段两边都改了 */
  | 'field'
  /** 同一数组型字段两边都增删了（影件 / 技能 / 时段） */
  | 'array'
  /** 一方删除、另一方修改 */
  | 'deleteModify';

/** 字段冲突的候选取值来源 */
export type FieldSide = 'local' | 'remote';
/** 数组冲突的保留策略 */
export type ArrayPolicy = 'local' | 'remote' | 'union';
/** 删除/修改冲突的处置方式 */
export type DeletePolicy = 'delete' | 'keep';

/** 标量字段冲突 */
export interface FieldConflict {
  conflictKind: 'field';
  field: string;
  fieldLabel: string;
  baseValue: unknown;
  localValue: unknown;
  remoteValue: unknown;
  resolution: FieldSide | null;
}

/** 数组字段冲突（影件 / 技能标签 / 冲突时段） */
export interface ArrayConflict {
  conflictKind: 'array';
  field: string;
  fieldLabel: string;
  baseItems: Array<{ code: string; label: string }>;
  localAdded: Array<{ code: string; label: string }>;
  localRemoved: Array<{ code: string; label: string }>;
  remoteAdded: Array<{ code: string; label: string }>;
  remoteRemoved: Array<{ code: string; label: string }>;
  resolution: ArrayPolicy | null;
}

/** 删除 / 修改冲突 */
export interface DeleteModifyConflict {
  conflictKind: 'deleteModify';
  /** 哪边删的 */
  deletedBy: 'local' | 'remote';
  /** 另一边改动后的展示摘要 */
  modifiedSummary: string;
  resolution: DeletePolicy | null;
}

export type Conflict = FieldConflict | ArrayConflict | DeleteModifyConflict;

/** 一个实体在合并中的状态行 */
export interface MergeEntry {
  kind: MergeEntityKind;
  /** 业务编号 */
  bizCode: string;
  /** 展示名（剧目名 / 场次标题 / 角色名 / 锣鼓点名 / 操耍人名） */
  label: string;
  /** 合并结论 */
  status: 'unchanged' | 'localOnly' | 'remoteOnly' | 'modified' | 'deleted' | 'conflict';
  /** 无冲突时的差异摘要（如「时长 14 → 18 分钟」） */
  diffs: string[];
  conflicts: Conflict[];
}

/** 合并前预检发现的问题（阻断提交） */
export interface MergeWarning {
  level: 'error' | 'warning';
  message: string;
}

/** 合并提交结果统计 */
export interface MergeOutcome {
  playId: string;
  playsChanged: number;
  scenesAdded: number;
  scenesDeleted: number;
  scenesChanged: number;
  rolesAdded: number;
  rolesDeleted: number;
  rolesChanged: number;
  cuesAdded: number;
  cuesDeleted: number;
  cuesChanged: number;
  operatorsAdded: number;
  operatorsChanged: number;
  conflictsResolved: number;
  cascadedRoles: number;
  cascadedCues: number;
  unboundRoles: number;
  unboundCues: number;
}

/** 落库的合并会话（失败重试时保留整包与已核对进度） */
export interface MergeSessionRecord {
  /** 主键 = packageId，重试同一包直接找回 */
  id: string;
  status: 'pending' | 'committed' | 'abandoned';
  createdAt: string;
  updatedAt: string;
  detachmentName: string;
  playBizCode: string;
  /** 原始排演包整包保留 */
  pkg: RehearsalPackage;
  /** 各冲突的核对进度：key = `${kind}:${bizCode}:${conflictIndex}`，value = 选定结果 */
  resolutions: Record<string, FieldSide | ArrayPolicy | DeletePolicy>;
  lastSummary: {
    total: number;
    conflicts: number;
  } | null;
}
